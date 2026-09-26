function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { ok, fail, asyncHandler };
