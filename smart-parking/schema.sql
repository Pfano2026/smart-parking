CREATE TABLE IF NOT EXISTS bays (
  id INTEGER PRIMARY KEY,
  occupied INTEGER NOT NULL DEFAULT 0,
  updated INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bay INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  plate TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | used | done | cancelled | expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  entered_at INTEGER,
  ended_at INTEGER,
  rate INTEGER,
  fee REAL
);
INSERT OR IGNORE INTO bays (id) VALUES (1),(2),(3),(4);
INSERT OR IGNORE INTO settings (key,value) VALUES ('rate','20'),('booking_open','1'),('gate_cmd','');
