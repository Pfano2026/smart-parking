const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ADMIN_USER, ADMIN_PASS, DEVICE_KEY, BREVO_API_KEY, SENDER_EMAIL } = process.env;
const HOLD_MIN = 30; // minutes a PIN stays valid

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'parking.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const setting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k).value;
const setSetting = (k, v) => db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(v), k);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const expire = () => db.prepare("UPDATE bookings SET status='expired' WHERE status='active' AND expires_at<?").run(Date.now());
const feeFor = (start, end, rate) => Math.max(1, Math.ceil((end - start) / 3.6e6)) * rate;

function bayList() {
  const held = db.prepare("SELECT bay FROM bookings WHERE status IN ('active','used')").all().map(r => r.bay);
  return db.prepare('SELECT id, occupied FROM bays ORDER BY id').all()
    .map(b => ({ id: b.id, free: !b.occupied && !held.includes(b.id) }));
}

async function sendPin(to, name, bay, pin) {
  if (!BREVO_API_KEY || !SENDER_EMAIL) { console.log(`[DEV] PIN for ${to}: ${pin} (Bay ${bay})`); return; }
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Smart Parking', email: SENDER_EMAIL },
      to: [{ email: to }],
      subject: 'Your Smart Parking PIN',
      htmlContent: `<p>Hi ${esc(name)},</p><p>Your booking for <b>Bay ${bay}</b> is confirmed.</p>
        <p style="font-size:28px;letter-spacing:6px"><b>${pin}</b></p>
        <p>Enter this PIN on the keypad at the entrance and press #. It is valid for ${HOLD_MIN} minutes. Do not share it.</p>`
    })
  });
  if (!r.ok) throw new Error('email failed: ' + r.status + ' ' + await r.text());
}

// simple per-IP limit: 5 bookings per 10 minutes
const hits = new Map();
const limit = (req, res, next) => {
  const now = Date.now(), list = (hits.get(req.ip) || []).filter(t => now - t < 6e5);
  if (list.length >= 5) return res.status(429).json({ error: 'Too many bookings. Try again later.' });
  list.push(now); hits.set(req.ip, list); next();
};

// ---------- customer ----------
app.get('/api/bays', (req, res) => {
  expire();
  res.json({ open: setting('booking_open') === '1', rate: +setting('rate'), bays: bayList() });
});

