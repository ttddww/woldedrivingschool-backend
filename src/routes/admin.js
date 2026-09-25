const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, fail } = require('../utils/http');
const { mapProgram } = require('../services/helpers');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/overview', (_req, res) => {
  const totalStudents = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'STUDENT'`).get().n;
  const newRegistrations = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'STUDENT' AND created_at >= datetime('now', '-30 days')`)
    .get().n;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments a
       JOIN availability_slots s ON s.id = a.slot_id
       WHERE a.status IN ('pending', 'approved') AND s.starts_at >= datetime('now')`,
    )
    .get().n;
  const completed = db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'completed'`).get().n;
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'pending'`).get().n;
  const inquiries = db.prepare(`SELECT COUNT(*) AS n FROM contact_messages WHERE status = 'new'`).get().n;
  const revenue = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE status = 'paid'`).get().n;
  const recentPayments = db
    .prepare(
      `SELECT pay.id, pay.amount_cents, pay.status, pay.created_at, p.name AS program_name, u.email
       FROM payments pay JOIN programs p ON p.id = pay.program_id JOIN users u ON u.id = pay.user_id
       ORDER BY pay.created_at DESC LIMIT 8`,
    )
    .all();
  return ok(res, {
    totalStudents,
    newRegistrations,
    upcomingAppointments: upcoming,
    completedLessons: completed,
    pendingAppointments: pending,
    contactInquiries: inquiries,
    revenueCents: revenue,
    recentPayments,
  });
});

router.get('/students', (req, res) => {
  const q = `%${(req.query.q || '').toString().trim().toLowerCase()}%`;
  const active = req.query.active;
  let sql = `
    SELECT u.id, u.email, u.role, u.is_active, u.created_at,
           sp.first_name, sp.last_name, sp.phone, sp.program_id, p.name AS program_name
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    LEFT JOIN programs p ON p.id = sp.program_id
    WHERE u.role = 'STUDENT'
      AND (lower(u.email) LIKE ? OR lower(ifnull(sp.first_name,'')) LIKE ? OR lower(ifnull(sp.last_name,'')) LIKE ?
           OR ifnull(sp.phone,'') LIKE ?)
  `;
  const params = [q, q, q, q];
  if (active === '1' || active === '0') {
    sql += ' AND u.is_active = ?';
    params.push(Number(active));
  }
  sql += ' ORDER BY u.created_at DESC';
  return ok(res, { students: db.prepare(sql).all(...params) });
});

router.get('/students/:id', (req, res) => {
  const user = db.prepare(`SELECT id, email, role, is_active, created_at FROM users WHERE id = ? AND role = 'STUDENT'`).get(req.params.id);
  if (!user) return fail(res, 404, 'Student not found.');
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(user.id);
  const program = profile?.program_id ? db.prepare('SELECT * FROM programs WHERE id = ?').get(profile.program_id) : null;
  const appointments = db
    .prepare(
      `SELECT a.*, s.starts_at, s.ends_at, p.name AS program_name
       FROM appointments a JOIN availability_slots s ON s.id = a.slot_id JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? ORDER BY s.starts_at DESC`,
    )
    .all(user.id);
  const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  return ok(res, { student: { ...user, profile, program: program ? mapProgram(program) : null, appointments, payments } });
});

router.patch(
  '/students/:id',
  validate(
    z.object({
      firstName: z.string().min(1).optional(),
      lastName: z.string().min(1).optional(),
      phone: z.string().min(7).optional(),
      programId: z.number().int().positive().nullable().optional(),
      isActive: z.boolean().optional(),
      notes: z.string().max(2000).optional().nullable(),
    }),
  ),
  (req, res) => {
    const user = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'STUDENT'`).get(req.params.id);
    if (!user) return fail(res, 404, 'Student not found.');
    if (req.validated.isActive !== undefined) {
      db.prepare(`UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(
        Number(req.validated.isActive),
        user.id,
      );
    }
    const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(user.id);
    if (profile) {
      db.prepare(
        `UPDATE student_profiles SET
          first_name = COALESCE(?, first_name),
          last_name = COALESCE(?, last_name),
          phone = COALESCE(?, phone),
          program_id = COALESCE(?, program_id),
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
         WHERE user_id = ?`,
      ).run(
        req.validated.firstName ?? null,
        req.validated.lastName ?? null,
        req.validated.phone ?? null,
        req.validated.programId === undefined ? null : req.validated.programId,
        req.validated.notes ?? null,
        user.id,
      );
    }
    return ok(res, { student: db.prepare('SELECT id, email, is_active FROM users WHERE id = ?').get(user.id) });
  },
);

