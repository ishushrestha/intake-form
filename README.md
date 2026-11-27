# Intake

Version 0.5.0

Public intake form for record submissions, plus a password-protected admin desk in the same app and database. Someone fills in a name, address, image, and the record ID from a separate records system. This service stores the submission as `pending` in its own SQLite database and keeps the image on disk. An administrator can verify or reject it. A verified submission can be queued for the record manager. A local worker on the reviewer's Windows PC checks the fields with Ollama and saves a pending LLM entry request. An administrator reviews those requests, then Verify uses Playwright to type them into the records-admin web UI. Reject never opens records-admin.

The API is an [Effect](https://effect.website) HTTP service on Node, which is the house default for this stack. Uploaded files are parsed with Effect's multipart support, checked again on the server, and written under a configurable directory.

## Run locally

Requirements: Node.js 22 or newer, and pnpm 10.

From a Windows command prompt, in this folder:

```cmd
pnpm install
copy .env.example .env
pnpm dev
```

Set `ADMIN_PASSWORD` in `.env` before using the admin desk. The sample value is `change-me`.

- Form: http://localhost:5173
- Admin: http://localhost:5173/admin
- LLM entry requests: http://localhost:5173/admin/entry-requests
- API: http://127.0.0.1:3001

`pnpm dev` builds the shared contracts, then runs the Vite app and the API together. The dev server proxies `/api` to the API. Both listen on `127.0.0.1` by default (`HOST` in `.env`).

To run a production build that serves the web UI and the API from one Node process:

```cmd
pnpm build
pnpm start
```

That process listens on `HOST`:`PORT` (default `127.0.0.1:3001`). Put Caddy in front of it for HTTPS.

Other root scripts:

```cmd
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start
pnpm check-version
```

## Environment

Copy `.env.example` to `.env` at the repo root. The API reads that file when it starts from `apps/api`. Relative paths are resolved from `apps/api`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address for the API (and for `pnpm dev` / `pnpm preview`) |
| `PORT` | `3001` | API port. In production this process also serves the web UI |
| `NODE_ENV` | unset | `production` requires a strong `ADMIN_PASSWORD`, Secure cookies, trusted loopback proxy headers, and the web build |
| `DATABASE_URL` | `file:./data/intake.db` | libsql/Turso-compatible SQLite URL |
| `UPLOAD_DIR` | `./data/uploads` | Directory for stored images |
| `WEB_DIST` | `../web/dist` in production | Directory of the Vite build served by `pnpm start` |
| `WEB_ORIGIN` | `http://localhost:5173` | Browser origin allowed to call the API directly. Comma-separated list is allowed; use the public https origin on a VPS |
| `ALLOWED_ORIGINS` | unset | Optional CORS list. When set, this replaces `WEB_ORIGIN` for allowed origins |
| `ADMIN_PASSWORD` | unset | Shared admin password. Login stays closed until this is set. In production it must be at least 12 characters and must not be `change-me` |
| `SESSION_SECRET` | random at startup | HMAC key for the admin session cookie |
| `WORKER_TOKEN` | unset | Bearer token for `/api/worker`. The same value is `INTAKE_WORKER_TOKEN` in the worker. The worker API stays closed until this is set |

With the defaults, the database file is `apps/api/data/intake.db` and images are `apps/api/data/uploads`. Screenshots from Verify are `apps/api/data/screenshots`. Those directories are created on startup and are gitignored.

The admin password is hashed in memory with scrypt when the API starts and compared in constant time. It is not written to the database. A successful login sets an httpOnly session cookie that expires after eight hours (`SameSite=Lax`; `Secure` when `NODE_ENV=production`). Repeated failed attempts are rate limited. In production the API also trusts `X-Forwarded-*` headers from loopback (Caddy on the same machine).

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
- `GET /api/admin/entry-requests` — admin cookie only. Newest first. Each row has status `pending`, `verifying`, `done`, `failed`, or `rejected`.
- `POST /api/admin/entry-requests/:id/verify` — admin cookie only. Marks a `pending` or `failed` request so the worker may type it. Status becomes `pending` until the worker claims it.
- `POST /api/admin/entry-requests/:id/reject` — admin cookie only. `pending` → `rejected`. The worker never opens records-admin for it.
- `GET /api/admin/entry-requests/:id/screenshot` — admin cookie only. PNG from the last Verify attempt.
- `POST /api/worker/jobs/claim` — `Authorization: Bearer $WORKER_TOKEN` only. Claims one queued job, or a job left in `processing` for more than 10 minutes, and returns `{ id, firstName, lastName, address, recordId, imageUrl }`. `204` when nothing is waiting. `503` when `WORKER_TOKEN` is unset.
- `GET /api/worker/jobs/:id/image` — the same bearer token. The claim's `imageUrl` is this path, which the worker resolves against `INTAKE_API_URL`.
- `POST /api/worker/jobs/:id/result` — the same bearer token. JSON `{ outcome: "sent" | "id_not_found" | "failed", message?, recordsRequestId? }` moves a `processing` job to `sent_to_records`, `id_not_found`, or `failed`.
- `POST /api/worker/entry-requests` — the same bearer token. JSON mapped fields. Creates a `pending` LLM entry request, or returns the existing one for that submission.
- `POST /api/worker/entry-requests/claim` — the same bearer token. Atomically moves one verify-requested `pending` request to `verifying`. `204` when none are waiting. A row left in `verifying` is not reclaimed.
- `GET /api/worker/entry-requests/:id/image` — the same bearer token. Image from the source submission.
- `POST /api/worker/entry-requests/:id/result` — the same bearer token. Multipart `outcome` (`done` or `failed`), optional `entryId`, `recordsArtistId`, and `message`, and a screenshot file.
- `GET /api/health` — `{ "ok": true }`.

The admin cookie does not authenticate worker routes, and the worker token does not authenticate admin routes. Statuses shown on submissions are `pending`, `verified`, `approved`, `rejected`, `queued`, `processing`, `sent_to_records`, `id_not_found`, and `failed`. `id_not_found` and `failed` keep the worker's message and can be queued again.

The record ID is trimmed and limited to letters, numbers, and `.` `_` `-`. Intake does not look it up. The worker maps it into a pending request. Verify later finds that artist in the records-admin UI. If the ID is missing, the request fails; it does not create a new artist.

Images must be JPEG, PNG, or WebP, at most 5 MB. The server checks the file bytes, not only the browser-supplied type.

## Local worker (Windows)

The worker runs only on the Windows PC with the NVIDIA GPU (under 8 GB of VRAM; `qwen2.5:3b` is the default model). It does not open a port. It only calls the hosts in `INTAKE_API_URL`, `RECORDS_ADMIN_URL`, and `OLLAMA_URL` (https intake and records-admin URLs are allowed). Any other host is refused. If `OLLAMA_URL` is not a loopback address, the worker exits instead of starting.

Ollama itself must listen on loopback. In cmd:

```cmd
winget install -e --id Ollama.Ollama
ollama pull qwen2.5:3b
setx OLLAMA_HOST 127.0.0.1
```

Close and reopen cmd so `OLLAMA_HOST` is picked up, then start Ollama. On this PC, http://127.0.0.1:11434 should answer. From another machine, it should not.

Generate a token for intake and the worker:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put that value in both places:

```cmd
notepad .env
```

Set `WORKER_TOKEN` to the token.

If this is a new checkout:

```cmd
copy apps\llm-worker\.env.example apps\llm-worker\.env
```

If you already have `apps\llm-worker\.env` from v0.3.0, do not copy `.env.example` over it. That would drop `INTAKE_WORKER_TOKEN`. Add the new keys below, and delete `RECORDS_WORKER_TOKEN` and `RECORDS_API_URL`.

```cmd
notepad apps\llm-worker\.env
```

Set these keys in `apps\llm-worker\.env`:

```ini
INTAKE_API_URL=http://127.0.0.1:3001
INTAKE_WORKER_TOKEN=
RECORDS_ADMIN_URL=http://localhost:5174
RECORDS_ADMIN_USER=admin
RECORDS_ADMIN_PASSWORD=change-me
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
POLL_SECONDS=5
```

Paste the same token into `INTAKE_WORKER_TOKEN`. Leave `RECORDS_ADMIN_USER` and `RECORDS_ADMIN_PASSWORD` as the records-admin local login, or change them to match that app. Optional: add `HEADED=true` to show the browser while Playwright types.

When Caddy `basic_auth` sits in front of the public https sites, also set the optional tester login. The worker sends it as `Authorization` on fetch to intake, and as Playwright `httpCredentials` for records-admin:

```ini
INTAKE_BASIC_AUTH_USER=tester
INTAKE_BASIC_AUTH_PASS=
RECORDS_ADMIN_BASIC_AUTH_USER=tester
RECORDS_ADMIN_BASIC_AUTH_PASS=
```

Install the browser used by the worker:

```cmd
pnpm install
cd apps\llm-worker
pnpm exec playwright install chromium
cd ..\..
```

Start the services in this order, each in its own cmd window:

1. Ollama, already running from the step above.
2. records-admin, web UI on http://localhost:5174 (`pnpm dev` in that repo).
3. intake-form:

```cmd
pnpm dev
```

4. the worker, from this repo:

```cmd
pnpm worker
```

In the admin detail page, mark a submission verified, then choose **Submit to record manager**. The worker claims it, asks Ollama for strict JSON at temperature 0, and checks that output against the original submission. The record ID must match exactly. Names and the address cannot gain words. On a mismatch the worker saves the original values and records a note. It then stores a **pending** LLM entry request in this database. It does not call records-admin APIs, databases, or worker endpoints.

Open **LLM entry requests**. Verify and Reject are available while the request is pending. Failed requests show **Retry**.

- **Reject** marks it rejected. The worker never opens records-admin for it.
- **Verify** asks the worker to drive the records-admin pages like a person: log in, find the artist by Record ID, add the entry, then read the new entry ID and the artist ID actually used. If that Record ID is not on the Artists table, the request fails with `Artist <id> not found in records-admin` and no artist is created. An artist is created only when no Record ID was requested. The worker moves the row to `verifying` before it types. A row stuck in `verifying` is not retried. **Retry** on a failed request queues it again without creating a second row. Done stores the entry ID, the real artist ID, and a screenshot. Failed stores a reason and a screenshot. Both show on the review page.

Playwright network requests are limited to the same allowlist as the worker HTTP client: intake, Ollama, and the records-admin web origin.

## Run on a VPS (Ubuntu)

Do these steps one at a time. From Windows Command Prompt, SSH into the VPS, then run the Ubuntu commands there. Replace `USER`, the VPS IP, and the DuckDNS names with yours.

1. SSH in from Windows cmd:

```cmd
ssh USER@YOUR.VPS.IP
```

2. Allow only SSH and HTTPS through the firewall:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

3. Install Node.js LTS and pnpm (corepack):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
corepack prepare pnpm@10 --activate
node -v
pnpm -v
```

4. Clone this repo, install, and build:

```bash
git clone https://github.com/ishushrestha/intake-form.git
cd intake-form
pnpm install
pnpm build
```

5. Create `.env` with fresh tokens and strong passwords. Secrets never go in git.

```bash
cp .env.example .env
nano .env
```

Set at least:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
WEB_ORIGIN=https://YOUR-INTAKE.duckdns.org
ADMIN_PASSWORD=
SESSION_SECRET=
WORKER_TOKEN=
```

Generate values on the VPS:

```bash
openssl rand -base64 24
```

Run that a few times. Use one result for `ADMIN_PASSWORD` (12+ characters, not `change-me`), one for `SESSION_SECRET`, and one for `WORKER_TOKEN`. Copy `WORKER_TOKEN` to the worker `.env` on the Windows PC as `INTAKE_WORKER_TOKEN`.

6. Run the production process (builds the web UI and serves it with the API from one Node process):

```bash
pnpm build
pnpm start
```

Leave this until systemd is in place. Check http://127.0.0.1:3001/api/health on the VPS. It must not be reachable from the internet on port 3001.

7. Install a systemd service so it starts on boot. Create `/etc/systemd/system/intake.service` (adjust `User` and paths):

```ini
[Unit]
Description=intake-form
After=network.target

[Service]
Type=simple
User=USER
WorkingDirectory=/home/USER/intake-form
Environment=NODE_ENV=production
EnvironmentFile=/home/USER/intake-form/.env
Environment=PATH=/usr/bin:/usr/local/bin
ExecStart=/usr/bin/pnpm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now intake
sudo systemctl status intake
```

8. DuckDNS: in a browser, create two free subdomains that point at the VPS public IP, for example `YOUR-INTAKE.duckdns.org` (this app) and `YOUR-RECORDS.duckdns.org` (records-admin). Wait until they resolve.

9. Install Caddy and put it in front of both sites with automatic HTTPS and one shared tester login.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
caddy hash-password
```

`caddy hash-password` asks for the tester password and prints a hash. Put that hash in the Caddyfile below. Edit `/etc/caddy/Caddyfile`:

```caddy
YOUR-INTAKE.duckdns.org {
	basic_auth {
		tester "$2a$14$REPLACE_WITH_CADDY_HASH"
	}
	reverse_proxy 127.0.0.1:3001
}

YOUR-RECORDS.duckdns.org {
	basic_auth {
		tester "$2a$14$REPLACE_WITH_CADDY_HASH"
	}
	reverse_proxy 127.0.0.1:3002
}
```

Use the records-admin production port if it is not `3002`. Reload Caddy:

```bash
sudo systemctl reload caddy
```

Open `https://YOUR-INTAKE.duckdns.org` in a browser. The browser asks for the tester login, then the intake form. Admin is `/admin`.

10. On the Windows PC, point the worker at the https URLs. In `apps\llm-worker\.env`:

```ini
INTAKE_API_URL=https://YOUR-INTAKE.duckdns.org
INTAKE_WORKER_TOKEN=
INTAKE_BASIC_AUTH_USER=tester
INTAKE_BASIC_AUTH_PASS=
RECORDS_ADMIN_URL=https://YOUR-RECORDS.duckdns.org
RECORDS_ADMIN_USER=admin
RECORDS_ADMIN_PASSWORD=
RECORDS_ADMIN_BASIC_AUTH_USER=tester
RECORDS_ADMIN_BASIC_AUTH_PASS=
OLLAMA_URL=http://127.0.0.1:11434
```

`INTAKE_BASIC_AUTH_*` and `RECORDS_ADMIN_BASIC_AUTH_*` are the shared Caddy tester login. `RECORDS_ADMIN_USER` and `RECORDS_ADMIN_PASSWORD` stay the records-admin app login. Keep Ollama on loopback on this PC. Then `pnpm worker` as before.

## Version history

- 0.5.0 — Bind localhost by default, require a strong production admin password, Secure cookies and CORS for HTTPS, serve web+API with `pnpm start`, and document a VPS + Caddy setup.
- 0.4.0 — LLM maps queued submissions into pending entry requests. An admin verifies them in the records-admin web UI through Playwright, or rejects them.
- 0.3.0 — Queue verified submissions and send them to records-admin through a local Ollama worker.
- 0.2.3 — Add a visible Back to submissions button on the admin detail page.
- 0.2.2 — Fix admin list clicks so a row, its name link, and Enter open the submission.
- 0.2.1 — Fix JSON responses so Node's strict Content-Length check does not drop them.
- 0.2.0 — Admin review: shared-password session, submission list and detail, verify and approve.
- 0.1.0 — Initial public intake form, submission API, and SQLite storage.
