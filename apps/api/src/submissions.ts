import { randomUUID } from "node:crypto";
import type { Row } from "@libsql/client";
import {
  imageMimeTypeSchema,
  submissionSchema,
  type ImageMimeType,
  type Submission,
  type SubmissionStatus,
} from "@intake/contracts";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { Database } from "./db.js";
import { StorageError } from "./errors.js";
import { AppConfigService } from "./services.js";

export interface NewSubmission {
  readonly firstName: string;
  readonly lastName: string;
  readonly address: string;
  readonly externalId: string;
  readonly image: {
    readonly originalFilename: string;
    readonly mimeType: ImageMimeType;
    readonly sizeBytes: number;
    readonly tempPath: string;
  };
}

export interface StoredImage {
  readonly bytes: Uint8Array;
  readonly mimeType: ImageMimeType;
  readonly filename: string;
}

export class Submissions extends Context.Service<
  Submissions,
  {
    readonly create: (input: NewSubmission) => Effect.Effect<Submission, StorageError>;
    readonly list: (status?: SubmissionStatus) => Effect.Effect<readonly Submission[], StorageError>;
    readonly get: (id: string) => Effect.Effect<Submission | undefined, StorageError>;
    readonly readImage: (id: string) => Effect.Effect<StoredImage | undefined, StorageError>;
  }
>()("intake/Submissions") {}

const SELECT_LIST = `
  SELECT
    id, first_name, last_name, address, external_id, status,
    image_filename, image_mime_type, image_size_bytes, image_storage_path,
    created_at, updated_at
  FROM submissions
`;

function requireString(row: Row, key: string): string | StorageError {
  const value = row[key];
  if (typeof value !== "string") {
    return new StorageError({ cause: `Expected text in ${key}` });
  }
  return value;
}

function requireNumber(row: Row, key: string): number | StorageError {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return new StorageError({ cause: `Expected a number in ${key}` });
}

function takeString(value: string | StorageError): string {
  if (value instanceof StorageError) {
    throw value;
  }
  return value;
}

function toSubmission(row: Row): Submission | StorageError {
  try {
    const parsed = submissionSchema.safeParse({
      id: takeString(requireString(row, "id")),
      firstName: takeString(requireString(row, "first_name")),
      lastName: takeString(requireString(row, "last_name")),
      address: takeString(requireString(row, "address")),
      externalId: takeString(requireString(row, "external_id")),
      status: takeString(requireString(row, "status")),
      image: {
        filename: takeString(requireString(row, "image_filename")),
        mimeType: takeString(requireString(row, "image_mime_type")),
        sizeBytes: takeStringNumber(requireNumber(row, "image_size_bytes")),
      },
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

function takeStringNumber(value: number | StorageError): number {
  if (value instanceof StorageError) {
    throw value;
  }
  return value;
}

function extensionFor(mimeType: ImageMimeType): string {
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

function failStorage(cause: unknown): StorageError {
  return cause instanceof StorageError ? cause : new StorageError({ cause });
}

export const SubmissionsLive = Layer.effect(
  Submissions,
  Effect.gen(function* () {
    const database = yield* Database;
    const config = yield* AppConfigService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const rowsOf = (sql: string, args?: ReadonlyArray<string>) => database.execute(sql, args ? [...args] : undefined);

    return {
      create: (input) =>
        Effect.gen(function* () {
          const id = randomUUID();
          const now = new Date().toISOString();
          const storageName = `${id}.${extensionFor(input.image.mimeType)}`;
          const storagePath = path.join(config.uploadDir, storageName);
          yield* fs
            .makeDirectory(config.uploadDir, { recursive: true })
            .pipe(Effect.mapError((cause) => new StorageError({ cause })));
          yield* fs
            .copyFile(input.image.tempPath, storagePath)
            .pipe(Effect.mapError((cause) => new StorageError({ cause })));

          yield* database
            .execute(
              `
              INSERT INTO submissions (
                id, first_name, last_name, address, external_id, status,
                image_filename, image_mime_type, image_size_bytes, image_storage_path,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
              `,
              [
                id,
                input.firstName,
                input.lastName,
                input.address,
                input.externalId,
                input.image.originalFilename,
                input.image.mimeType,
                input.image.sizeBytes,
                storagePath,
                now,
                now,
              ],
            )
            .pipe(
              Effect.tapError(() =>
                fs.remove(storagePath).pipe(Effect.catch(() => Effect.succeed(undefined))),
              ),
            );

          const submission = submissionSchema.safeParse({
            id,
            firstName: input.firstName,
            lastName: input.lastName,
            address: input.address,
            externalId: input.externalId,
            status: "pending",
            image: {
              filename: input.image.originalFilename,
              mimeType: input.image.mimeType,
              sizeBytes: input.image.sizeBytes,
            },
            createdAt: now,
            updatedAt: now,
          });
          if (!submission.success) {
            return yield* Effect.fail(new StorageError({ cause: submission.error }));
          }
          return submission.data;
        }),
      list: (status) =>
        Effect.gen(function* () {
          const rows =
            status === undefined
              ? yield* rowsOf(`${SELECT_LIST} ORDER BY created_at DESC`)
              : yield* rowsOf(`${SELECT_LIST} WHERE status = ? ORDER BY created_at DESC`, [status]);
          const submissions: Submission[] = [];
          for (const row of rows) {
            const submission = toSubmission(row);
            if (submission instanceof StorageError) {
              return yield* Effect.fail(submission);
            }
            submissions.push(submission);
          }
          return submissions;
        }).pipe(Effect.mapError(failStorage)),
      get: (id) =>
        Effect.gen(function* () {
          const rows = yield* rowsOf(`${SELECT_LIST} WHERE id = ?`, [id]);
          const row = rows[0];
          if (row === undefined) {
            return undefined;
          }
          const submission = toSubmission(row);
          if (submission instanceof StorageError) {
            return yield* Effect.fail(submission);
          }
          return submission;
        }).pipe(Effect.mapError(failStorage)),
      readImage: (id) =>
        Effect.gen(function* () {
          const rows = yield* database.execute(
            `SELECT image_filename, image_mime_type, image_storage_path FROM submissions WHERE id = ?`,
            [id],
          );
          const row = rows[0];
          if (row === undefined) {
            return undefined;
          }
          const filename = requireString(row, "image_filename");
          const mimeType = requireString(row, "image_mime_type");
          const storagePath = requireString(row, "image_storage_path");
          if (filename instanceof StorageError) {
            return yield* Effect.fail(filename);
          }
          if (mimeType instanceof StorageError) {
            return yield* Effect.fail(mimeType);
          }
          if (storagePath instanceof StorageError) {
            return yield* Effect.fail(storagePath);
          }
          const parsedMime = imageMimeTypeSchema.safeParse(mimeType);
          if (!parsedMime.success) {
            return yield* Effect.fail(new StorageError({ cause: parsedMime.error }));
          }
          const bytes = yield* fs
            .readFile(storagePath)
            .pipe(Effect.mapError((cause) => new StorageError({ cause })));
          return { bytes, mimeType: parsedMime.data, filename };
        }).pipe(Effect.mapError(failStorage)),
    };
  }),
);
