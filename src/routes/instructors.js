const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/instructors - list (Instructors.tsx, used as a <select> in Book.tsx)
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM instructors ORDER BY name ASC').all();
  res.json({ instructors: rows });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM instructors WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Instructor not found.' });
  res.json({ instructor: row });
});

module.exports = router;
