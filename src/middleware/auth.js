const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { fail } = require("../utils/http");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return fail(res, 401, "Authentication required.");
  }

  const token = header.slice(7).trim();

  if (!token) {
    return fail(res, 401, "Authentication required.");
  }

  try {
    console.log("AUTH TOKEN:", {
      exists: !!token,
      type: typeof token,
      parts: token.split(".").length,
      length: token.length,
    });

    const payload = jwt.verify(token, config.jwtSecret);

    const user = db
      .prepare("SELECT id, email, role, is_active FROM users WHERE id = ?")
      .get(payload.id);

    if (!user) {
      return fail(res, 401, "Authentication required.");
    }

    if (!user.is_active) {
      return fail(res, 403, "This account is inactive.");
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (err) {
    console.error("JWT error:", err.message);

    return fail(res, 401, "Invalid or expired session.");
  }
}

function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(header.slice(7).trim(), config.jwtSecret);
    const user = db.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?').get(payload.id);
    if (user && user.is_active) {
      req.user = { id: user.id, email: user.email, role: user.role };
    }
  } catch {
    // Public booking requests may proceed without authentication.
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return fail(res, 403, "Administrator access required.");
  }

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return fail(res, 403, "You do not have permission to do that.");
    }

    next();
  };
}

module.exports = {
  optionalAuth,
  requireAuth,
  requireAdmin,
  requireRole,
};

// const jwt = require('jsonwebtoken');
// const config = require('../config');
// const db = require('../db');
// const { fail } = require('../utils/http');

// function requireAuth(req, res, next) {
//   const header = req.headers.authorization || '';
//   const token = header.startsWith('Bearer ') ? header.slice(7) : null;
//   if (!token) return fail(res, 401, 'Authentication required.');

//   try {
//     const payload = jwt.verify(token, config.jwtSecret);
//     const user = db.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?').get(payload.id);
//     if (!user) return fail(res, 401, 'Authentication required.');
//     if (!user.is_active) return fail(res, 403, 'This account is inactive.');
//     req.user = { id: user.id, email: user.email, role: user.role };
//     next();
//   } catch (err) {
//     console.error('JWT error:', err.message);
//     return fail(res, 401, 'Invalid or expired session.');
//   }
// }

// function requireAdmin(req, res, next) {
//   if (!req.user || req.user.role !== 'ADMIN') {
//     return fail(res, 403, 'Administrator access required.');
//   }
//   next();
// }

// function requireRole(...roles) {
//   return (req, res, next) => {
//     if (!req.user || !roles.includes(req.user.role)) {
//       return fail(res, 403, 'You do not have permission to do that.');
//     }
//     next();
//   };
// }

// module.exports = { requireAuth, requireAdmin, requireRole };
