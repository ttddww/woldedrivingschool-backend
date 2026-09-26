const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, fail } = require('../utils/http');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  const from = req.query.from || new Date().toISOString();
  const to = req.query.to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString();
  const slots = await db
    .prepare('SELECT * FROM availability_slots WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at')
    .all(from, to);
  const blockedDates = await db.prepare('SELECT * FROM blocked_dates ORDER BY blocked_date').all();
  return ok(res, { slots, blockedDates });
});

router.post(
  '/',
  validate(
    z.object({
      startsAt: z.string().min(1),
      endsAt: z.string().min(1),
      notes: z.string().max(500).optional().nullable(),
    }),
  ),
  async (req, res) => {
    const { startsAt, endsAt, notes } = req.validated;
    if (new Date(endsAt) <= new Date(startsAt)) return fail(res, 400, 'End time must be after start time.');
    const overlap = await db
      .prepare(
        `SELECT id FROM availability_slots
         WHERE is_blocked = 0 AND starts_at < ? AND ends_at > ?`,
      )
      .get(endsAt, startsAt);
    if (overlap) return fail(res, 409, 'That time overlaps an existing slot.');
    const info = await db
      .prepare('INSERT INTO availability_slots (starts_at, ends_at, notes) VALUES (?, ?, ?)')
      .run(startsAt, endsAt, notes || null);
    const slot = await db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(info.lastInsertRowid);
    return ok(res, { slot }, 201);
  },
);

router.post(
  '/generate',
  validate(
    z.object({
      fromDate: z.string().min(8),
      toDate: z.string().min(8),
      startHour: z.number().int().min(0).max(23).default(9),
      endHour: z.number().int().min(1).max(23).default(17),
      weekdaysOnly: z.boolean().default(true),
    }),
  ),
  async (req, res) => {
    const { fromDate, toDate, startHour, endHour, weekdaysOnly } = req.validated;
    let created = 0;
    const insert = await db.prepare(
      'INSERT INTO availability_slots (starts_at, ends_at, notes) VALUES (?, ?, ?)',
    );
    await db.transaction(async () => {
      const start = new Date(`${fromDate}T00:00:00`);
      const end = new Date(`${toDate}T00:00:00`);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (weekdaysOnly && (day === 0 || day === 6)) continue;
        const y = d.toISOString().slice(0, 10);
        for (let h = startHour; h < endHour; h += 1) {
          const startsAt = `${y}T${String(h).padStart(2, '0')}:00:00`;
          const endsAt = `${y}T${String(h + 1).padStart(2, '0')}:00:00`;
          const exists = await db
            .prepare('SELECT id FROM availability_slots WHERE starts_at = ? AND ends_at = ?')
            .get(startsAt, endsAt);
          if (exists) continue;
          insert.run(startsAt, endsAt, 'Generated slot');
          created += 1;
        }
      }
    })();
    return ok(res, { created });
  },
);

router.patch(
  '/:id',
  validate(
    z.object({
      isBlocked: z.boolean().optional(),
      notes: z.string().max(500).optional().nullable(),
    }),
  ),
  async (req, res) => {
    const slot = await db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(req.params.id);
    if (!slot) return fail(res, 404, 'Slot not found.');
    await db.prepare(
      `UPDATE availability_slots SET
        is_blocked = COALESCE(?, is_blocked),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(req.validated.isBlocked === undefined ? null : Number(req.validated.isBlocked), req.validated.notes ?? null, slot.id);
    return ok(res, {
      slot: await db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(slot.id),
    });
  },
);

router.delete('/:id', async (req, res) => {
  const taken = await db
    .prepare(
      `SELECT id FROM appointments WHERE slot_id = ? AND status IN ('pending', 'approved', 'completed')`,
    )
    .get(req.params.id);
  if (taken) return fail(res, 409, 'Cannot delete a slot with an active appointment. Cancel the booking first.');
  const result = await db.prepare('DELETE FROM availability_slots WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return fail(res, 404, 'Slot not found.');
  return ok(res, { deleted: true });
});

router.post(
  '/blocked-dates',
  validate(z.object({ date: z.string().min(8), reason: z.string().max(200).optional().nullable() })),
  async (req, res) => {
    await db.prepare(
      `INSERT INTO blocked_dates (blocked_date, reason) VALUES (?, ?)
       ON CONFLICT(blocked_date) DO UPDATE SET reason = excluded.reason`,
    ).run(req.validated.date, req.validated.reason || null);
    const row = await db.prepare('SELECT * FROM blocked_dates WHERE blocked_date = ?').get(req.validated.date);
    return ok(res, { blockedDate: row }, 201);
  },
);

router.delete('/blocked-dates/:date', async (req, res) => {
  await db.prepare('DELETE FROM blocked_dates WHERE blocked_date = ?').run(req.params.date);
  return ok(res, { deleted: true });
});

module.exports = router;
