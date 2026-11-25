import { IMAGE_MAX_BYTES, createSubmissionFieldsSchema, imageMimeTypes } from "@intake/contracts";
import { z } from "zod";

export const intakeFormSchema = createSubmissionFieldsSchema.extend({
  image: z
    .file("Choose a JPEG, PNG, or WebP image.")
    .mime([...imageMimeTypes], "Use a JPEG, PNG, or WebP image.")
    .max(IMAGE_MAX_BYTES, "Image must be 5 MB or smaller."),
});

export type IntakeFormValues = z.infer<typeof intakeFormSchema>;

export const intakeFieldNames = ["firstName", "lastName", "address", "externalId", "image"] as const;

export type IntakeFieldName = (typeof intakeFieldNames)[number];

export function isIntakeField(value: string): value is IntakeFieldName {
  return intakeFieldNames.some((name) => name === value);
}
