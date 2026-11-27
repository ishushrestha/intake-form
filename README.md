# Intake

Version 0.5.0

Public intake form for record submissions, plus a password-protected admin desk in the same app and database. Someone fills in a name, address, image, and the record ID from a separate records system. This service stores the submission as `pending` in its own SQLite database and keeps the image on disk. An administrator can verify or reject it. A verified submission can be queued for the record manager. A worker checks the fields with Ollama and saves a pending LLM entry request. An administrator reviews those requests, then Verify uses Playwright to type them into the records-admin web UI. Reject never opens records-admin. Local development still runs that worker on the Windows PC. Production on Azure runs it in Docker next to the apps.

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

That process listens on `HOST`:`PORT` (default `127.0.0.1:3001`). On Azure, Caddy in Docker is in front of it for HTTPS.

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
| `NODE_ENV` | unset | `production` requires a strong `ADMIN_PASSWORD`, Secure cookies, trusted proxy headers (loopback and private Docker networks), and the web build |
| `DATABASE_URL` | `file:./data/intake.db` | libsql/Turso-compatible SQLite URL |
| `UPLOAD_DIR` | `./data/uploads` | Directory for stored images |
| `WEB_DIST` | `../web/dist` in production | Directory of the Vite build served by `pnpm start` |
| `WEB_ORIGIN` | `http://localhost:5173` | Browser origin allowed to call the API directly. Comma-separated list is allowed; use the public https origin in production |
| `ALLOWED_ORIGINS` | unset | Optional CORS list. When set, this replaces `WEB_ORIGIN` for allowed origins |
| `ADMIN_PASSWORD` | unset | Shared admin password. Login stays closed until this is set. In production it must be at least 12 characters and must not be `change-me` |
| `SESSION_SECRET` | random at startup | HMAC key for the admin session cookie |
| `WORKER_TOKEN` | unset | Bearer token for `/api/worker`. The same value is `INTAKE_WORKER_TOKEN` in the worker. The worker API stays closed until this is set |

With the defaults, the database file is `apps/api/data/intake.db` and images are `apps/api/data/uploads`. Screenshots from Verify are `apps/api/data/screenshots`. Those directories are created on startup and are gitignored.

The admin password is hashed in memory with scrypt when the API starts and compared in constant time. It is not written to the database. A successful login sets an httpOnly session cookie that expires after eight hours (`SameSite=Lax`; `Secure` when `NODE_ENV=production`). Repeated failed attempts are rate limited. In production the API also trusts `X-Forwarded-*` headers from loopback and private Docker networks (Caddy in front of the app). Azure production secrets live in `deploy/.env` (copy `deploy/.env.example`); they are not required for local `pnpm dev`.

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

The worker for local development runs only on the Windows PC with the NVIDIA GPU (under 8 GB of VRAM; `qwen2.5:3b` is the default model). It does not open a port. It only calls the hosts in `INTAKE_API_URL`, `RECORDS_ADMIN_URL`, and `OLLAMA_URL` (https intake and records-admin URLs are allowed). Any other host is refused. If `OLLAMA_URL` is not a loopback address (or a Docker Compose service name such as `ollama`), the worker exits instead of starting. Existing local `.env` files keep working: leave `OLLAMA_URL=http://127.0.0.1:11434`.

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

## Deploy on the Azure VM (Docker)

Everything runs on one Ubuntu VM in Docker Compose: intake, records-admin, the worker, Ollama, and Caddy. Only Caddy publishes ports (80, 443, 8443). Local `pnpm dev` / `pnpm worker` on the Windows PC is unchanged.

Do these steps one at a time. The SSH private key never goes in the repo or in chat.

1. From Windows Command Prompt, SSH in (replace the key path if yours is different):

```cmd
ssh -i C:\path\to\key.pem azureuser@artist-lab.southindia.cloudapp.azure.com
```

If Windows says the key permissions are too open:

```cmd
icacls C:\path\to\key.pem /inheritance:r
icacls C:\path\to\key.pem /grant:r %USERNAME%:R
```

