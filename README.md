# Wolde Driving School — Backend API

Node.js/Express REST API for the Wolde Driving School React/Vite frontend.

The production database layer is **Supabase PostgreSQL**. The running API no
longer uses SQLite. The route/API contracts remain compatible with the existing
frontend, including registration, login, programs, bookings, appointments,
payments, contact messages, dashboard, availability, and admin operations.

## Stack

- **Express** — HTTP API
- **PostgreSQL / Supabase** — persistent application database
- **pg** — PostgreSQL connection pool
- **bcryptjs** — password hashing
- **jsonwebtoken** — authentication tokens
- **zod** — request validation
- **Stripe / PayPal** — payment providers

## Install and configure

```bash
cd backend
npm install
cp .env.example .env
```

Set these values in `.env`:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
JWT_SECRET=your-long-random-secret
FRONTEND_URL=https://your-frontend.example
CORS_ORIGIN=https://your-frontend.example
```

`DATABASE_URL` is the important change from the previous SQLite version.

## Database setup

The backend initializes the PostgreSQL tables automatically on startup.
The same schema is also available at:

```text
supabase/schema.sql
```

You can paste that file into the Supabase SQL Editor if you prefer to create
the schema manually.

Then seed the application data:

```bash
npm run seed
```

The seed creates/updates the program catalog, courses, instructors, FAQs,
settings, sample availability, and the configured admin account.

## Run

```bash
npm start
```

The default API port is `4000`.

For local development, run the frontend separately and set its
`VITE_API_URL` to the backend URL.

## Migrating the old SQLite database

The original project contained `backend/data/wds.db`. That file is **not**
included in the new package because it may contain student records and
password hashes.

Keep the original database privately and run:

```bash
DATABASE_URL="postgresql://..." \
SQLITE_PATH="path/to/wds.db" \
npm run migrate:sqlite
```

The migration utility:

- creates the PostgreSQL schema;
- copies the existing records in foreign-key order;
- preserves existing numeric IDs;
- advances PostgreSQL sequences after import;
- does not overwrite conflicting PostgreSQL rows.

The migration utility uses `better-sqlite3` only as a development-time tool;
the running API does not depend on SQLite.

## Security

The previous archive contained server-side credentials and a JWT secret.
Treat those values as exposed and rotate them before production deployment.
Never commit `backend/.env`.

The browser may receive a Stripe **publishable** key, but Stripe secret keys,
PayPal client secrets, JWT secrets, and the PostgreSQL connection string must
remain server-side.

## API reference

All request/response bodies are JSON. Authenticated routes expect
`Authorization: Bearer <token>`.

### Auth
| Method | Path                | Auth | Body                                                          | Notes |
|--------|----------------------|------|----------------------------------------------------------------|-------|
| POST   | `/api/auth/register` | —    | `{ name, email, phone, password, courseId? }`                 | Returns `{ token, user }`. 409 if email taken. |
| POST   | `/api/auth/login`    | —    | `{ email, password }`                                          | Returns `{ token, user }`. |
| GET    | `/api/auth/me`       | ✔    | —                                                                | Current user. |
| POST   | `/api/auth/enroll`   | ✔    | `{ courseId }`                                                  | Sets the user's enrolled course. |

### Courses / Instructors
| Method | Path                  | Auth | Notes |
|--------|------------------------|------|-------|
| GET    | `/api/courses`         | —    | List all courses. |
| GET    | `/api/courses/:id`     | —    | Single course (for `CourseDetail.tsx`). |
| GET    | `/api/instructors`     | —    | List all instructors. |
| GET    | `/api/instructors/:id` | —    | Single instructor. |

### Bookings (`Book.tsx`)
| Method | Path                     | Auth        | Body / Notes |
|--------|---------------------------|-------------|--------------|
| POST   | `/api/bookings`           | optional    | `{ name, phone, email, course, instructor?, date, time }` |
| GET    | `/api/bookings/me`        | ✔           | Current student's bookings. |
| GET    | `/api/bookings`           | ✔ admin     | All bookings. |
| PATCH  | `/api/bookings/:id/status`| ✔ admin     | `{ status: pending\|confirmed\|cancelled\|completed }` |

### Payments (`Payment.tsx`)
| Method | Path               | Auth    | Body / Notes |
|--------|---------------------|---------|--------------|
| POST   | `/api/payments`     | ✔       | `{ courseId, amount: deposit\|full\|balance, cardname, card, exp, cvc }`. Demo only — stores only the card's last 4 digits, never the full number; also enrolls the user in `courseId`. |
| GET    | `/api/payments/me`  | ✔       | Current student's payment history. |
| GET    | `/api/payments`     | ✔ admin | All payments. |

### Contact (`Contact.tsx`)
| Method | Path            | Auth    | Notes |
|--------|------------------|---------|-------|
| POST   | `/api/contact`   | —       | `{ name, email, phone?, message }` |
| GET    | `/api/contact`   | ✔ admin | List submitted messages. |

### Dashboard (`Dashboard.tsx`)
| Method | Path             | Auth | Notes |
|--------|-------------------|------|-------|
| GET    | `/api/dashboard`  | ✔    | Returns `{ user, course, progress, lessons }` in one call. |

## Making an admin user

Every registered user defaults to `role = 'student'`. To promote one to
`admin` (so it can hit the admin-only endpoints), run:

```bash
sqlite3 data/wolde.db "UPDATE users SET role = 'admin' WHERE email = 'you@example.com';"
```

## Wiring up the existing React frontend

The frontend currently fakes all of this with `localStorage` in
`src/context/AuthContext.tsx` and local component state in `Book.tsx`,
`Payment.tsx`, and `Contact.tsx`. To connect it to this backend:

1. Set `CORS_ORIGIN` in `.env` to the Vite dev server URL (default
   `http://localhost:5173`).
