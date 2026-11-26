import { randomUUID } from "node:crypto";
import type { Row } from "@libsql/client";
import {
  entryRequestSchema,
  type CreateEntryRequestBody,
  type EntryRequest,
  type VerifyOutcome,
} from "@intake/contracts";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { Database } from "./db.js";
import { StorageError } from "./errors.js";
import { AppConfigService } from "./services.js";

export type RequestUpdate = EntryRequest | undefined | "conflict";

export interface StoredScreenshot {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ClaimedVerifyJob {
  readonly id: string;
  readonly submissionId: string;
  readonly artistId: string;
  readonly artistName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly address: string;
  readonly notes: string | null;
}

export class EntryRequests extends Context.Service<
  EntryRequests,
  {
    readonly create: (input: CreateEntryRequestBody) => Effect.Effect<EntryRequest | undefined, StorageError>;
    readonly list: () => Effect.Effect<readonly EntryRequest[], StorageError>;
    readonly get: (id: string) => Effect.Effect<EntryRequest | undefined, StorageError>;
    readonly requestVerify: (id: string) => Effect.Effect<RequestUpdate, StorageError>;
    readonly reject: (id: string) => Effect.Effect<RequestUpdate, StorageError>;
    readonly claimVerify: (now: Date) => Effect.Effect<ClaimedVerifyJob | undefined, StorageError>;
    readonly completeVerify: (
      id: string,
      outcome: VerifyOutcome,
      entryId: string | undefined,
      recordsArtistId: string | undefined,
      message: string | undefined,
      screenshot: { readonly bytes: Uint8Array; readonly mimeType: StoredScreenshot["mimeType"] } | undefined,
    ) => Effect.Effect<RequestUpdate, StorageError>;
    readonly readScreenshot: (id: string) => Effect.Effect<StoredScreenshot | undefined, StorageError>;
  }
>()("intake/EntryRequests") {}

const SELECT_LIST = `
  SELECT
    id, submission_id, status, artist_id, artist_name, first_name, last_name, address,
    notes, entry_id, records_artist_id, failure_reason, screenshot_path, verify_requested_at, created_at, updated_at
  FROM entry_requests
`;

function failStorage(cause: unknown): StorageError {
  return cause instanceof StorageError ? cause : new StorageError({ cause });
}

function requireString(row: Row, key: string): string | StorageError {
  const value = row[key];
  if (typeof value !== "string") {
    return new StorageError({ cause: `Expected text in ${key}` });
  }
  return value;
}

function optionalString(row: Row, key: string): string | null | StorageError {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return new StorageError({ cause: `Expected text in ${key}` });
}

function takeString(value: string | StorageError): string {
  if (value instanceof StorageError) {
    throw value;
  }
  return value;
}

function takeOptional(value: string | null | StorageError): string | null {
  if (value instanceof StorageError) {
    throw value;
  }
  return value;
}

function toEntryRequest(row: Row): EntryRequest | StorageError {
  try {
    const screenshotPath = takeOptional(optionalString(row, "screenshot_path"));
    const parsed = entryRequestSchema.safeParse({
      id: takeString(requireString(row, "id")),
      submissionId: takeString(requireString(row, "submission_id")),
      status: takeString(requireString(row, "status")),
      artistId: takeString(requireString(row, "artist_id")),
      artistName: takeString(requireString(row, "artist_name")),
      firstName: takeString(requireString(row, "first_name")),
      lastName: takeString(requireString(row, "last_name")),
      address: takeString(requireString(row, "address")),
      notes: takeOptional(optionalString(row, "notes")),
      entryId: takeOptional(optionalString(row, "entry_id")),
      recordsArtistId: takeOptional(optionalString(row, "records_artist_id")),
      failureReason: takeOptional(optionalString(row, "failure_reason")),
      screenshotAvailable: screenshotPath !== null && screenshotPath.length > 0,
      verifyRequestedAt: takeOptional(optionalString(row, "verify_requested_at")),
      createdAt: takeString(requireString(row, "created_at")),
      updatedAt: takeString(requireString(row, "updated_at")),
    });
    if (!parsed.success) {
      return new StorageError({ cause: parsed.error });
    }
    return parsed.data;
  } catch (cause) {
    return cause instanceof StorageError ? cause : new StorageError({ cause });
  }
}

function extensionFor(mimeType: StoredScreenshot["mimeType"]): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default: {
      const unreachable: never = mimeType;
      return unreachable;
    }
  }
}

