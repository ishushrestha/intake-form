import { createClient, type Client, type InArgs, type Row } from "@libsql/client";
import { Context, Effect, Layer } from "effect";
import { AppConfigService } from "./services.js";
import { StorageError } from "./errors.js";

const CREATE_SUBMISSIONS = `
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  address TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'verified', 'approved', 'rejected',
    'queued', 'processing', 'sent_to_records', 'id_not_found', 'failed'
  )),
  image_filename TEXT NOT NULL,
  image_mime_type TEXT NOT NULL,
  image_size_bytes INTEGER NOT NULL,
  image_storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  rejected_at TEXT,
  approved_at TEXT,
  worker_message TEXT,
  records_request_id TEXT,
  processing_started_at TEXT
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS submissions_status_created_at
  ON submissions (status, created_at DESC)`;

const CREATE_ENTRY_REQUESTS = `
CREATE TABLE IF NOT EXISTS entry_requests (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verifying', 'done', 'failed', 'rejected')),
  artist_id TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT,
  entry_id TEXT,
  failure_reason TEXT,
  screenshot_path TEXT,
  verify_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_ENTRY_REQUESTS_INDEX = `
CREATE INDEX IF NOT EXISTS entry_requests_status_created_at
  ON entry_requests (status, created_at DESC)`;

const OPTIONAL_COLUMNS = [
  "verified_at",
  "rejected_at",
  "approved_at",
  "worker_message",
  "records_request_id",
  "processing_started_at",
] as const;

async function columnNames(client: Client): Promise<Set<string>> {
  const info = await client.execute("PRAGMA table_info(submissions)");
  return new Set(info.rows.map((row) => String(row.name)));
}

async function migrate(client: Client): Promise<void> {
  await client.execute(CREATE_SUBMISSIONS);
  const existing = await columnNames(client);
  for (const column of OPTIONAL_COLUMNS) {
    if (!existing.has(column)) {
      await client.execute(`ALTER TABLE submissions ADD COLUMN ${column} TEXT`);
    }
  }

  const master = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'submissions'",
  );
  const sql = String(master.rows[0]?.sql ?? "");
  if (!sql.includes("'queued'")) {
    await client.execute("DROP TABLE IF EXISTS submissions_next");
    await client.execute("BEGIN");
    try {
      await client.execute(CREATE_SUBMISSIONS.replace("CREATE TABLE IF NOT EXISTS submissions", "CREATE TABLE submissions_next"));
      await client.execute(`
        INSERT INTO submissions_next (
          id, first_name, last_name, address, external_id, status,
          image_filename, image_mime_type, image_size_bytes, image_storage_path,
          created_at, updated_at, verified_at, rejected_at, approved_at,
          worker_message, records_request_id, processing_started_at
        )
        SELECT
          id, first_name, last_name, address, external_id, status,
          image_filename, image_mime_type, image_size_bytes, image_storage_path,
          created_at, updated_at, verified_at, rejected_at, approved_at,
          worker_message, records_request_id, processing_started_at
        FROM submissions
      `);
      await client.execute("DROP TABLE submissions");
      await client.execute("ALTER TABLE submissions_next RENAME TO submissions");
      await client.execute("COMMIT");
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    }
  }
  await client.execute(CREATE_INDEX);
  await client.execute(CREATE_ENTRY_REQUESTS);
  await client.execute(CREATE_ENTRY_REQUESTS_INDEX);
}

export class Database extends Context.Service<
  Database,
  {
    readonly execute: (sql: string, args?: InArgs) => Effect.Effect<readonly Row[], StorageError>;
  }
>()("intake/Database") {}

export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const client: Client = createClient({ url: config.databaseUrl });
    yield* Effect.tryPromise({
      try: () => migrate(client),
      catch: (cause) => new StorageError({ cause }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));

    return {
      execute: (sql, args) =>
        Effect.tryPromise({
          try: async () => {
            const result = await client.execute({ sql, args });
            return result.rows;
          },
          catch: (cause) => new StorageError({ cause }),
        }),
    };
  }),
);
