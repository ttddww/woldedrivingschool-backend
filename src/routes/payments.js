const express = require('express');
const Stripe = require('stripe');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { ok, fail, asyncHandler } = require('../utils/http');
const { sendMail, notify, mapProgram } = require('../services/helpers');

const router = express.Router();

function getStripe() {
  if (!config.stripeSecretKey) {
    const err = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY on the server.');
    err.status = 503;
    throw err;
  }
  return new Stripe(config.stripeSecretKey);
}

function mapPayment(row, program) {
  return {
    id: row.id,
    userId: row.user_id,
    programId: row.program_id,
    appointmentId: row.appointment_id,
    amountCents: row.amount_cents,
    amount: row.amount_cents / 100,
    currency: row.currency,
    status: row.status,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    provider: row.provider,
    paypalOrderId: row.paypal_order_id,
    paypalCaptureId: row.paypal_capture_id,
    createdAt: row.created_at,
    program: program ? mapProgram(program) : null,
    programName: program?.name || null,
  };
}


async function paypalAccessToken() {
  if (!config.paypalClientId || !config.paypalClientSecret) {
    const err = new Error('PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server.');
    err.status = 503;
    throw err;
  }
  const credentials = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64');
  const response = await fetch(`${config.paypalBaseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const err = new Error(data.error_description || 'Unable to authenticate with PayPal.');
    err.status = 502;
    throw err;
  }
  return data.access_token;
}

async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();
  const response = await fetch(`${config.paypalBaseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.details?.[0]?.description || data?.message || 'PayPal request failed.';
    const err = new Error(message);
    err.status = response.status >= 500 ? 502 : response.status;
    throw err;
  }
  return data;
}

function calculateAmount(program, paid, amountType) {
  const remaining = Math.max(program.price_cents - paid, 0);
  if (remaining === 0) return 0;
  let amountCents = remaining;
  if (amountType === 'deposit') amountCents = Math.ceil(program.price_cents * 0.4);
  if (amountType === 'full') amountCents = remaining === program.price_cents ? program.price_cents : remaining;
  return Math.min(amountCents, remaining);
}

router.post(
  '/paypal/create-order',
  requireAuth,
  validate(
    z.object({
      programId: z.coerce.number().int().positive(),
      amountType: z.enum(['deposit', 'full', 'balance']).default('full'),
      billingName: z.string().max(160).optional().nullable(),
      billingAddress: z.string().max(300).optional().nullable(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { programId, amountType, billingName, billingAddress } = req.validated;
    const program = await db.prepare('SELECT * FROM programs WHERE id = ? AND is_active = 1').get(programId);
    if (!program) return fail(res, 400, 'Unknown or inactive program.');

    const paid = (await db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments
       WHERE user_id = ? AND program_id = ? AND status = 'paid'`,
    ).get(req.user.id, program.id)).total;
    const amountCents = calculateAmount(program, paid, amountType);
    if (!amountCents) return fail(res, 400, 'This program is already paid in full.');

    const pending = await db.prepare(
      `INSERT INTO payments
       (user_id, program_id, amount_cents, currency, status, amount_type, billing_name, billing_address, payment_method, provider)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 'paypal', 'paypal')`,
    ).run(req.user.id, program.id, amountCents, program.currency, amountType, billingName || null, billingAddress || null);

    try {
      const order = await paypalRequest('/v2/checkout/orders', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': `wolde-${pending.lastInsertRowid}-${Date.now()}` },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: String(pending.lastInsertRowid),
            custom_id: String(pending.lastInsertRowid),
            description: program.name,
            amount: {
              currency_code: program.currency.toUpperCase(),
              value: (amountCents / 100).toFixed(2),
            },
          }],
          application_context: {
            brand_name: 'Wolde Driving School',
            user_action: 'PAY_NOW',
            return_url: `${config.frontendUrl}/payment/confirmation?paypal=success`,
            cancel_url: `${config.frontendUrl}/payment?paypal=cancelled`,
          },
        }),
      });

      const approval = order.links?.find((link) => link.rel === 'approve')?.href;
      if (!approval) throw new Error('PayPal did not return an approval URL.');
      await db.prepare(`UPDATE payments SET paypal_order_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(order.id, pending.lastInsertRowid);
      return ok(res, { approvalUrl: approval, orderId: order.id });
    } catch (err) {
      await db.prepare(`UPDATE payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(pending.lastInsertRowid);
      throw err;
    }
  }),
);

router.post(
  '/paypal/capture',
  requireAuth,
  validate(z.object({ orderId: z.string().min(1).max(100) })),
  asyncHandler(async (req, res) => {
    const payment = await db.prepare(
      `SELECT * FROM payments WHERE paypal_order_id = ? AND user_id = ? AND provider = 'paypal'`,
    ).get(req.validated.orderId, req.user.id);
    if (!payment) return fail(res, 404, 'PayPal payment not found.');
    if (payment.status === 'paid') {
      const program = await db.prepare('SELECT * FROM programs WHERE id = ?').get(payment.program_id);
      return ok(res, { payment: mapPayment(payment, program) });
    }

    const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': `wolde-capture-${payment.id}-${Date.now()}` },
      body: JSON.stringify({}),
    });

    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED') {
      return fail(res, 400, 'PayPal payment was not completed.');
    }

    await markPayPalPaid(payment.id, capture.id);
    const fresh = await db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    const program = await db.prepare('SELECT * FROM programs WHERE id = ?').get(fresh.program_id);
    return ok(res, { payment: mapPayment(fresh, program) });
  }),
);

router.post(
  '/checkout',
  requireAuth,
  validate(
    z.object({
      programId: z.coerce.number().int().positive(),
      amountType: z.enum(['deposit', 'full', 'balance']).default('full'),
      billingName: z.string().max(160).optional().nullable(),
      billingAddress: z.string().max(300).optional().nullable(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { programId, amountType, billingName, billingAddress } = req.validated;
    const program = await db
      .prepare('SELECT * FROM programs WHERE id = ? AND is_active = 1')
      .get(programId);
    if (!program) return fail(res, 400, 'Unknown or inactive program.');

    // The first payment for a program is a 40% deposit. "Balance" means
    // program price minus previous successful payments for that program.
    const paid = (await db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payments
         WHERE user_id = ? AND program_id = ? AND status = 'paid'`,
      )
      .get(req.user.id, program.id)).total;

    const remaining = Math.max(program.price_cents - paid, 0);
    if (remaining === 0) return fail(res, 400, 'This program is already paid in full.');

    let amountCents = program.price_cents;
    if (amountType === 'deposit') amountCents = Math.ceil(program.price_cents * 0.4);
    if (amountType === 'balance') amountCents = remaining;
    if (amountType === 'full') amountCents = remaining === program.price_cents ? program.price_cents : remaining;
    amountCents = Math.min(amountCents, remaining);

    const pending = await db
      .prepare(
        `INSERT INTO payments
         (user_id, program_id, amount_cents, currency, status, amount_type, billing_name, billing_address, payment_method)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 'stripe')`,
      )
      .run(
        req.user.id,
        program.id,
        amountCents,
        program.currency,
        amountType,
        billingName || null,
        billingAddress || null,
      );

    // Development fallback: if Stripe is not configured, record the payment
    // as a local test payment. Never enable this behavior in production.
    if (!config.stripeSecretKey) {
      if (config.env === 'production' || process.env.PAYMENT_FALLBACK_TEST_MODE !== 'true') {
        await db.prepare(`UPDATE payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
          pending.lastInsertRowid,
        );
        return fail(res, 503, 'Online payment is not configured.');
      }
      const fakeSession = { payment_intent: null };
      await markPaid(pending.lastInsertRowid, fakeSession);
      const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(pending.lastInsertRowid);
      return ok(res, { localTest: true, payment: mapPayment(payment, program) });
    }

    const stripe = getStripe();
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: req.user.email,
        client_reference_id: String(req.user.id),
        metadata: {
          userId: String(req.user.id),
          programId: String(program.id),
          paymentId: String(pending.lastInsertRowid),
          amountType,
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: program.currency,
              unit_amount: amountCents,
              product_data: {
                name: program.name,
                description: program.short_description,
              },
            },
          },
        ],
        success_url: `${config.frontendUrl}/payment/confirmation?success=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.frontendUrl}/payment?cancelled=1`,
      });

      await db.prepare(
        `UPDATE payments
         SET stripe_checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(session.id, pending.lastInsertRowid);

      return ok(res, { url: session.url, sessionId: session.id });
    } catch (err) {
      await db.prepare(
        `UPDATE payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(pending.lastInsertRowid);
      throw err;
    }
  }),
);
router.get('/me', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT pay.*, p.name, p.slug, p.price_cents AS program_price, p.short_description, p.description,
              p.includes_json, p.who_its_for, p.cta_label, p.page_path, p.is_active, p.sort_order, p.currency AS p_currency
       FROM payments pay JOIN programs p ON p.id = pay.program_id
       WHERE pay.user_id = ? ORDER BY pay.created_at DESC`,
    )
    .all(req.user.id);
  return ok(res, {
    payments: rows.map((r) =>
      mapPayment(r, {
        ...r,
        id: r.program_id,
        price_cents: r.program_price,
        currency: r.p_currency,
      }),
    ),
  });
});

router.get(
  '/session/:sessionId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare('SELECT * FROM payments WHERE stripe_checkout_session_id = ? AND user_id = ?')
      .get(req.params.sessionId, req.user.id);
    if (!row) return fail(res, 404, 'Payment not found.');
    if (row.status === 'pending' && config.stripeSecretKey) {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
      if (session.payment_status === 'paid') {
        await markPaid(row.id, session);
      }
    }
    const fresh = await db.prepare('SELECT * FROM payments WHERE id = ?').get(row.id);
    const program = await db.prepare('SELECT * FROM programs WHERE id = ?').get(fresh.program_id);
    return ok(res, { payment: mapPayment(fresh, program) });
  }),
);

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT pay.*, p.name AS program_name, u.email,
              sp.first_name || ' ' || sp.last_name AS student_name
       FROM payments pay
       JOIN programs p ON p.id = pay.program_id
       JOIN users u ON u.id = pay.user_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       ORDER BY pay.created_at DESC`,
    )
    .all();
  return ok(res, { payments: rows });
});

async function markPaid(paymentId, session) {
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.status === 'paid') return payment;
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE payments SET status = 'paid', stripe_payment_intent_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent || null, paymentId);
    await db.prepare(
      `UPDATE student_profiles SET program_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    ).run(payment.program_id, payment.user_id);
  })();
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(payment.user_id);
  const program = await db.prepare('SELECT name FROM programs WHERE id = ?').get(payment.program_id);
  await notify({
    userId: payment.user_id,
    type: 'payment',
    title: 'Payment received',
    body: `We received your payment for ${program?.name || 'your program'}.`,
  });
  if (user) {
    sendMail({
      to: user.email,
      subject: 'Payment confirmation — Wolde Driving School',
      text: `Thank you. Your payment for ${program?.name} was received. Amount: $${(payment.amount_cents / 100).toFixed(2)}.`,
    }).catch(() => {});
  }
  return await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}


