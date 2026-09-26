const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { optionalAuth, requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const bookingSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email(),
  course: z.string().min(1), // matches the <select name="course"> in Book.tsx
  instructor: z.string().optional().nullable(),
  date: z.string().min(1), // matches <input name="date" type="date">
  time: z.string().min(1),
});

// POST /api/bookings - Book.tsx "Request booking"
router.post('/', optionalAuth, async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input.', details: parsed.error.flatten() });
  }
  const { name, phone, email, course, instructor, date, time } = parsed.data;

  const courseRow = await db.prepare('SELECT id FROM courses WHERE id = ?').get(course);
  if (!courseRow) return res.status(400).json({ error: 'Unknown course.' });

  if (instructor) {
    const instructorRow = await db.prepare('SELECT id FROM instructors WHERE id = ?').get(instructor);
    if (!instructorRow) return res.status(400).json({ error: 'Unknown instructor.' });
  }

  const info = await db
    .prepare(
      `INSERT INTO bookings (user_id, name, phone, email, course_id, instructor_id, preferred_date, preferred_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(req.user?.id || null, name, phone, email, course, instructor || null, date, time);

  const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ booking });
});

// GET /api/bookings/me - a student's own booking requests
router.get('/me', requireAuth, async (req, res) => {
  const rows = await db
    .prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ bookings: rows });
});

// GET /api/bookings - admin: all booking requests
router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
  res.json({ bookings: rows });
});

// PATCH /api/bookings/:id/status - admin: confirm/cancel/complete a booking
router.patch('/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['pending', 'confirmed', 'cancelled', 'completed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  }
  const result = await db
    .prepare(`UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Booking not found.' });
  const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  res.json({ booking });
});

module.exports = router;
