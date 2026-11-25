import { apiErrorSchema, submissionSchema, type Submission } from "@intake/contracts";
import type { IntakeFormValues } from "@/intake/schema";

export class IntakeApiError extends Error {
  readonly status: number;
  readonly fields: Record<string, string> | undefined;

  constructor(message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = "IntakeApiError";
    this.status = status;
    this.fields = fields;
  }
}

export async function createSubmission(values: IntakeFormValues): Promise<Submission> {
  const body = new FormData();
  body.set("firstName", values.firstName);
  body.set("lastName", values.lastName);
  body.set("address", values.address);
  body.set("externalId", values.externalId);
  body.set("image", values.image);

  let response: Response;
  try {
    response = await fetch("/api/submissions", { method: "POST", body });
  } catch {
    throw new IntakeApiError("Something went wrong while saving your submission. Try again.", 0);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new IntakeApiError(parsed.data.message, response.status, parsed.data.fields);
    }
    throw new IntakeApiError("Something went wrong while saving your submission. Try again.", response.status);
  }

  const payload = await response.json().catch(() => null);
  const parsed = submissionSchema.safeParse(payload);
  if (!parsed.success) {
    throw new IntakeApiError("Something went wrong while saving your submission. Try again.", response.status);
  }
  return parsed.data;
}
