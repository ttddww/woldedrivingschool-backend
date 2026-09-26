require('dotenv').config();

function requiredInProduction(name) {
  const value = process.env[name];
  if (process.env.NODE_ENV === 'production' && !value) {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me-not-for-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin: process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:5173',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  backendUrl: process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`,
  databaseUrl: process.env.DATABASE_URL || (
    process.env.DB_PATH && /^postgres(?:ql)?:\/\//i.test(process.env.DB_PATH)
      ? process.env.DB_PATH
      : ''
  ),
  databaseSsl: process.env.DATABASE_SSL || 'require',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  paypalEnvironment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
  paypalBaseUrl: (process.env.PAYPAL_ENVIRONMENT || 'sandbox') === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com',
  email: {
    provider: process.env.EMAIL_PROVIDER || 'log',
    from: process.env.EMAIL_FROM || 'Wolde Driving School <noreply@localhost>',
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    webhookUrl: process.env.EMAIL_WEBHOOK_URL || '',
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@woldedrivingschool.local',
    password: process.env.ADMIN_PASSWORD || '',
  },
};

if (config.env === 'production') {
  requiredInProduction('JWT_SECRET');
  requiredInProduction('FRONTEND_URL');
}

module.exports = config;
