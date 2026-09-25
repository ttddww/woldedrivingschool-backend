const bcrypt = require('bcryptjs');
const db = require('./index');
const config = require('../config');

const programs = [
  {
    slug: 'online-classroom',
    name: 'Online Classroom',
    price_cents: 20000,
    short_description: 'Self-paced classroom instruction you can complete from home.',
    description:
      'The Online Classroom program covers foundational driver education topics so students can learn traffic safety concepts on a flexible schedule. Classroom modules can be integrated into this program over time; this enrollment currently reserves your place in Wolde Driving School’s online classroom offering.',
    includes: [
      'Access to the online classroom program upon enrollment',
      'Core driver-education topics presented in a structured format',
      'A path to continue with behind-the-wheel training when you are ready',
      'Support from Wolde Driving School by phone or email',
    ],
    who_its_for: 'Teens and adults who want classroom-style driver education with the flexibility of online learning.',
    cta_label: 'Register for Online Classroom',
    page_path: '/online-classroom',
    sort_order: 1,
  },
  {
    slug: 'behind-the-wheel',
    name: 'Behind-the-Wheel Driving Lessons',
    price_cents: 35000,
    short_description: 'One-on-one in-car instruction focused on safe, confident driving.',
    description:
      'Behind-the-wheel lessons give students practical experience with vehicle control, traffic awareness, and defensive driving techniques. Instruction is tailored to the student’s current skill level. Wolde Driving School does not guarantee a DMV test outcome; we focus on preparation, practice, and responsible habits.',
    includes: [
      'One-on-one behind-the-wheel instruction',
      'Practice with vehicle control, parking, turning, and lane changes',
      'Traffic awareness and defensive driving guidance',
      'Road-test skill practice as appropriate for the student',
    ],
    who_its_for: 'New drivers, teens, and adults who need structured in-car practice in the Alexandria and Northern Virginia area.',
    cta_label: 'Book behind-the-wheel lessons',
    page_path: '/behind-the-wheel',
    sort_order: 2,
  },
  {
    slug: 'dmv-road-test-support',
    name: 'DMV Road-Test Support',
    price_cents: 35000,
    short_description: 'Focused preparation for students who need extra support before the DMV road test.',
    description:
      'DMV Road-Test Support is designed for students who have not yet passed the Virginia DMV road test, including students who have failed the test multiple times (including after three failures). Wolde Driving School provides practice, vehicle-oriented preparation, and coaching. The Virginia DMV administers the official road test; this program is preparation and support, not a DMV service.',
    includes: [
      'Targeted practice on common road-test skills',
      'Parking and maneuver practice',
      'Traffic awareness coaching',
      'Test-day preparation guidance (distinct from the DMV itself)',
    ],
    who_its_for:
      'Students who have struggled with the DMV road test, including after multiple failures, and want structured support before trying again.',
    cta_label: 'Get road-test support',
    page_path: '/dmv-road-test',
    sort_order: 3,
  },
];

const courses = [
  ['beginner', 'Beginner License Package', 140000],
  ['standard', 'Standard License Course', 72500],
  ['intensive', 'Intensive Course', 95000],
  ['defensive', 'Driving Course', 35000],
  ['test-prep', 'Road Test Prep', 35000],
  ['theory', 'Online or In-Person Theory Class', 20000],
];

const instructors = [
  ['teketel', 'Teketel Wolde'],
  ['selam', 'Selam Tesfaye'],
  ['yonas', 'Yonas Bekele'],
];

const faqs = [
  ['How do I register?', 'Use the Register page to create a student account. You will choose a program, share basic contact details, and set a password. After you register you can log in to the student dashboard.'],
  ['How much do lessons cost?', 'Current program prices are listed on the Programs & Pricing page. Prices are stored in our system and can be updated by the school. Pay securely online through Stripe.'],
  ['Do you teach teens?', 'Yes. Wolde Driving School offers teen driver education, including classroom-style learning and behind-the-wheel practice. Age and licensing rules are set by the Virginia DMV — confirm current requirements at dmv.virginia.gov.'],
  ['Do you teach adults?', 'Yes. We work with first-time adult drivers, adults who need additional practice, adults returning to driving, and adults preparing for the DMV road test.'],
  ['How do I schedule a lesson?', 'Create an account, open Book a Lesson, choose a program and an available time slot, and submit your request. You can view, cancel, or reschedule according to the school’s notice policy from your dashboard.'],
  ['Can I pay online?', 'Yes. Logged-in students can pay for a program through Stripe Checkout. Wolde Driving School never stores full credit-card numbers.'],
  ['How does the DMV road-test support work?', 'This program helps students prepare for the Virginia DMV road test with practice and coaching. It is especially intended for students who have failed the road test multiple times, including after three failures. The DMV conducts the official test; we provide support and preparation.'],
  ['Where are you located?', 'Wolde Driving School is based at 5412 Bradford Ct Apt 230, Alexandria, VA 22311, and serves Alexandria and surrounding Northern Virginia communities.'],
  ['How can I contact Wolde Driving School?', 'Call 703-398-9915, email woldedrivingschool@gmail.com, or use the contact form on this website.'],
];