router.delete('/students/:id', (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'STUDENT'`).get(req.params.id);
  if (!user) return fail(res, 404, 'Student not found.');
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return ok(res, { deleted: true });
});

router.get('/programs', (_req, res) => {
  const rows = db.prepare('SELECT * FROM programs ORDER BY sort_order, id').all();
  return ok(res, { programs: rows.map(mapProgram) });
});

const programSchema = z.object({
  slug: z.string().min(2).max(80).optional(),
  name: z.string().min(1).max(120),
  priceCents: z.number().int().min(0),
  shortDescription: z.string().min(1),
  description: z.string().min(1),
  includes: z.array(z.string()).default([]),
  whoItsFor: z.string().default(''),
  ctaLabel: z.string().default('Register'),
  pagePath: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

router.post('/programs', validate(programSchema), (req, res) => {
  const d = req.validated;
  const slug =
    d.slug ||
    d.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const info = db
    .prepare(
      `INSERT INTO programs (slug, name, price_cents, short_description, description, includes_json, who_its_for, cta_label, page_path, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slug,
      d.name,
      d.priceCents,
      d.shortDescription,
      d.description,
      JSON.stringify(d.includes),
      d.whoItsFor,
      d.ctaLabel,
      d.pagePath || null,
      d.isActive === false ? 0 : 1,
      d.sortOrder ?? 0,
    );
  return ok(res, { program: mapProgram(db.prepare('SELECT * FROM programs WHERE id = ?').get(info.lastInsertRowid)) }, 201);
});