2. Replace the `localStorage` calls in `AuthContext.tsx` with `fetch` calls to
   `/api/auth/register`, `/api/auth/login`, and `/api/auth/enroll`, storing
   the returned `token` (e.g. in memory + `sessionStorage`) and attaching it
   as `Authorization: Bearer <token>` on subsequent requests.
2. Point `Book.tsx`, `Payment.tsx`, and `Contact.tsx`'s `onSubmit` handlers at
   `POST /api/bookings`, `POST /api/payments`, and `POST /api/contact`
   respectively, instead of just calling `setOk(true)`/`setDone(true)`.
3. Replace the hardcoded `courses`/`instructors` imports from `src/data.ts` on
   `Courses.tsx`, `CourseDetail.tsx`, and `Instructors.tsx` with a `fetch` to
   `/api/courses` / `/api/instructors` (or keep `data.ts` as a static fallback
   and use the API once available).

I did not modify the frontend itself — only added this backend — since the
request was specifically for the backend, tables, and database.


## Supabase / PostgreSQL setup

The backend now uses Supabase PostgreSQL through the `pg` driver. SQLite is no longer used by the running API.

1. Create or open the Supabase project.
2. In Supabase, open **Connect** and copy a PostgreSQL connection string.
3. Put it in `backend/.env` as `DATABASE_URL`.
4. Run the schema in `supabase/schema.sql` (the backend also initializes the same schema on startup).
5. Run `npm install` in `backend`.
6. Run `npm run seed` to create/update programs, FAQs, settings, sample availability, and the admin account.
7. Start the API with `npm start`.

### Migrating the old SQLite data

The original SQLite database is intentionally not shipped in the new package because it may contain personal student data and password hashes. Keep a copy of the original `backend/data/wds.db` privately.

To migrate that existing database:

```bash
cd backend
npm install
DATABASE_URL="postgresql://..." SQLITE_PATH="path/to/wds.db" npm run migrate:sqlite
```

The migration utility creates the PostgreSQL schema and copies the existing records in foreign-key order. It does not overwrite conflicting PostgreSQL rows.

### Important security step

The previous project archive contained server-side payment credentials and a JWT secret. Treat those values as compromised and rotate them before production use. Do not commit `backend/.env`.
