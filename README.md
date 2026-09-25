# Wolde Driving School — Backend API

A Node.js/Express + SQLite backend for the `wolde` frontend (React/Vite app for
Wolde Driving School). It replaces the frontend's `localStorage`-based
`AuthContext` with a real database and REST API, and adds tables/endpoints for
every form in the app: registration, login, course browsing, instructor
listing, lesson booking, payments, contact messages, and the student
dashboard.

## Stack
- **Express** — HTTP API
- **better-sqlite3** — embedded SQL database (single file, zero setup — swap
  for Postgres/MySQL later without changing the route logic much)
- **bcryptjs** — password hashing
- **jsonwebtoken** — auth tokens
- **zod** — request validation

## 1. Install & configure

```bash
cd wolde-backend
npm install
cp .env.example .env
# edit .env and set a real JWT_SECRET, and CORS_ORIGIN to your frontend's URL
```

## 2. Create the database and seed courses/instructors

The database file and all tables are created automatically the first time the
server (or seed script) runs — no manual migration step needed.

```bash
npm run seed
```

This populates the `courses` and `instructors` tables with the same data as
the frontend's `src/data.ts`, so `/api/courses` and `/api/instructors` match
what the site currently shows from the hardcoded array.

## 3. Run the server

```bash
npm start        # production
npm run dev       # auto-restart on file change
```

Server listens on `http://localhost:4000` by default (`PORT` in `.env`).

## Database schema

SQLite file at `data/wolde.db` (created automatically). Tables, defined in
`src/db/schema.sql`:

| Table              | Purpose                                                          |
|--------------------|-------------------------------------------------------------------|
| `courses`          | Course catalog (id, name, level, lessons, hours, price, includes) |
| `instructors`      | Instructor roster                                                  |
| `users`            | Student accounts (hashed passwords, optional enrolled `course_id`) |
| `bookings`         | Lesson booking requests from the **Book a lesson** form            |
| `payments`         | Payment records from the **Payment** form (demo — no real charges) |
| `contact_messages` | Submissions from the **Contact** form                              |
| `lessons`          | Scheduled lessons shown on the **Dashboard**                       |

Foreign keys tie `bookings`/`payments`/`lessons` back to `users` and
`courses`/`instructors`, so deleting a course is restricted while it still has
bookings/payments, and deleting a user cascades its lessons but keeps its
bookings/payments as historical records (`user_id` set to NULL).

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
