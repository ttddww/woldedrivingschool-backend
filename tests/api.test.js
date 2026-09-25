const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbFile = path.join(os.tmpdir(), `wds-test-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbFile;
process.env.JWT_SECRET = 'test-jwt-secret-value-not-for-prod';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.EMAIL_PROVIDER = 'log';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminTestPass1!';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const request = require('supertest');
const app = require('../src/app');
require('../src/db/seed');

const Stripe = require('stripe');

let studentToken;
let adminToken;
let programId;
let slotId;

before(() => {
  assert.ok(fs.existsSync(dbFile) || true);
});

test('health check', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('lists seeded programs with database prices', async () => {
  const res = await request(app).get('/api/programs');
  assert.equal(res.status, 200);
  assert.equal(res.body.programs.length, 3);
  const online = res.body.programs.find((p) => p.slug === 'online-classroom');
  assert.equal(online.priceCents, 20000);
  programId = online.id;
});

test('registration validation errors', async () => {
  const res = await request(app).post('/api/auth/register').send({ email: 'bad' });
  assert.equal(res.status, 400);
});

test('register and login student', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      firstName: 'Ada',
      lastName: 'Student',
      email: 'ada@example.com',
      phone: '7035550100',
      password: 'StudentPass1',
      programId,
    });
  assert.equal(res.status, 201, res.body.error);
  assert.ok(res.body.token);
  assert.equal(res.body.user.role, 'STUDENT');
  assert.ok(!res.body.user.passwordHash);

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'ada@example.com', password: 'StudentPass1' });
  assert.equal(login.status, 200);
  studentToken = login.body.token;
});

test('rejects wrong password', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'ada@example.com', password: 'wrong-password' });
  assert.equal(res.status, 401);
});

test('forgot password does not reveal accounts', async () => {
  const a = await request(app).post('/api/auth/forgot-password').send({ email: 'ada@example.com' });
  const b = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.message, b.body.message);
});

test('student cannot access admin overview', async () => {
  const res = await request(app)
    .get('/api/admin/overview')
    .set('Authorization', `Bearer ${studentToken}`);
  assert.equal(res.status, 403);
});

test('admin login and student list', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@test.local', password: 'AdminTestPass1!' });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.user.role, 'ADMIN');
  adminToken = res.body.token;

  const students = await request(app)
    .get('/api/admin/students')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(students.status, 200);
  assert.ok(students.body.students.length >= 1);
});

test('appointment booking and double-booking prevention', async () => {
  const slots = await request(app).get('/api/appointments/availability');
  assert.equal(slots.status, 200);
  assert.ok(slots.body.slots.length > 0);
  slotId = slots.body.slots[0].id;

  const first = await request(app)
    .post('/api/appointments')
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ programId, slotId, notes: 'First booking' });
  assert.equal(first.status, 201, first.body.error);

  const second = await request(app)
    .post('/api/appointments')
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ programId, slotId });
  assert.equal(second.status, 409);
});

test('contact form stores inquiries', async () => {
  const res = await request(app).post('/api/contact').send({
    name: 'Parent',
    email: 'parent@example.com',
    phone: '7035550199',
    subject: 'Question about teen lessons',
    message: 'Hello, I would like more information about teen driver education.',
  });
  assert.equal(res.status, 201, res.body.error);

  const list = await request(app)
    .get('/api/contact')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.messages.length >= 1);
});

test('checkout without Stripe config returns 503', async () => {
  const res = await request(app)
    .post('/api/payments/checkout')
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ programId });
  assert.equal(res.status, 503);
});

test('Stripe webhook rejects invalid signatures', async () => {
  const res = await request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'invalid')
    .send(JSON.stringify({ type: 'checkout.session.completed' }));
  assert.equal(res.status, 400);
});

test('Stripe webhook accepts a signed payload', async () => {
  const payload = JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_test_missing', metadata: {} } },
  });
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_test_secret',
  });
  const res = await request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', header)
    .send(payload);
  assert.equal(res.status, 200, res.body.error);
});

test('cleanup db file', () => {
  try {
    fs.unlinkSync(dbFile);
    fs.unlinkSync(`${dbFile}-wal`);
    fs.unlinkSync(`${dbFile}-shm`);
  } catch {
    // ignore
  }
});
