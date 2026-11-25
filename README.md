# Intake

Version 0.2.0

Public intake form for record submissions, plus a password-protected admin desk in the same app and database. Someone fills in a name, address, image, and the record ID from a separate records system. This service stores the submission as `pending` in its own SQLite database and keeps the image on disk. An administrator can verify or reject it, then approve a verified submission. Approval is the point where a later LLM handoff will update the record in the other system. That call is not implemented yet.

The API is an [Effect](https://effect.website) HTTP service on Node, which is the house default for this stack. Uploaded files are parsed with Effect's multipart support, checked again on the server, and written under a configurable directory.

## Run locally

Requirements: Node.js 22 or newer, and pnpm 10.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Set `ADMIN_PASSWORD` in `.env` before using the admin desk. The sample value is `change-me`.

- Form: http://localhost:5173
- Admin: http://localhost:5173/admin
- API: http://127.0.0.1:3001

`pnpm dev` builds the shared contracts, then runs the Vite app and the API together. The dev server proxies `/api` to the API.

Other root scripts:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Environment

Copy `.env.example` to `.env` at the repo root. The API reads that file when it starts from `apps/api`. Relative paths are resolved from `apps/api`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `DATABASE_URL` | `file:./data/intake.db` | libsql/Turso-compatible SQLite URL |
| `UPLOAD_DIR` | `./data/uploads` | Directory for stored images |
| `WEB_ORIGIN` | `http://localhost:5173` | Browser origin allowed to call the API directly |
| `ADMIN_PASSWORD` | unset | Shared admin password. Login stays closed until this is set |
| `SESSION_SECRET` | random at startup | HMAC key for the admin session cookie |

With the defaults, the database file is `apps/api/data/intake.db` and images are `apps/api/data/uploads`. Both directories are created on startup and are gitignored.

The admin password is hashed in memory with scrypt when the API starts and compared in constant time. It is not written to the database. A successful login sets an httpOnly session cookie that expires after eight hours. Repeated failed attempts are rate limited.

## HTTP API

- `POST /api/submissions` — public. Multipart fields `firstName`, `lastName`, `address`, `externalId`, and `image`. New rows start as `pending`.
- `POST /api/admin/login` — JSON `{ "password" }`. Sets the session cookie.
- `POST /api/admin/logout` — clears the session cookie.
- `GET /api/admin/session` — `200` when the session is valid.
- `GET /api/submissions` — admin only. Newest first. Optional `status` (`pending`, `verified`, `approved`, `rejected`) and `q` (name or record ID).
- `GET /api/submissions/:id` — admin only.
- `GET /api/submissions/:id/image` — admin only.
- `POST /api/submissions/:id/verify` — admin only. `pending` → `verified`.
- `POST /api/submissions/:id/reject` — admin only. `pending` → `rejected`.
- `POST /api/submissions/:id/approve` — admin only. `verified` → `approved`, and records `approvedAt`. This is the function the LLM handoff will plug into.
- `GET /api/health` — `{ "ok": true }`.

Any other status change is refused. The record ID is trimmed and limited to letters, numbers, and `.` `_` `-`. It is not looked up in the other system.

Images must be JPEG, PNG, or WebP, at most 5 MB. The server checks the file bytes, not only the browser-supplied type.

## Version history

- 0.2.0 — Admin review: shared-password session, submission list and detail, verify and approve.
- 0.1.0 — Initial public intake form, submission API, and SQLite storage.
