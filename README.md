# Intake

Version 0.3.0

Public intake form for record submissions, plus a password-protected admin desk in the same app and database. Someone fills in a name, address, image, and the record ID from a separate records system. This service stores the submission as `pending` in its own SQLite database and keeps the image on disk. An administrator can verify or reject it. A verified submission can be queued for the record manager. A local worker on the reviewer's Windows PC checks the fields with Ollama, then posts the entry to records-admin.

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
pnpm check-version
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
| `WORKER_TOKEN` | unset | Bearer token for `/api/worker`. The same value is `INTAKE_WORKER_TOKEN` in the worker. The worker API stays closed until this is set |

With the defaults, the database file is `apps/api/data/intake.db` and images are `apps/api/data/uploads`. Both directories are created on startup and are gitignored.

The admin password is hashed in memory with scrypt when the API starts and compared in constant time. It is not written to the database. A successful login sets an httpOnly session cookie that expires after eight hours. Repeated failed attempts are rate limited.

## HTTP API

- `POST /api/submissions` — public. Multipart fields `firstName`, `lastName`, `address`, `externalId`, and `image`. New rows start as `pending`.
- `POST /api/admin/login` — JSON `{ "password" }`. Sets the session cookie.
- `POST /api/admin/logout` — clears the session cookie.
- `GET /api/admin/session` — `200` when the session is valid.
- `GET /api/submissions` — admin cookie only. Newest first. Optional `status` and `q` (name or record ID).
- `GET /api/submissions/:id` — admin cookie only.
- `GET /api/submissions/:id/image` — admin cookie only.
- `POST /api/submissions/:id/verify` — admin cookie only. `pending` → `verified`.
- `POST /api/submissions/:id/reject` — admin cookie only. `pending` → `rejected`.
- `POST /api/submissions/:id/approve` — admin cookie only. `verified` → `approved`, and records `approvedAt`.
- `POST /api/admin/submissions/:id/submit-to-records` — admin cookie only. `verified`, `id_not_found`, or `failed` → `queued`.
- `POST /api/worker/jobs/claim` — `Authorization: Bearer $WORKER_TOKEN` only. Claims one queued job, or a job left in `processing` for more than 10 minutes, and returns `{ id, firstName, lastName, address, recordId, imageUrl }`. `204` when nothing is waiting. `503` when `WORKER_TOKEN` is unset.
- `GET /api/worker/jobs/:id/image` — the same bearer token. The claim's `imageUrl` is this path, which the worker resolves against `INTAKE_API_URL`.
- `POST /api/worker/jobs/:id/result` — the same bearer token. JSON `{ outcome: "sent" | "id_not_found" | "failed", message?, recordsRequestId? }` moves a `processing` job to `sent_to_records`, `id_not_found`, or `failed`.
- `GET /api/health` — `{ "ok": true }`.

The admin cookie does not authenticate worker routes, and the worker token does not authenticate admin routes. Statuses shown in the list and detail are `pending`, `verified`, `approved`, `rejected`, `queued`, `processing`, `sent_to_records`, `id_not_found`, and `failed`. `id_not_found` and `failed` keep the worker's message and can be queued again.

The record ID is trimmed and limited to letters, numbers, and `.` `_` `-`. Intake does not look it up; the worker asks records-admin.

Images must be JPEG, PNG, or WebP, at most 5 MB. The server checks the file bytes, not only the browser-supplied type.

## Local worker (Windows)

The worker runs only on the Windows PC with the NVIDIA GPU (under 8 GB of VRAM; `qwen2.5:3b` is the default model). It does not open a port, and it only calls the intake API, records-admin, and Ollama on this machine. Any other host is refused. If `OLLAMA_URL` is not a loopback address, the worker exits instead of starting.

Ollama itself must listen on loopback. In cmd:

```bat
winget install -e --id Ollama.Ollama
ollama pull qwen2.5:3b
setx OLLAMA_HOST 127.0.0.1
```

Close and reopen cmd so `OLLAMA_HOST` is picked up, then start Ollama. On this PC, http://127.0.0.1:11434 should answer. From another machine, it should not.

Generate two tokens. Run this twice:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Token A is shared by intake and the worker:

- intake-form `.env`: `WORKER_TOKEN=<token A>`
- `apps/llm-worker/.env`: `INTAKE_WORKER_TOKEN=<token A>`

Token B is shared by records-admin and the worker:

- records-admin `.env`: `WORKER_TOKEN=<token B>`
- `apps/llm-worker/.env`: `RECORDS_WORKER_TOKEN=<token B>`

Copy `apps/llm-worker/.env.example` to `apps/llm-worker/.env` and fill in both tokens. Leave the URLs on this PC:

```bat
INTAKE_API_URL=http://127.0.0.1:3001
RECORDS_API_URL=http://127.0.0.1:3002
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
POLL_SECONDS=5
```

Start the services in this order, each in its own cmd window:

1. Ollama, already running from the step above.
2. records-admin, API on port 3002.
3. intake-form: `pnpm dev`
4. the worker, from this repo: `pnpm worker`

In the admin detail page, mark a submission verified, then choose **Submit to record manager**. The worker claims it, asks Ollama for strict JSON at temperature 0, and checks that output against the original submission. The record ID must match exactly. Names and the address cannot gain words. On a mismatch the worker sends the original values and records a note. It then calls records-admin:

- `GET /api/worker/artists/:recordId` with `Authorization: Bearer <token B>` returns `200 { "id", "name" }` or `404`.
- `404` is reported back to intake as `id_not_found`.
- `200` is followed by `POST /api/worker/entry-requests` as multipart fields `artistId`, `firstName`, `lastName`, `address`, `image`, `sourceSubmissionId`, and `llmNotes`. A `201 { "id", "status" }` is reported as `sent_to_records` with that id. The records side treats `sourceSubmissionId` as idempotent.
- A network error is reported as `failed` with a message. An admin can queue `failed` and `id_not_found` again.

## Version history

- 0.3.0 — Queue verified submissions and send them to records-admin through a local Ollama worker.
- 0.2.3 — Add a visible Back to submissions button on the admin detail page.
- 0.2.2 — Fix admin list clicks so a row, its name link, and Enter open the submission.
- 0.2.1 — Fix JSON responses so Node's strict Content-Length check does not drop them.
- 0.2.0 — Admin review: shared-password session, submission list and detail, verify and approve.
- 0.1.0 — Initial public intake form, submission API, and SQLite storage.
