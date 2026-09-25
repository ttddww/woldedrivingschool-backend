const db = require('../db');
const { notify, sendMail } = require('./notify');

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function mapProgram(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    priceCents: row.price_cents,
    price: row.price_cents / 100,
    currency: row.currency,
    shortDescription: row.short_description,
    description: row.description,
    includes: JSON.parse(row.includes_json || '[]'),
    whoItsFor: row.who_its_for,
    ctaLabel: row.cta_label,
    pagePath: row.page_path,
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order,
  };
}

function publicUser(user, profile, program) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    firstName: profile?.first_name || '',
    lastName: profile?.last_name || '',
    phone: profile?.phone || '',
    dateOfBirth: profile?.date_of_birth || null,
    addressLine: profile?.address_line || '',
    city: profile?.city || '',
    state: profile?.state || '',
    postalCode: profile?.postal_code || '',
    programId: profile?.program_id || null,
    program: program ? mapProgram(program) : null,
    drivingExperience: profile?.driving_experience || '',
    preferredTime: profile?.preferred_time || '',
    emergencyContactName: profile?.emergency_contact_name || '',
    emergencyContactPhone: profile?.emergency_contact_phone || '',
    notes: profile?.notes || '',
    createdAt: user.created_at,
  };
}

function loadUserBundle(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(userId);
  const program = profile?.program_id
    ? db.prepare('SELECT * FROM programs WHERE id = ?').get(profile.program_id)
    : null;
  return publicUser(user, profile, program);
}

module.exports = {
  getSetting,
  mapProgram,
  publicUser,
  loadUserBundle,
  notify,
  sendMail,
};