const settings = {
  cancellation_hours: '24',
  refund_policy:
    'Refund requests are reviewed case by case. Contact Wolde Driving School at 703-398-9915 or woldedrivingschool@gmail.com. Stripe processes payments; card details are never stored in our database.',
  teen_age_note:
    'Virginia sets driver licensing and driver-education age requirements through the Virginia Department of Motor Vehicles. Wolde Driving School does not replace DMV rules. Confirm current age, permit, and education requirements at dmv.virginia.gov before you register. This notice can be updated by the school as official guidance is confirmed.',
  service_area:
    'Wolde Driving School serves Alexandria, Virginia, and surrounding Northern Virginia communities. Contact the school to confirm whether your pickup or lesson location can be accommodated.',
  auto_approve_bookings: '0',
};

const upsertProgram = db.prepare(`
  INSERT INTO programs (slug, name, price_cents, short_description, description, includes_json, who_its_for, cta_label, page_path, sort_order, is_active)
  VALUES (@slug, @name, @price_cents, @short_description, @description, @includes_json, @who_its_for, @cta_label, @page_path, @sort_order, 1)
  ON CONFLICT(slug) DO UPDATE SET
    name=excluded.name,
    price_cents=excluded.price_cents,
    short_description=excluded.short_description,
    description=excluded.description,
    includes_json=excluded.includes_json,
    who_its_for=excluded.who_its_for,
    cta_label=excluded.cta_label,
    page_path=excluded.page_path,
    sort_order=excluded.sort_order,
    updated_at=datetime('now')
`);

const seed = db.transaction(() => {
  for (const p of programs) {
    upsertProgram.run({ ...p, includes_json: JSON.stringify(p.includes) });
  }

  const upsertCourse = db.prepare(`
    INSERT INTO courses (id, name, price_cents, is_active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, price_cents=excluded.price_cents, is_active=1, updated_at=datetime('now')
  `);
  courses.forEach((c) => upsertCourse.run(...c));

  const upsertInstructor = db.prepare(`
    INSERT INTO instructors (id, name, is_active)
    VALUES (?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_active=1, updated_at=datetime('now')
  `);
  instructors.forEach((i) => upsertInstructor.run(...i));

  const faqCount = db.prepare('SELECT COUNT(*) AS n FROM faqs').get().n;
  if (faqCount === 0) {
    const ins = db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)');
    faqs.forEach((f, i) => ins.run(f[0], f[1], i + 1));
  }

  const upsertSetting = db.prepare(
    `INSERT INTO site_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  );
  for (const [k, v] of Object.entries(settings)) upsertSetting.run(k, v);

  const tCount = db.prepare('SELECT COUNT(*) AS n FROM testimonials').get().n;
  if (tCount === 0) {
    db.prepare(
      `INSERT INTO testimonials (quote, attribution, program_name, is_placeholder, is_published)
       VALUES (?, ?, ?, 1, 0)`,
    ).run(
      'Placeholder example only — replace with a real student comment after you have permission to publish it.',
      'Sample format (not a real review)',
      'Behind-the-Wheel Driving Lessons',
    );
  }

  const adminEmail = (config.admin.email || 'admin@woldedrivingschool.local').toLowerCase();
  const adminPassword = config.admin.password || 'ChangeMeNow!Admin1';
  const existingAdmin = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(adminEmail);
  if (!existingAdmin) {
    const info = db
      .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'ADMIN')`)
      .run(adminEmail, bcrypt.hashSync(adminPassword, 12));
    db.prepare(
      `INSERT INTO student_profiles (user_id, first_name, last_name, phone)
       VALUES (?, 'School', 'Administrator', '703-398-9915')`,
    ).run(info.lastInsertRowid);
    console.log(`Created admin account: ${adminEmail}`);
    if (!config.admin.password) {
      console.log('Default admin password is ChangeMeNow!Admin1 — change it immediately.');
    }
  }

  const slotCount = db.prepare('SELECT COUNT(*) AS n FROM availability_slots').get().n;
  if (slotCount === 0) {
    const insertSlot = db.prepare(
      `INSERT INTO availability_slots (starts_at, ends_at, notes) VALUES (?, ?, 'Seed sample slot')`,
    );
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    for (let day = 0; day < 14; day += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + day);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const y = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (const h of [9, 10, 11, 13, 14, 15, 16]) {
        insertSlot.run(`${y}T${String(h).padStart(2, '0')}:00:00`, `${y}T${String(h + 1).padStart(2, '0')}:00:00`);
      }
    }
  }
});

seed();
console.log('Seed complete: programs, FAQs, settings, admin, and sample availability.');
