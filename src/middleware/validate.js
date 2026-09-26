const { fail } = require('../utils/http');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      return fail(res, 400, 'Invalid input.', { details: parsed.error.flatten() });
    }
    req.validated = parsed.data;
    next();
  };
}

module.exports = { validate };
