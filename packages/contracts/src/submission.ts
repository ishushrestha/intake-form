import { z } from "zod";

/** Lifecycle used by review and the later handoff into the records system. */
export const submissionStatuses = ["pending", "verified", "approved", "rejected"] as const;

export const submissionStatusSchema = z.enum(submissionStatuses);

export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const imageMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;

export const imageMimeTypeSchema = z.enum(imageMimeTypes);

export type ImageMimeType = z.infer<typeof imageMimeTypeSchema>;

/** 5 MB. Enforced in the browser and again on the server. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Record id from the second system. Trimmed, then checked for a simple token
 * shape only — this service does not look the id up.
 */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function hasDisallowedControl(value: string, allowWhitespace: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    const isControl = code <= 31 || code === 127;
    const isAllowedWhitespace = allowWhitespace && (code === 9 || code === 10 || code === 13);
    if (isControl && !isAllowedWhitespace) {
      return true;
    }
  }
  return false;
}

export const firstNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a first name.")
  .max(80, "First name must be 80 characters or fewer.")
  .refine((value) => !hasDisallowedControl(value, false), "Remove control characters.");

export const lastNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a last name.")
  .max(80, "Last name must be 80 characters or fewer.")
  .refine((value) => !hasDisallowedControl(value, false), "Remove control characters.");

export const addressSchema = z
  .string()
  .trim()
  .min(1, "Enter an address.")
  .max(500, "Address must be 500 characters or fewer.")
  .refine((value) => !hasDisallowedControl(value, true), "Remove control characters.");

export const externalIdSchema = z
  .string()
  .trim()
  .min(1, "Enter the record ID.")
  .max(64, "Record ID must be 64 characters or fewer.")
  .regex(EXTERNAL_ID_PATTERN, "Use letters, numbers, dots, underscores, or hyphens.");

export const createSubmissionFieldsSchema = z.object({
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  address: addressSchema,
  externalId: externalIdSchema,
});

export type CreateSubmissionFields = z.infer<typeof createSubmissionFieldsSchema>;

export const submissionImageSchema = z.object({
  filename: z.string().min(1),
  mimeType: imageMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
});

export type SubmissionImage = z.infer<typeof submissionImageSchema>;

export const submissionSchema = z.object({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  address: z.string(),
  externalId: z.string(),
  status: submissionStatusSchema,
  image: submissionImageSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Submission = z.infer<typeof submissionSchema>;

export const submissionListSchema = z.object({
  submissions: z.array(submissionSchema),
});

export type SubmissionList = z.infer<typeof submissionListSchema>;

export const apiErrorCodes = ["validation_error", "not_found", "internal_error"] as const;

export const apiErrorSchema = z.object({
  error: z.enum(apiErrorCodes),
  message: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export function fieldErrorsFromZod(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string" || fields[key] !== undefined) {
      continue;
    }
    fields[key] = issue.message;
  }
  return fields;
}