Then run the `ssh` command again.

2. On the VM, add 4 GB of swap if it is missing:

```bash
free -h
```

If there is no swap, run:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

3. Install Docker Engine and the Compose plugin:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker azureuser
```

Log out of SSH and log back in so the `docker` group applies. Check:

```bash
docker compose version
```

4. Clone both repos side by side in your home directory. records-admin must be a sibling of intake-form (compose builds it from `../../records-admin`).

```bash
cd ~
git clone https://github.com/ishushrestha/intake-form.git
git clone https://github.com/ishushrestha/records-admin.git
cd ~/records-admin
git checkout cursor/vps-https-caddy-4b05
cd ~/intake-form
```

Compose builds records-admin from `~/records-admin` (its Dockerfile is on `cursor/vps-https-caddy-4b05`). The image stores SQLite and uploads under `/data`.

5. Create `deploy/.env`. Secrets never go in git.

```bash
cd ~/intake-form
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Generate values:

```bash
openssl rand -base64 24
```

Run that several times. Put one result in `ADMIN_PASSWORD` (12+ characters, not `change-me`), one in `SESSION_SECRET`, one in `WORKER_TOKEN`, one in `RECORDS_ADMIN_PASSWORD` (12+ characters, not `change-me`), and one in `RECORDS_ADMIN_SESSION_SECRET`. Set `RECORDS_ADMIN_USER` to something other than `admin`.

Create the shared tester password hash:

```bash
docker run --rm caddy:2-alpine caddy hash-password
```

Paste the printed hash into `BASIC_AUTH_HASH`. Leave `BASIC_AUTH_USER=tester` unless you want a different tester name. Leave `DOMAIN=artist-lab.southindia.cloudapp.azure.com` unless DevOps has remapped DNS.

6. Build images **one at a time** so the 4 GB VM does not run out of memory. From `~/intake-form/deploy`:

```bash
cd ~/intake-form/deploy
docker compose build intake
docker compose build records-admin
docker compose build worker
```

7. Start the stack, then pull the Ollama model (this is large; wait for it to finish):

```bash
docker compose up -d
docker compose exec ollama ollama pull qwen2.5:3b
```

8. Check that containers are up:

```bash
docker compose ps
docker compose logs --tail=50
```

Intake is https://artist-lab.southindia.cloudapp.azure.com (browser asks for the tester login, then the form; admin is `/admin`). records-admin is https://artist-lab.southindia.cloudapp.azure.com:8443.

9. Ports DevOps must open: **80**, **443**, and **8443** from the internet. **22** only from your IP (or a bastion). Do not open 3001, 3002, or 11434.

10. Update later:

```bash
cd ~/intake-form && git pull
cd ~/records-admin && git pull
cd ~/intake-form/deploy
docker compose build intake
docker compose build records-admin
docker compose build worker
docker compose up -d
```

If DevOps remaps the DNS name, change `DOMAIN` in `deploy/.env` and run `docker compose up -d` again. Caddy will request a new certificate.

11. Stop:

```bash
cd ~/intake-form/deploy
docker compose down
```

Volumes keep the SQLite databases, uploads, Ollama models, and Caddy certificates. `docker compose down -v` deletes that data.

## Version history

- 0.5.0 — Bind localhost by default, require a strong production admin password, Secure cookies and CORS for HTTPS, serve web+API with `pnpm start`, and deploy on Azure with Docker Compose + Caddy.
- 0.4.0 — LLM maps queued submissions into pending entry requests. An admin verifies them in the records-admin web UI through Playwright, or rejects them.
- 0.3.0 — Queue verified submissions and send them to records-admin through a local Ollama worker.
- 0.2.3 — Add a visible Back to submissions button on the admin detail page.
- 0.2.2 — Fix admin list clicks so a row, its name link, and Enter open the submission.
- 0.2.1 — Fix JSON responses so Node's strict Content-Length check does not drop them.
- 0.2.0 — Admin review: shared-password session, submission list and detail, verify and approve.
- 0.1.0 — Initial public intake form, submission API, and SQLite storage.