router.patch('/programs/:id', validate(programSchema.partial()), (req, res) => {
  const row = db.prepare('SELECT * FROM programs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, 'Program not found.');
  const d = req.validated;
  db.prepare(
    `UPDATE programs SET
      slug = COALESCE(?, slug),
      name = COALESCE(?, name),
      price_cents = COALESCE(?, price_cents),
      short_description = COALESCE(?, short_description),
      description = COALESCE(?, description),
      includes_json = COALESCE(?, includes_json),
      who_its_for = COALESCE(?, who_its_for),
      cta_label = COALESCE(?, cta_label),
      page_path = COALESCE(?, page_path),
      is_active = COALESCE(?, is_active),
      sort_order = COALESCE(?, sort_order),
      updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    d.slug ?? null,
    d.name ?? null,
    d.priceCents ?? null,
    d.shortDescription ?? null,
    d.description ?? null,
    d.includes ? JSON.stringify(d.includes) : null,
    d.whoItsFor ?? null,
    d.ctaLabel ?? null,
    d.pagePath ?? null,
    d.isActive === undefined ? null : Number(d.isActive),
    d.sortOrder ?? null,
    row.id,
  );
  return ok(res, { program: mapProgram(db.prepare('SELECT * FROM programs WHERE id = ?').get(row.id)) });
});

router.get('/faqs', (_req, res) => ok(res, { faqs: db.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all() }));

router.post(
  '/faqs',
  validate(z.object({ question: z.string().min(1), answer: z.string().min(1), isPublished: z.boolean().optional(), sortOrder: z.number().int().optional() })),
  (req, res) => {
    const info = db
      .prepare('INSERT INTO faqs (question, answer, is_published, sort_order) VALUES (?, ?, ?, ?)')
      .run(req.validated.question, req.validated.answer, req.validated.isPublished === false ? 0 : 1, req.validated.sortOrder ?? 0);
    return ok(res, { faq: db.prepare('SELECT * FROM faqs WHERE id = ?').get(info.lastInsertRowid) }, 201);
  },
);

router.patch(
  '/faqs/:id',
  validate(z.object({ question: z.string().optional(), answer: z.string().optional(), isPublished: z.boolean().optional(), sortOrder: z.number().int().optional() })),
  (req, res) => {
    const row = db.prepare('SELECT * FROM faqs WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'FAQ not found.');
    db.prepare(
      `UPDATE faqs SET question = COALESCE(?, question), answer = COALESCE(?, answer),
       is_published = COALESCE(?, is_published), sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`,
    ).run(
      req.validated.question ?? null,
      req.validated.answer ?? null,
      req.validated.isPublished === undefined ? null : Number(req.validated.isPublished),
      req.validated.sortOrder ?? null,
      row.id,
    );
    return ok(res, { faq: db.prepare('SELECT * FROM faqs WHERE id = ?').get(row.id) });
  },
);

router.delete('/faqs/:id', (req, res) => {
  const result = db.prepare('DELETE FROM faqs WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return fail(res, 404, 'FAQ not found.');
  return ok(res, { deleted: true });
});

router.get('/testimonials', (_req, res) =>
  ok(res, { testimonials: db.prepare('SELECT * FROM testimonials ORDER BY sort_order, id').all() }),
);

router.post(
  '/testimonials',
  validate(
    z.object({
      quote: z.string().min(1),
      attribution: z.string().min(1),
      programName: z.string().optional().nullable(),
      isPlaceholder: z.boolean().optional(),
      isPublished: z.boolean().optional(),
    }),
  ),
  (req, res) => {
    const info = db
      .prepare(
        `INSERT INTO testimonials (quote, attribution, program_name, is_placeholder, is_published)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        req.validated.quote,
        req.validated.attribution,
        req.validated.programName || null,
        req.validated.isPlaceholder === false ? 0 : 1,
        req.validated.isPublished ? 1 : 0,
      );
    return ok(res, { testimonial: db.prepare('SELECT * FROM testimonials WHERE id = ?').get(info.lastInsertRowid) }, 201);
  },
);

router.patch(
  '/testimonials/:id',
  validate(
    z.object({
      quote: z.string().optional(),
      attribution: z.string().optional(),
      programName: z.string().optional().nullable(),
      isPlaceholder: z.boolean().optional(),
      isPublished: z.boolean().optional(),
    }),
  ),
  (req, res) => {
    const row = db.prepare('SELECT * FROM testimonials WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Testimonial not found.');
    db.prepare(
      `UPDATE testimonials SET quote = COALESCE(?, quote), attribution = COALESCE(?, attribution),
       program_name = COALESCE(?, program_name), is_placeholder = COALESCE(?, is_placeholder),
       is_published = COALESCE(?, is_published), updated_at = datetime('now') WHERE id = ?`,
    ).run(
      req.validated.quote ?? null,
      req.validated.attribution ?? null,
      req.validated.programName ?? null,
      req.validated.isPlaceholder === undefined ? null : Number(req.validated.isPlaceholder),
      req.validated.isPublished === undefined ? null : Number(req.validated.isPublished),
      row.id,
    );
    return ok(res, { testimonial: db.prepare('SELECT * FROM testimonials WHERE id = ?').get(row.id) });
  },
);

router.delete('/testimonials/:id', (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  return ok(res, { deleted: true });
});

router.get('/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM site_settings').all();
  return ok(res, { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

router.put(
  '/settings',
  validate(z.object({ settings: z.record(z.string(), z.string()) })),
  (req, res) => {
    const upsert = db.prepare(
      `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    );
    db.transaction(() => {
      for (const [key, value] of Object.entries(req.validated.settings)) {
        upsert.run(key, value);
      }
    })();
    const rows = db.prepare('SELECT key, value FROM site_settings').all();
    return ok(res, { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  },
);

module.exports = router;
