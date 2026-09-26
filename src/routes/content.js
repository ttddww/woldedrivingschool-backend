const express = require('express');
const db = require('../db');
const { ok } = require('../utils/http');

const router = express.Router();

router.get('/', async (_req, res) => {
  const faqs = await db
    .prepare('SELECT id, question, answer, sort_order FROM faqs WHERE is_published = 1 ORDER BY sort_order, id')
    .all();
  const testimonials = await db
    .prepare(
      `SELECT id, quote, attribution, program_name, is_placeholder
       FROM testimonials WHERE is_published = 1 ORDER BY sort_order, id`,
    )
    .all();
  const settingsRows = await db.prepare('SELECT key, value FROM site_settings').all();
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  return ok(res, { faqs, testimonials, settings });
});

module.exports = router;
