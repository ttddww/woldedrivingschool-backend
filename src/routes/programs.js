const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/http');
const { mapProgram } = require('../services/helpers');

const router = express.Router();

router.get('/', async (_req, res) => {
  const rows = await db
    .prepare('SELECT * FROM programs WHERE is_active = 1 ORDER BY sort_order ASC, id ASC')
    .all();
  return ok(res, { programs: rows.map(mapProgram) });
});

router.get('/:slug', async (req, res) => {
  const row = await db
    .prepare('SELECT * FROM programs WHERE (slug = ? OR CAST(id AS TEXT) = ?) AND is_active = 1')
    .get(req.params.slug, req.params.slug);
  if (!row) return fail(res, 404, 'Program not found.');
  return ok(res, { program: mapProgram(row) });
});

module.exports = router;
