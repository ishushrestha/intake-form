# Intake

Version 0.1.0

Public intake form for record submissions. Someone fills in a name, address, image, and the record ID from a separate records system. This service stores the submission as `pending` in its own SQLite database and keeps the image on disk. Review states (`verified`, `approved`, `rejected`) are part of the record so an admin panel and a later handoff can be added without reshaping the data. There is no admin UI in this version.

The API is an [Effect](https://effect.website) HTTP service on Node, which is the house default for this stack. Uploaded files are parsed with Effect's multipart support, checked again on the server, and written under a configurable directory.

## Run locally

Requirements: Node.js 22 or newer, and pnpm 10.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

- Form: http://localhost:5173
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

With the defaults, the database file is `apps/api/data/intake.db` and images are `apps/api/data/uploads`. Both directories are created on startup and are gitignored.

## HTTP API

- `POST /api/submissions` — multipart fields `firstName`, `lastName`, `address`, `externalId`, and `image`. New rows start as `pending`.
- `GET /api/submissions` — list submissions, newest first. Optional `status` filter: `pending`, `verified`, `approved`, or `rejected`.
- `GET /api/submissions/:id` — one submission.
- `GET /api/submissions/:id/image` — the stored image.
- `GET /api/health` — `{ "ok": true }`.

These read endpoints are open in this proof of concept. The admin panel should gate them later.

The record ID is trimmed and limited to letters, numbers, and `.` `_` `-`. It is not looked up in the other system.

Images must be JPEG, PNG, or WebP, at most 5 MB. The server checks the file bytes, not only the browser-supplied type.

## Version history

- 0.1.0 — Initial public intake form, submission API, and SQLite storage.
