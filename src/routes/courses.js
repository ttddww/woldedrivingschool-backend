const express = require('express');
const db = require('../db');

const router = express.Router();

function toCourse(row) {
  return { ...row, includes: JSON.parse(row.includes || '[]') };
}

// GET /api/courses - list (Courses.tsx)
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM courses ORDER BY price ASC').all();
  res.json({ courses: rows.map(toCourse) });
});

// GET /api/courses/:id - detail (CourseDetail.tsx)
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Course not found.' });
  res.json({ course: toCourse(row) });
});

module.exports = router;
