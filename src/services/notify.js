const db = require('../db');
const config = require('../config');

async function notify({ userId, type, title, body }) {
  await db.prepare(
    `INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)`,
  ).run(userId, type, title, body);
}

async function sendMail({ to, subject, text, html }) {
  await db.prepare(
    `INSERT INTO email_outbox (to_email, subject, text_body, html_body, status)
     VALUES (?, ?, ?, ?, 'queued')`,
  ).run(to, subject, text, html || null);

  const provider = config.email.provider;

  if (provider === 'webhook' && config.email.webhookUrl) {
    try {
      const res = await fetch(config.email.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text, html, from: config.email.from }),
      });
      if (!res.ok) throw new Error(`Webhook status ${res.status}`);
      await markLatestSent(to, subject);
    } catch (err) {
      await markLatestError(to, subject, err.message);
    }
    return;
  }

  if (provider === 'smtp' && config.email.smtpHost) {
    try {
      // Optional provider — only loaded when SMTP is configured.
      // eslint-disable-next-line global-require
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        secure: config.email.smtpPort === 465,
        auth:
          config.email.smtpUser && config.email.smtpPass
            ? { user: config.email.smtpUser, pass: config.email.smtpPass }
            : undefined,
      });
      await transporter.sendMail({
        from: config.email.from,
        to,
        subject,
        text,
        html,
      });
      await markLatestSent(to, subject);
    } catch (err) {
      await markLatestError(to, subject, err.message);
    }
    return;
  }

  if (config.env !== 'test') {
    console.log(`[email:log] to=${to} subject=${subject}`);
  }
  await markLatestSent(to, subject);
}

async function markLatestSent(to, subject) {
  await db.prepare(
    `UPDATE email_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP
     WHERE id = (SELECT id FROM email_outbox WHERE to_email = ? AND subject = ? ORDER BY id DESC LIMIT 1)`,
  ).run(to, subject);
}

async function markLatestError(to, subject, error) {
  await db.prepare(
    `UPDATE email_outbox SET status = 'error', error = ?
     WHERE id = (SELECT id FROM email_outbox WHERE to_email = ? AND subject = ? ORDER BY id DESC LIMIT 1)`,
  ).run(String(error).slice(0, 500), to, subject);
}

module.exports = { notify, sendMail };
