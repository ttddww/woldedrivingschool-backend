const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, fail } = require('../utils/http');

const router = express.Router();

router.post(
  '/',
  validate(
    z.object({
      name: z.string().min(1).max(120),
      email: z.string().email().max(180),
      phone: z.string().max(40).optional().nullable(),
      subject: z.string().min(1).max(180),
      message: z.string().min(10).max(4000),
    }),
  ),
  async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
    const recent = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM contact_messages
         WHERE ip_hash = ? AND created_at > (CURRENT_TIMESTAMP - INTERVAL '10 minutes')`,
      )
      .get(ipHash);
    if (recent.n >= 5) return fail(res, 429, 'Please wait a few minutes before sending another message.');

    const info = await db
      .prepare(
        `INSERT INTO contact_messages (name, email, phone, subject, message, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.validated.name,
        req.validated.email,
        req.validated.phone || null,
        req.validated.subject,
        req.validated.message,
        ipHash,
      );
    const row = await db.prepare('SELECT id, status, created_at FROM contact_messages WHERE id = ?').get(info.lastInsertRowid);
    return ok(res, { inquiry: row, message: 'Thank you. We received your message and will respond as soon as we can.' }, 201);
  },
);

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
  return ok(res, { messages: rows });
});

router.patch(
  '/:id',
  requireAuth,
  requireAdmin,
  validate(z.object({ status: z.enum(['new', 'read', 'replied', 'archived']) })),
  async (req, res) => {
    const result = await db
      .prepare(`UPDATE contact_messages SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.validated.status, req.params.id);
    if (result.changes === 0) return fail(res, 404, 'Message not found.');
    const row = await db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id);
    return ok(res, { message: row });
  },
);

module.exports = router;
