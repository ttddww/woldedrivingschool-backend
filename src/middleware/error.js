const { fail } = require('../utils/http');

function notFound(_req, res) {
  return fail(res, 404, 'Not found.');
}

function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(err.message || err);
  }
  const message =
    status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : err.message || 'Internal server error.';
  return fail(res, status, message);
}

module.exports = { notFound, errorHandler };
