// Smart Parking System - ESP32 (talks to the Render website)
// Libraries: ArduinoJson, Keypad, ESP32Servo, Adafruit GFX Library, Adafruit SSD1306
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const char* WIFI_SSID  = "YOUR_WIFI_NAME";
const char* WIFI_PASS  = "YOUR_WIFI_PASSWORD";
const char* SERVER     = "https://YOUR-APP.onrender.com";   // no slash at the end
const char* DEVICE_KEY = "SAME_AS_DEVICE_KEY_ON_RENDER";

// Ultrasonic sensors (TRIG, ECHO) for bays 1-4
const int TRIG[4] = {12, 14, 27, 33};
const int ECHO[4] = {13, 26, 25, 32};
const int OCCUPIED_CM = 10;

// Two boom gates. Entry servo moved from GPIO 18 to GPIO 15 (GPIO 18 is a keypad row)
const int ENTRY_SERVO_PIN = 15, EXIT_SERVO_PIN = 2, GATE_CLOSED = 0, GATE_OPEN = 90;
Servo entryGate, exitGate;

// Keypad
const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
byte rowPins[ROWS] = {19, 23, 18, 5};
byte colPins[COLS] = {17, 16, 4, 0};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

// OLED SSD1306 128x64 I2C: VCC 3.3V, GND, SCL = GPIO 22, SDA = GPIO 21
Adafruit_SSD1306 oled(128, 64, &Wire, -1);

String pin = "";
int freeBays = -1;
unsigned long lastSync = 0, msgUntil = 0;

void screen(const String& l1, const String& l2 = "", const String& l3 = "") {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1); oled.setCursor(0, 0);  oled.println("SMART PARKING");
  oled.drawLine(0, 10, 127, 10, SSD1306_WHITE);
  oled.setTextSize(2); oled.setCursor(0, 16); oled.println(l1);
  oled.setTextSize(1); oled.setCursor(0, 42); oled.println(l2);
  oled.setCursor(0, 54); oled.println(l3);
  oled.display();
}
void home() {
  String stars = ""; for (unsigned i = 0; i < pin.length(); i++) stars += '*';
  screen(freeBays < 0 ? "Connecting" : (freeBays == 0 ? "FULL" : String(freeBays) + " free"),
         "Enter PIN then #", stars);
}
void notice(const String& a, const String& b, unsigned long ms) { screen(a, b); msgUntil = millis() + ms; }

long readCm(int i) {
  digitalWrite(TRIG[i], LOW); delayMicroseconds(2);
  digitalWrite(TRIG[i], HIGH); delayMicroseconds(10); digitalWrite(TRIG[i], LOW);
  long d = pulseIn(ECHO[i], HIGH, 30000);
  return d == 0 ? 999 : d / 58;
}
bool postJson(const char* path, const String& body, JsonDocument& out) {
  WiFiClientSecure client; client.setInsecure();      // simple HTTPS for a prototype
  HTTPClient http; http.setTimeout(15000);
  if (!http.begin(client, String(SERVER) + path)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);
  int code = http.POST(body);
  bool ok = code == 200 && !deserializeJson(out, http.getString());
  http.end();
  return ok;
}
void openGate(Servo& g) {
  g.write(GATE_OPEN); delay(4000); g.write(GATE_CLOSED);
}
void syncBays() {
  JsonDocument req, res;
  JsonArray a = req["bays"].to<JsonArray>();
  for (int i = 0; i < 4; i++) { a.add(readCm(i) <= OCCUPIED_CM); delay(30); }
  String body; serializeJson(req, body);
  if (postJson("/api/device/sync", body, res)) {
    freeBays = res["free"] | 0;
    String cmd = String((const char*)(res["gate"] | ""));
    if (cmd == "entry") { notice("Entry gate", "Opening (manager)", 1000); openGate(entryGate); }
    if (cmd == "exit")  { notice("Exit gate", "Opening (manager)", 1000); openGate(exitGate); }
  } else freeBays = -1;
}
void submitPin() {
  JsonDocument req, res; req["pin"] = pin;
  String body; serializeJson(req, body);
  screen("Checking...");
  if (postJson("/api/device/verify", body, res) && res["ok"]) {
    if (String((const char*)res["action"]) == "exit") {
      notice("Pay R" + String((float)res["fee"], 2), "Thank you!", 4000);
      openGate(exitGate);
    } else {
      notice("Welcome", "Go to Bay " + String((int)res["bay"]), 4000);
      openGate(entryGate);
    }
  } else notice("Wrong PIN", "Try again", 2500);
  pin = "";
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  for (int i = 0; i < 4; i++) { pinMode(TRIG[i], OUTPUT); pinMode(ECHO[i], INPUT); }
  entryGate.setPeriodHertz(50); entryGate.attach(ENTRY_SERVO_PIN, 500, 2400); entryGate.write(GATE_CLOSED);
  exitGate.setPeriodHertz(50);  exitGate.attach(EXIT_SERVO_PIN, 500, 2400);   exitGate.write(GATE_CLOSED);
  screen("WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(300);
  Serial.println("Wi-Fi Connected!");
  syncBays(); home();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); delay(500); return; }
  char k = keypad.getKey();
  if (k) {
    if (k == '*') pin = "";
    else if (k == '#') { if (pin.length() == 4) submitPin(); else { notice("Need 4", "digits", 1500); pin = ""; } }
    else if (k >= '0' && k <= '9' && pin.length() < 4) pin += k;
    if (millis() > msgUntil) home();
  }
  if (millis() - lastSync > 3000) { lastSync = millis(); syncBays(); if (millis() > msgUntil) home(); }
  if (msgUntil && millis() > msgUntil) { msgUntil = 0; home(); }
}