export const EntryRequestsLive = Layer.effect(
  EntryRequests,
  Effect.gen(function* () {
    const database = yield* Database;
    const config = yield* AppConfigService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const screenshotDir = path.join(path.dirname(config.uploadDir), "screenshots");

    const rowsOf = (sql: string, args?: ReadonlyArray<string | null>) =>
      database.execute(sql, args ? [...args] : undefined);

    const load = (id: string) =>
      Effect.gen(function* () {
        const rows = yield* rowsOf(`${SELECT_LIST} WHERE id = ?`, [id]);
        const row = rows[0];
        if (row === undefined) {
          return undefined;
        }
        const request = toEntryRequest(row);
        if (request instanceof StorageError) {
          return yield* Effect.fail(request);
        }
        return request;
      }).pipe(Effect.mapError(failStorage));

    const loadBySubmission = (submissionId: string) =>
      Effect.gen(function* () {
        const rows = yield* rowsOf(`${SELECT_LIST} WHERE submission_id = ?`, [submissionId]);
        const row = rows[0];
        if (row === undefined) {
          return undefined;
        }
        const request = toEntryRequest(row);
        if (request instanceof StorageError) {
          return yield* Effect.fail(request);
        }
        return request;
      }).pipe(Effect.mapError(failStorage));

    const finishUpdate = (id: string, updatedRows: readonly Row[]) =>
      Effect.gen(function* () {
        if (updatedRows.length > 0) {
          return yield* load(id);
        }
        const existing = yield* load(id);
        if (existing === undefined) {
          return undefined;
        }
        const conflict: RequestUpdate = "conflict";
        return conflict;
      });

    return {
      create: (input) =>
        Effect.gen(function* () {
          const existing = yield* loadBySubmission(input.sourceSubmissionId);
          if (existing !== undefined) {
            return existing;
          }
          const submission = yield* database.execute(`SELECT id FROM submissions WHERE id = ?`, [
            input.sourceSubmissionId,
          ]);
          if (submission[0] === undefined) {
            return undefined;
          }
          const id = randomUUID();
          const now = new Date().toISOString();
          const notes = input.notes === undefined || input.notes.length === 0 ? null : input.notes;
          yield* database.execute(
            `
            INSERT INTO entry_requests (
              id, submission_id, status, artist_id, artist_name, first_name, last_name, address,
              notes, created_at, updated_at
            ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              id,
              input.sourceSubmissionId,
              input.artistId,
              input.artistName,
              input.firstName,
              input.lastName,
              input.address,
              notes,
              now,
              now,
            ],
          );
          return yield* load(id);
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const raced = yield* loadBySubmission(input.sourceSubmissionId);
              if (raced !== undefined) {
                return raced;
              }
              return yield* Effect.fail(failStorage(error));
            }),
          ),
        ),
      list: () =>
        Effect.gen(function* () {
          const rows = yield* rowsOf(`${SELECT_LIST} ORDER BY created_at DESC`);
          const requests: EntryRequest[] = [];
          for (const row of rows) {
            const request = toEntryRequest(row);
            if (request instanceof StorageError) {
              return yield* Effect.fail(request);
            }
            requests.push(request);
          }
          return requests;
        }).pipe(Effect.mapError(failStorage)),
      get: (id) => load(id),
      requestVerify: (id) =>
        Effect.gen(function* () {
          const now = new Date().toISOString();
          const updated = yield* database.execute(
            `
            UPDATE entry_requests
            SET status = 'pending',
                verify_requested_at = ?,
                failure_reason = NULL,
                updated_at = ?
            WHERE id = ?
              AND (
                (status = 'pending' AND verify_requested_at IS NULL)
                OR status = 'failed'
              )
            RETURNING id
            `,
            [now, now, id],
          );
          return yield* finishUpdate(id, updated);
        }),
      reject: (id) =>
        Effect.gen(function* () {
          const now = new Date().toISOString();
          const updated = yield* database.execute(
            `
            UPDATE entry_requests
            SET status = 'rejected', updated_at = ?
            WHERE id = ? AND status = 'pending'
            RETURNING id
            `,
            [now, id],
          );
          return yield* finishUpdate(id, updated);
        }),
      claimVerify: (now) =>
        Effect.gen(function* () {
          const claimedAt = now.toISOString();
          const rows = yield* database.execute(
            `
            UPDATE entry_requests
            SET status = 'verifying', updated_at = ?
            WHERE id = (
              SELECT id FROM entry_requests
              WHERE status = 'pending' AND verify_requested_at IS NOT NULL
              ORDER BY verify_requested_at ASC
              LIMIT 1
            )
            AND status = 'pending' AND verify_requested_at IS NOT NULL
            RETURNING id, submission_id, artist_id, artist_name, first_name, last_name, address, notes
            `,
            [claimedAt],
          );
          const row = rows[0];
          if (row === undefined) {
            return undefined;
          }
          try {
            const claimed: ClaimedVerifyJob = {
              id: takeString(requireString(row, "id")),
              submissionId: takeString(requireString(row, "submission_id")),
              artistId: takeString(requireString(row, "artist_id")),
              artistName: takeString(requireString(row, "artist_name")),
              firstName: takeString(requireString(row, "first_name")),
              lastName: takeString(requireString(row, "last_name")),
              address: takeString(requireString(row, "address")),
              notes: takeOptional(optionalString(row, "notes")),
            };
            return claimed;
          } catch (cause) {
            return yield* Effect.fail(failStorage(cause));
          }
        }).pipe(Effect.mapError(failStorage)),
      completeVerify: (id, outcome, entryId, recordsArtistId, message, screenshot) =>
        Effect.gen(function* () {
          const existing = yield* load(id);
          if (existing === undefined) {
            return undefined;
          }
          if (existing.status !== "verifying") {
            const conflict: RequestUpdate = "conflict";
            return conflict;
          }
          let screenshotPath: string | null = null;
          if (screenshot !== undefined) {
            yield* fs
              .makeDirectory(screenshotDir, { recursive: true })
              .pipe(Effect.mapError((cause) => new StorageError({ cause })));
            screenshotPath = path.join(screenshotDir, `${id}.${extensionFor(screenshot.mimeType)}`);
            yield* fs
              .writeFile(screenshotPath, screenshot.bytes)
              .pipe(Effect.mapError((cause) => new StorageError({ cause })));
          }
          const now = new Date().toISOString();
          const status = outcome === "done" ? "done" : "failed";
          const updated = yield* database.execute(
            `
            UPDATE entry_requests
            SET status = ?,
                entry_id = ?,
                records_artist_id = ?,
                failure_reason = ?,
                screenshot_path = ?,
                updated_at = ?
            WHERE id = ? AND status = 'verifying'
            RETURNING id
            `,
            [
              status,
              outcome === "done" ? (entryId ?? null) : null,
              outcome === "done" ? (recordsArtistId ?? null) : null,
              outcome === "failed" ? (message ?? null) : null,
              screenshotPath,
              now,
              id,
            ],
          );
          return yield* finishUpdate(id, updated);
        }),
      readScreenshot: (id) =>
        Effect.gen(function* () {
          const rows = yield* database.execute(`SELECT screenshot_path FROM entry_requests WHERE id = ?`, [id]);
          const row = rows[0];
          if (row === undefined) {
            return undefined;
          }
          const storagePath = optionalString(row, "screenshot_path");
          if (storagePath instanceof StorageError) {
            return yield* Effect.fail(storagePath);
          }
          if (storagePath === null || storagePath.length === 0) {
            return undefined;
          }
          const bytes = yield* fs
            .readFile(storagePath)
            .pipe(Effect.mapError((cause) => new StorageError({ cause })));
          const mimeType: StoredScreenshot["mimeType"] = storagePath.endsWith(".jpg")
            ? "image/jpeg"
            : storagePath.endsWith(".webp")
              ? "image/webp"
              : "image/png";
          return { bytes, mimeType };
        }).pipe(Effect.mapError(failStorage)),
    };
  }),
);
