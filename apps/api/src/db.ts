import { createClient, type Client, type InArgs, type Row } from "@libsql/client";
import { Context, Effect, Layer } from "effect";
import { AppConfigService } from "./services.js";
import { StorageError } from "./errors.js";

const MIGRATIONS = [
  `
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  address TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'approved', 'rejected')),
  image_filename TEXT NOT NULL,
  image_mime_type TEXT NOT NULL,
  image_size_bytes INTEGER NOT NULL,
  image_storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `
CREATE INDEX IF NOT EXISTS submissions_status_created_at
  ON submissions (status, created_at DESC)`,
];

const REVIEW_COLUMNS = ["verified_at", "rejected_at", "approved_at"] as const;

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
    const executeStatement = (statement: string) =>
      Effect.tryPromise({
        try: () => client.execute(statement),
        catch: (cause) => new StorageError({ cause }),
      });

    for (const statement of MIGRATIONS) {
      yield* executeStatement(statement);
    }

    const info = yield* executeStatement("PRAGMA table_info(submissions)");
    const existing = new Set(info.rows.map((row) => String(row.name)));
    for (const column of REVIEW_COLUMNS) {
      if (!existing.has(column)) {
        yield* executeStatement(`ALTER TABLE submissions ADD COLUMN ${column} TEXT`);
      }
    }
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
