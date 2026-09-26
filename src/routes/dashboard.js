const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/http');
const { mapProgram } = require('../services/helpers');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const profile = await db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
  const program = profile?.program_id
    ? await db.prepare('SELECT * FROM programs WHERE id = ?').get(profile.program_id)
    : null;
  const appointments = await db
    .prepare(
      `SELECT a.*, s.starts_at, s.ends_at, p.name AS program_name
       FROM appointments a
       JOIN availability_slots s ON s.id = a.slot_id
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ?
       ORDER BY s.starts_at DESC`,
    )
    .all(req.user.id);
  const payments = await db
    .prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  const notifications = await db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user.id);

  const now = new Date().toISOString();
  const upcoming = appointments.filter((a) => a.starts_at >= now && a.status !== 'cancelled');
  const past = appointments.filter((a) => a.starts_at < now || a.status === 'completed');
  const paid = payments.some((p) => p.status === 'paid');

  return ok(res, {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: Boolean(user.is_active),
      firstName: profile?.first_name,
      lastName: profile?.last_name,
      phone: profile?.phone,
      programId: profile?.program_id,
      program: program ? mapProgram(program) : null,
    },
    cards: {
      upcomingLesson: upcoming[upcoming.length - 1] || upcoming[0] || null,
      program: program ? mapProgram(program) : null,
      paymentStatus: paid ? 'paid' : payments.length ? payments[0].status : 'unpaid',
      accountStatus: user.is_active ? 'active' : 'inactive',
    },
    appointments,
    upcoming,
    past,
    payments,
    notifications,
  });
});

router.patch('/notifications/:id/read', async (req, res) => {
  const result = await db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (result.changes === 0) return fail(res, 404, 'Notification not found.');
  return ok(res, { updated: true });
});

router.post('/notifications/read-all', async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  return ok(res, { updated: true });
});

module.exports = router;
