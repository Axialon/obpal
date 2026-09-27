/*
  ob.Pal arm: the reference sketch for the ob.Pal serial protocol (CATALOGUE §7, system.robot-arm).
  Six hobby servos (base, shoulder, elbow, wrist, roll, gripper) on an Arduino Uno, Nano or any board with the Servo
  library. The robot arm page (obpal.blackboxes.net/sim/arm/) drives it over USB with Web Serial.

  Lines at 115200 baud, each ending in a newline:
    J a b c d e g   aim the joints: five angles in degrees (the sim's angles) and the gripper, 0 closed to 1 open
    ?               answer "P a b c d e g" with where the joints are now
    S               stop: hold where the joints are
    T0 / T1         let go of the servos (limp) / hold them again
  On start it prints "obpal-arm 1 joints=6".

  The page runs the safety envelope (deadman, limits, speed caps, 200 ms watchdog, e-stop). This sketch keeps a
  second line of its own: joint limits, a speed cap per joint, and a hold when commands stop for half a second.
  Hobby servos can't report where they are, so "P" is where this sketch last put them.

  Calibrate below: CENTER_US is the pulse that puts each joint at the sim's 0 degrees, US_PER_DEG its pulse per
  degree (about 11 for a 180 degree servo), DIR which way it turns. MIT licence, as ob.Pal.
*/
#include <Servo.h>

const uint8_t N = 6;
const uint8_t PIN[N] = {3, 5, 6, 9, 10, 11};
const float CENTER_US[5] = {1500, 1500, 1500, 1500, 1500};
const float US_PER_DEG[5] = {11.1, 11.1, 11.1, 11.1, 11.1};
const int8_t DIR[5] = {1, 1, 1, 1, 1};
const float GRIP_CLOSED_US = 1100, GRIP_OPEN_US = 1900;
// The sim's joint limits (degrees; the gripper 0..1), its home pose and speed caps per second.
const float MIN_V[N] = {-170, -80, -135, -115, -180, 0};
const float MAX_V[N] = {170, 95, 140, 115, 180, 1};
const float HOME[N] = {0, 18, 72, 62, 0, 1};
const float VMAX[N] = {70, 55, 70, 90, 120, 1.4};
const unsigned long WATCHDOG_MS = 500;

Servo servo[N];
float now_v[N], goal_v[N];
bool attached = false;
unsigned long lastCommand = 0, lastStep = 0;
char line[96];
uint8_t len = 0;

float clampJoint(uint8_t j, float v) { return v < MIN_V[j] ? MIN_V[j] : v > MAX_V[j] ? MAX_V[j] : v; }

int pulse(uint8_t j, float v) {
  float us = j < 5 ? CENTER_US[j] + DIR[j] * v * US_PER_DEG[j] : GRIP_CLOSED_US + v * (GRIP_OPEN_US - GRIP_CLOSED_US);
  return (int)constrain(us, 500, 2500);
}

void attachAll(bool on) {
  for (uint8_t j = 0; j < N; j++) {
    if (on) { servo[j].writeMicroseconds(pulse(j, now_v[j])); servo[j].attach(PIN[j]); }
    else servo[j].detach();
  }
  attached = on;
}

void hold() { for (uint8_t j = 0; j < N; j++) goal_v[j] = now_v[j]; }

void report() {
  Serial.print('P');
  for (uint8_t j = 0; j < N; j++) { Serial.print(' '); Serial.print(now_v[j], j < 5 ? 1 : 2); }
  Serial.println();
}

void handle(char *s) {
  if (s[0] == 'J') {
    float v[N];
    char *p = s + 1;
    for (uint8_t j = 0; j < N; j++) {
      char *end;
      v[j] = strtod(p, &end);
      if (end == p) return; // a short line: ignore it
      p = end;
    }
    for (uint8_t j = 0; j < N; j++) goal_v[j] = clampJoint(j, v[j]);
    lastCommand = millis();
  } else if (s[0] == '?') report();
  else if (s[0] == 'S') hold();
  else if (s[0] == 'T') { hold(); attachAll(s[1] == '1'); }
}

void setup() {
  Serial.begin(115200);
  for (uint8_t j = 0; j < N; j++) now_v[j] = goal_v[j] = HOME[j];
  attachAll(true);
  lastStep = millis();
  Serial.println(F("obpal-arm 1 joints=6"));
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') { if (len) { line[len] = 0; handle(line); len = 0; } }
    else if (len < sizeof(line) - 1) line[len++] = c;
    else len = 0; // too long: drop it
  }
  unsigned long t = millis();
  if (t - lastStep < 10) return;
  float dt = (t - lastStep) / 1000.0;
  lastStep = t;
  // Commands stopped: hold where the joints are.
  if (lastCommand && t - lastCommand > WATCHDOG_MS) { hold(); lastCommand = 0; }
  for (uint8_t j = 0; j < N; j++) {
    float step = VMAX[j] * dt, e = goal_v[j] - now_v[j];
    now_v[j] += e > step ? step : e < -step ? -step : e;
    if (attached) servo[j].writeMicroseconds(pulse(j, now_v[j]));
  }
}
