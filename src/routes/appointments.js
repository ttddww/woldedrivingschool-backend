const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, fail, asyncHandler } = require('../utils/http');
const { getSetting, sendMail, notify, mapProgram } = require('../services/helpers');

const router = express.Router();

async function slotAvailable(slotId) {
  const slot = await db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(slotId);
  if (!slot) return { ok: false, error: 'That time slot was not found.' };
  if (slot.is_blocked) return { ok: false, error: 'That time is blocked.' };
  if (new Date(slot.starts_at).getTime() <= Date.now()) {
    return { ok: false, error: 'That time slot is in the past.' };
  }
  const date = slot.starts_at.slice(0, 10);
  const blocked = await db.prepare('SELECT id FROM blocked_dates WHERE blocked_date = ?').get(date);
  if (blocked) return { ok: false, error: 'That date is unavailable.' };
  const taken = await db
    .prepare(
      `SELECT id FROM appointments WHERE slot_id = ? AND status IN ('pending', 'approved', 'completed')`,
    )
    .get(slotId);
  if (taken) return { ok: false, error: 'That time slot is already booked.' };
  return { ok: true, slot };
}

function mapAppointment(row) {
  return {
    id: row.id,
    userId: row.user_id,
    programId: row.program_id,
    slotId: row.slot_id,
    status: row.status,
    studentNotes: row.student_notes,
    adminNotes: row.admin_notes,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    programName: row.program_name,
    studentName: row.student_name || null,
    studentEmail: row.email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const listSql = `
  SELECT a.*, s.starts_at, s.ends_at, p.name AS program_name,
         u.email, sp.first_name || ' ' || sp.last_name AS student_name
  FROM appointments a
  JOIN availability_slots s ON s.id = a.slot_id
  JOIN programs p ON p.id = a.program_id
  JOIN users u ON u.id = a.user_id
  LEFT JOIN student_profiles sp ON sp.user_id = u.id
`;

router.get('/availability', async (req, res) => {
  const from = req.query.from || new Date().toISOString();
  const to = req.query.to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 28).toISOString();
  const slots = await db
    .prepare(
      `SELECT s.*
       FROM availability_slots s
       WHERE s.starts_at >= ? AND s.starts_at <= ? AND s.is_blocked = 0
       AND substr(s.starts_at, 1, 10) NOT IN (SELECT blocked_date FROM blocked_dates)
       AND s.id NOT IN (
         SELECT slot_id FROM appointments WHERE status IN ('pending', 'approved', 'completed')
       )
       ORDER BY s.starts_at ASC`,
    )
    .all(from, to);
  return ok(res, { slots });
});

router.get(
  '/me',
  requireAuth,
  async (req, res) => {
    const rows = await db
      .prepare(`${listSql} WHERE a.user_id = ? ORDER BY s.starts_at DESC`)
      .all(req.user.id);
    return ok(res, { appointments: rows.map(mapAppointment) });
  },
);

router.post(
  '/',
  requireAuth,
  validate(
    z.object({
      programId: z.coerce.number().int().positive(),
      slotId: z.coerce.number().int().positive(),
      notes: z.string().max(2000).optional().nullable(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { programId, slotId, notes } = req.validated;
    const program = await db.prepare('SELECT * FROM programs WHERE id = ? AND is_active = 1').get(programId);
    if (!program) return fail(res, 400, 'Unknown or inactive program.');

    let appointment;
    try {
      appointment = await db.transaction(async () => {
        const check = await slotAvailable(slotId);
        if (!check.ok) {
          const err = new Error(check.error);
          err.status = 409;
          throw err;
        }
        const info = await db
          .prepare(
            `INSERT INTO appointments (user_id, program_id, slot_id, status, student_notes)
             VALUES (?, ?, ?, 'pending', ?)`,
          )
          .run(req.user.id, programId, slotId, notes || null);
        return await db.prepare(`${listSql} WHERE a.id = ?`).get(info.lastInsertRowid);
      })();
    } catch (err) {
      if (err.code === '23505' || err.status === 409) {
        return fail(res, 409, err.status === 409 ? err.message : 'That time slot is already booked.');
      }
      throw err;
    }

    const mapped = mapAppointment(appointment);
    await notify({
      userId: req.user.id,
      type: 'appointment',
      title: 'Lesson request submitted',
      body: `Your request for ${program.name} on ${appointment.starts_at} is pending confirmation.`,
    });
    await sendMail({
      to: req.user.email,
      subject: 'Lesson request received — Wolde Driving School',
      text: `We received your lesson request for ${program.name} at ${appointment.starts_at}. Status: pending. We will confirm shortly.`,
    });
    return ok(res, { appointment: mapped }, 201);
  }),
);

router.post(
  '/:id/cancel',
  requireAuth,
  validate(z.object({ reason: z.string().max(500).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const row = await db.prepare(`${listSql} WHERE a.id = ?`).get(req.params.id);
    if (!row) return fail(res, 404, 'Appointment not found.');
    if (req.user.role !== 'ADMIN' && row.user_id !== req.user.id) {
      return fail(res, 403, 'You cannot cancel this appointment.');
    }
    if (['cancelled', 'completed'].includes(row.status)) {
      return fail(res, 400, 'This appointment cannot be cancelled.');
    }
    if (req.user.role !== 'ADMIN') {
      const hours = Number(await getSetting('cancellation_hours', '24'));
      const start = new Date(row.starts_at).getTime();
      if (start - Date.now() < hours * 60 * 60 * 1000) {
        return fail(
          res,
          400,
          `Cancellations must be made at least ${hours} hours in advance. Please call 703-398-9915.`,
        );
      }
    }
    await db.prepare(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(req.validated.reason || null, row.id);
    const updated = await db.prepare(`${listSql} WHERE a.id = ?`).get(row.id);
    await notify({
      userId: row.user_id,
      type: 'appointment',
      title: 'Appointment cancelled',
      body: `Your lesson on ${row.starts_at} was cancelled.`,
    });
    await sendMail({
      to: row.email,
      subject: 'Appointment cancelled — Wolde Driving School',
      text: `Your lesson scheduled for ${row.starts_at} has been cancelled.`,
    });
    return ok(res, { appointment: mapAppointment(updated) });
  }),
);

router.post(
  '/:id/reschedule',
  requireAuth,
  validate(z.object({ slotId: z.coerce.number().int().positive() })),
  asyncHandler(async (req, res) => {
    const row = await db.prepare(`${listSql} WHERE a.id = ?`).get(req.params.id);
    if (!row) return fail(res, 404, 'Appointment not found.');
    if (req.user.role !== 'ADMIN' && row.user_id !== req.user.id) {
      return fail(res, 403, 'You cannot reschedule this appointment.');
    }
    if (['cancelled', 'completed'].includes(row.status)) {
      return fail(res, 400, 'This appointment cannot be rescheduled.');
    }
    if (req.user.role !== 'ADMIN') {
      const hours = Number(await getSetting('cancellation_hours', '24'));
      const start = new Date(row.starts_at).getTime();
      if (start - Date.now() < hours * 60 * 60 * 1000) {
        return fail(
          res,
          400,
          `Rescheduling must be made at least ${hours} hours in advance. Please call 703-398-9915.`,
        );
      }
    }

    try {
      await db.transaction(async () => {
        const check = await slotAvailable(req.validated.slotId);
        if (!check.ok) {
          const err = new Error(check.error);
          err.status = 409;
          throw err;
        }
        await db.prepare(
          `UPDATE appointments SET slot_id = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).run(req.validated.slotId, row.id);
      })();
    } catch (err) {
      if (err.status === 409 || err.code === '23505') {
        return fail(res, 409, err.status === 409 ? err.message : 'That time slot is already booked.');
      }
      throw err;
    }

    const updated = await db.prepare(`${listSql} WHERE a.id = ?`).get(row.id);
    await notify({
      userId: row.user_id,
      type: 'appointment',
      title: 'Appointment rescheduled',
      body: `Your lesson was moved to ${updated.starts_at}. It is pending confirmation.`,
    });
    await sendMail({
      to: row.email,
      subject: 'Appointment rescheduled — Wolde Driving School',
      text: `Your lesson was rescheduled to ${updated.starts_at}. Status: pending confirmation.`,
    });
    return ok(res, { appointment: mapAppointment(updated) });
  }),
);

// Admin collection
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const rows = await db.prepare(`${listSql} ORDER BY s.starts_at DESC`).all();
  return ok(res, { appointments: rows.map(mapAppointment) });
});

router.patch(
  '/:id/status',
  requireAuth,
  requireAdmin,
  validate(
    z.object({
      status: z.enum(['pending', 'approved', 'completed', 'cancelled']),
      adminNotes: z.string().max(2000).optional().nullable(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const row = await db.prepare(`${listSql} WHERE a.id = ?`).get(req.params.id);
    if (!row) return fail(res, 404, 'Appointment not found.');
    await db.prepare(
      `UPDATE appointments SET status = ?, admin_notes = COALESCE(?, admin_notes),
       cancelled_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(req.validated.status, req.validated.adminNotes ?? null, req.validated.status, row.id);
    const updated = await db.prepare(`${listSql} WHERE a.id = ?`).get(row.id);
    await notify({
      userId: row.user_id,
      type: 'appointment',
      title: `Appointment ${req.validated.status}`,
      body: `Your lesson on ${row.starts_at} is now ${req.validated.status}.`,
    });
    await sendMail({
      to: row.email,
      subject: `Appointment ${req.validated.status} — Wolde Driving School`,
      text: `Your lesson on ${row.starts_at} is now marked ${req.validated.status}.`,
    });
    return ok(res, { appointment: mapAppointment(updated) });
  }),
);

module.exports = { router, slotAvailable, mapAppointment, listSql };