app.post('/api/book', limit, async (req, res) => {
  expire();
  if (setting('booking_open') !== '1') return res.status(403).json({ error: 'Booking is closed by management.' });
  const { bay, name, email, phone, plate } = req.body || {};
  const n = String(name || '').trim(), e = String(email || '').trim().toLowerCase();
  const p = String(phone || '').replace(/[\s-]/g, ''), pl = String(plate || '').trim().toUpperCase();
  if (n.length < 2 || n.length > 60) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!/^\+?\d{7,15}$/.test(p)) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (pl.length < 2 || pl.length > 12) return res.status(400).json({ error: 'Enter your number plate.' });
  const b = bayList().find(x => x.id === +bay);
  if (!b || !b.free) return res.status(409).json({ error: 'That bay is no longer available.' });

  let pin, hash;
  do { pin = String(crypto.randomInt(1000, 10000)); hash = sha(pin); }
  while (db.prepare("SELECT 1 FROM bookings WHERE pin_hash=? AND status IN ('active','used')").get(hash));

  const token = crypto.randomBytes(16).toString('hex'), now = Date.now();
  const id = db.prepare(`INSERT INTO bookings (bay,name,email,phone,plate,pin_hash,token,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(b.id, n, e, p, pl, hash, token, now, now + HOLD_MIN * 6e4).lastInsertRowid;
  try { await sendPin(e, n, b.id, pin); }
  catch (err) {
    console.error(err.message);
    db.prepare('DELETE FROM bookings WHERE id=?').run(id);
    return res.status(502).json({ error: 'Could not send the email. Check the address and try again.' });
  }
  res.json({ id, token, bay: b.id, email: e, holdMinutes: HOLD_MIN });
});

app.get('/api/booking/:id', (req, res) => {
  expire();
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND token=?').get(req.params.id, String(req.query.token || ''));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const rate = +setting('rate');
  const end = b.ended_at || Date.now();
  res.json({ status: b.status, bay: b.bay, enteredAt: b.entered_at, expiresAt: b.expires_at, rate,
    fee: b.entered_at ? (b.fee ?? feeFor(b.entered_at, end, b.rate || rate)) : 0 });
});

app.post('/api/booking/:id/cancel', (req, res) => {
  const r = db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND token=? AND status='active'")
    .run(req.params.id, String((req.body || {}).token || ''));
  res.json({ ok: r.changes === 1 });
});

// ---------- ESP32 ----------
const dev = (req, res, next) =>
  DEVICE_KEY && req.get('x-device-key') === DEVICE_KEY ? next() : res.status(401).json({ error: 'bad key' });

app.post('/api/device/sync', dev, (req, res) => {
  expire();
  const occ = (req.body.bays || []).slice(0, 4);
  occ.forEach((o, i) =>
    db.prepare('UPDATE bays SET occupied=?, updated=? WHERE id=?').run(o ? 1 : 0, Date.now(), i + 1));
  const gate = setting('gate_cmd');
  if (gate) setSetting('gate_cmd', '');
  res.json({ gate, free: bayList().filter(b => b.free).length });
});

app.post('/api/device/verify', dev, (req, res) => {
  expire();
  const pin = String((req.body || {}).pin || '');
  const b = db.prepare("SELECT * FROM bookings WHERE pin_hash=? AND status IN ('active','used')").get(sha(pin));
  if (!b) return res.json({ ok: false });
  if (b.status === 'active') {                       // ENTRY
    db.prepare("UPDATE bookings SET status='used', entered_at=?, rate=? WHERE id=?").run(Date.now(), +setting('rate'), b.id);
    return res.json({ ok: true, action: 'enter', bay: b.bay });
  }
  const t = Date.now(), fee = feeFor(b.entered_at, t, b.rate);   // EXIT
  db.prepare("UPDATE bookings SET status='done', ended_at=?, fee=? WHERE id=?").run(t, fee, b.id);
  res.json({ ok: true, action: 'exit', bay: b.bay, fee });
});

// ---------- management ----------
const sessions = new Set();
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!ADMIN_USER || !ADMIN_PASS || sha(String(username)) !== sha(ADMIN_USER) || sha(String(password)) !== sha(ADMIN_PASS))
    return res.status(401).json({ error: 'Invalid Username or Password' });
  const t = crypto.randomBytes(24).toString('hex'); sessions.add(t); res.json({ token: t });
});
const admin = (req, res, next) => sessions.has(req.get('x-token')) ? next() : res.status(401).json({ error: 'Login required' });

app.get('/api/admin/state', admin, (req, res) => {
  expire();
  const rows = db.prepare(`SELECT id,bay,name,email,phone,plate,status,created_at,entered_at,ended_at,fee
    FROM bookings ORDER BY id DESC LIMIT 200`).all();
  const revenue = rows.reduce((s, r) => s + (r.fee || 0), 0);
  res.json({ open: setting('booking_open') === '1', rate: +setting('rate'), revenue, bookings: rows });
});
app.post('/api/admin/booking-open', admin, (req, res) => { setSetting('booking_open', req.body.open ? 1 : 0); res.json({ ok: true }); });
app.post('/api/admin/rate', admin, (req, res) => {
  const r = Math.round(+req.body.rate);
  if (!(r > 0 && r < 10000)) return res.status(400).json({ error: 'Invalid rate' });
  setSetting('rate', r); res.json({ ok: true });
});
app.post('/api/admin/gate', admin, (req, res) => {
  const g = req.body.gate === 'exit' ? 'exit' : 'entry';
  setSetting('gate_cmd', g); res.json({ ok: true });
});
app.get('/api/admin/export', admin, (req, res) => {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = db.prepare('SELECT * FROM bookings ORDER BY id').all();
  const head = ['id', 'bay', 'name', 'email', 'phone', 'plate', 'status', 'created_at', 'entered_at', 'ended_at', 'fee'];
  const iso = t => t ? new Date(t).toISOString() : '';
  const csv = [head.join(',')].concat(rows.map(r => head.map(h => q(h.endsWith('_at') ? iso(r[h]) : r[h])).join(','))).join('\n');
  res.type('text/csv').send(csv);
});

app.listen(process.env.PORT || 3000, () => console.log('Smart Parking running'));