async function markPayPalPaid(paymentId, captureId) {
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.status === 'paid') return payment;
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE payments SET status = 'paid', paypal_capture_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(captureId || null, paymentId);
    await db.prepare(
      `UPDATE student_profiles SET program_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    ).run(payment.program_id, payment.user_id);
  })();
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(payment.user_id);
  const program = await db.prepare('SELECT name FROM programs WHERE id = ?').get(payment.program_id);
  await notify({
    userId: payment.user_id,
    type: 'payment',
    title: 'Payment received',
    body: `We received your PayPal payment for ${program?.name || 'your program'}.`,
  });
  if (user) {
    sendMail({
      to: user.email,
      subject: 'PayPal payment confirmation — Wolde Driving School',
      text: `Thank you. Your PayPal payment for ${program?.name} was received. Amount: $${(payment.amount_cents / 100).toFixed(2)}.`,
    }).catch(() => {});
  }
  return await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

async function handleWebhook(req, res) {
  if (!config.stripeWebhookSecret) {
    return fail(res, 503, 'Stripe webhook is not configured.');
  }
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch {
    return fail(res, 400, 'Invalid webhook signature.');
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const paymentId = Number(session.metadata?.paymentId);
    if (paymentId) {
      const existing = await db.prepare('SELECT stripe_event_id FROM payments WHERE id = ?').get(paymentId);
      if (!existing || existing.stripe_event_id !== event.id) {
        await markPaid(paymentId, session);
        await db.prepare(`UPDATE payments SET stripe_event_id = ? WHERE id = ?`).run(event.id, paymentId);
      }
    }
  }

  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object;
    await db.prepare(
      `UPDATE payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP
       WHERE stripe_checkout_session_id = ? AND status = 'pending'`,
    ).run(session.id);
  }

  return ok(res, { received: true });
}

module.exports = { router, handleWebhook, markPaid, markPayPalPaid };
