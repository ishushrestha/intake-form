import { z } from "zod";
import { addressSchema, externalIdSchema, firstNameSchema, lastNameSchema } from "./submission.js";

export const entryRequestStatuses = ["pending", "verifying", "done", "failed", "rejected"] as const;

export const entryRequestStatusSchema = z.enum(entryRequestStatuses);

export type EntryRequestStatus = z.infer<typeof entryRequestStatusSchema>;

export const createEntryRequestSchema = z.object({
  sourceSubmissionId: z.uuid(),
  artistId: externalIdSchema,
  artistName: z
    .string()
    .trim()
    .min(1, "Enter an artist name.")
    .max(160, "Artist name must be 160 characters or fewer."),
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  address: addressSchema,
  notes: z.string().trim().max(2000).optional(),
});

export type CreateEntryRequestBody = z.infer<typeof createEntryRequestSchema>;

export const entryRequestSchema = z.object({
  id: z.uuid(),
  submissionId: z.uuid(),
  status: entryRequestStatusSchema,
  artistId: z.string(),
  artistName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  address: z.string(),
  notes: z.string().nullable(),
  entryId: z.string().nullable(),
  recordsArtistId: z.string().nullable(),
  failureReason: z.string().nullable(),
  screenshotAvailable: z.boolean(),
  verifyRequestedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type EntryRequest = z.infer<typeof entryRequestSchema>;

export const entryRequestListSchema = z.object({
  requests: z.array(entryRequestSchema),
});

export type EntryRequestList = z.infer<typeof entryRequestListSchema>;

export const verifyJobSchema = z.object({
  id: z.uuid(),
  submissionId: z.uuid(),
  artistId: z.string(),
  artistName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  address: z.string(),
  notes: z.string().nullable(),
  imageUrl: z.string().min(1),
});

export type VerifyJob = z.infer<typeof verifyJobSchema>;

export const verifyOutcomes = ["done", "failed"] as const;

export const verifyOutcomeSchema = z.enum(verifyOutcomes);

export type VerifyOutcome = z.infer<typeof verifyOutcomeSchema>;

export const verifyResultSchema = z.object({
  outcome: verifyOutcomeSchema,
  entryId: z.string().trim().min(1).max(200).optional(),
  recordsArtistId: z.string().trim().min(1).max(64).optional(),
  message: z.string().trim().max(2000).optional(),
});

export type VerifyResultBody = z.infer<typeof verifyResultSchema>;

export function canReviewEntryRequest(
  status: EntryRequestStatus,
  verifyRequestedAt: string | null,
): boolean {
  return (status === "pending" && verifyRequestedAt === null) || status === "failed";
}

export function canRejectEntryRequest(
  status: EntryRequestStatus,
  verifyRequestedAt: string | null,
): boolean {
  return status === "pending" && verifyRequestedAt === null;
}
