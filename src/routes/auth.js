const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, fail, asyncHandler } = require('../utils/http');
const { loadUserBundle, sendMail, notify } = require('../services/helpers');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

const registerSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().max(180),
  phone: z.string().min(7).max(40),
  password: z.string().min(8).max(200),
  dateOfBirth: z.string().max(20).optional().nullable(),
  addressLine: z.string().max(200).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  state: z.string().max(40).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  programId: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
    z.number().int().positive().nullable().optional(),
  ),
  drivingExperience: z.string().max(80).optional().nullable(),
  preferredTime: z.string().max(80).optional().nullable(),
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(40).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

router.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const data = req.validated;
    const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(data.email);
    if (existing) return fail(res, 409, 'An account with that email already exists.');

    if (data.programId) {
      const program = await db.prepare('SELECT id FROM programs WHERE id = ? AND is_active = 1').get(data.programId);
      if (!program) return fail(res, 400, 'Unknown or inactive program.');
    }

    const passwordHash = bcrypt.hashSync(data.password, 12);
    const created = await db.transaction(async () => {
      const info = await db
        .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'STUDENT')`)
        .run(data.email.toLowerCase(), passwordHash);
      await db.prepare(
        `INSERT INTO student_profiles (
          user_id, first_name, last_name, phone, date_of_birth, address_line, city, state, postal_code,
          program_id, driving_experience, preferred_time, emergency_contact_name, emergency_contact_phone, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        info.lastInsertRowid,
        data.firstName,
        data.lastName,
        data.phone,
        data.dateOfBirth || null,
        data.addressLine || null,
        data.city || null,
        data.state || 'VA',
        data.postalCode || null,
        data.programId || null,
        data.drivingExperience || null,
        data.preferredTime || null,
        data.emergencyContactName || null,
        data.emergencyContactPhone || null,
        data.notes || null,
      );
      return info.lastInsertRowid;
    })();

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(created);
    const bundle = await loadUserBundle(user.id);
    await notify({
      userId: user.id,
      type: 'registration',
      title: 'Welcome to Wolde Driving School',
      body: 'Your student account is ready. You can book a lesson and pay for your program from the dashboard.',
    });
    await sendMail({
      to: user.email,
      subject: 'Registration received — Wolde Driving School',
      text: `Hi ${data.firstName},\n\nThank you for registering with Wolde Driving School in Alexandria, VA.\nYou can log in anytime to book lessons and complete payment.\n\nPhone: 703-398-9915\n`,
    });

    return ok(res, { token: signToken(user), user: bundle }, 201);
  }),
);

router.post(
  '/login',
  validate(
    z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }),
  ),
  async (req, res) => {
    const { email, password } = req.validated;
    const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return fail(res, 401, 'Email or password is incorrect.');
    }
    if (!user.is_active) return fail(res, 403, 'This account is inactive. Please contact the school.');
    return ok(res, { token: signToken(user), user: await loadUserBundle(user.id) });
  },
);

router.get('/me', requireAuth, async (req, res) => {
  const user = await loadUserBundle(req.user.id);
  if (!user) return fail(res, 404, 'User not found.');
  return ok(res, { user });
});

router.patch(
  '/me',
  requireAuth,
  validate(
    z.object({
      firstName: z.string().min(1).max(80).optional(),
      lastName: z.string().min(1).max(80).optional(),
      phone: z.string().min(7).max(40).optional(),
      dateOfBirth: z.string().max(20).optional().nullable(),
      addressLine: z.string().max(200).optional().nullable(),
      city: z.string().max(80).optional().nullable(),
      state: z.string().max(40).optional().nullable(),
      postalCode: z.string().max(20).optional().nullable(),
      programId: z.preprocess(
        (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
        z.number().int().positive().nullable().optional(),
      ),
      drivingExperience: z.string().max(80).optional().nullable(),
      preferredTime: z.string().max(80).optional().nullable(),
      emergencyContactName: z.string().max(120).optional().nullable(),
      emergencyContactPhone: z.string().max(40).optional().nullable(),
      notes: z.string().max(2000).optional().nullable(),
    }),
  ),
  async (req, res) => {
    const data = req.validated;
    if (data.programId) {
      const program = await db.prepare('SELECT id FROM programs WHERE id = ? AND is_active = 1').get(data.programId);
      if (!program) return fail(res, 400, 'Unknown or inactive program.');
    }
    const profile = await db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(req.user.id);
    if (!profile) return fail(res, 404, 'Profile not found.');
    await db.prepare(
      `UPDATE student_profiles SET
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        phone = COALESCE(?, phone),
        date_of_birth = COALESCE(?, date_of_birth),
        address_line = COALESCE(?, address_line),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        postal_code = COALESCE(?, postal_code),
        program_id = COALESCE(?, program_id),
        driving_experience = COALESCE(?, driving_experience),
        preferred_time = COALESCE(?, preferred_time),
        emergency_contact_name = COALESCE(?, emergency_contact_name),
        emergency_contact_phone = COALESCE(?, emergency_contact_phone),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
    ).run(
      data.firstName ?? null,
      data.lastName ?? null,
      data.phone ?? null,
      data.dateOfBirth ?? null,
      data.addressLine ?? null,
      data.city ?? null,
      data.state ?? null,
      data.postalCode ?? null,
      data.programId ?? null,
      data.drivingExperience ?? null,
      data.preferredTime ?? null,
      data.emergencyContactName ?? null,
      data.emergencyContactPhone ?? null,
      data.notes ?? null,
      req.user.id,
    );
    return ok(res, { user: await loadUserBundle(req.user.id) });
  },
);

router.post(
  '/change-password',
  requireAuth,
  validate(
    z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(200),
    }),
  ),
  async (req, res) => {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(req.validated.currentPassword, user.password_hash)) {
      return fail(res, 400, 'Current password is incorrect.');
    }
    await db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      bcrypt.hashSync(req.validated.newPassword, 12),
      user.id,
    );
    return ok(res, { message: 'Password updated.' });
  },
);

const RESET_GENERIC =
  'If an account exists for that email, you will receive password reset instructions shortly.';

router.post(
  '/forgot-password',
  validate(z.object({ email: z.string().email() })),
  asyncHandler(async (req, res) => {
    const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(req.validated.email);
    if (user && user.is_active) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await db.prepare(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES (?, ?, (CURRENT_TIMESTAMP + INTERVAL '1 hour'))`,
      ).run(user.id, tokenHash);
      const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
      await sendMail({
        to: user.email,
        subject: 'Password reset — Wolde Driving School',
        text: `Use this link within one hour to reset your password:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      });
    }
    return ok(res, { message: RESET_GENERIC });
  }),
);

router.post(
  '/reset-password',
  validate(
    z.object({
      token: z.string().min(16),
      password: z.string().min(8).max(200),
    }),
  ),
  async (req, res) => {
    const tokenHash = crypto.createHash('sha256').update(req.validated.token).digest('hex');
    const row = await db
      .prepare(
        `SELECT * FROM password_reset_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      )
      .get(tokenHash);
    if (!row) return fail(res, 400, 'This reset link is invalid or has expired.');
    await db.transaction(async () => {
      await db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        bcrypt.hashSync(req.validated.password, 12),
        row.user_id,
      );
      await db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    })();
    return ok(res, { message: 'Password updated. You can log in with your new password.' });
  },
);

module.exports = router;
