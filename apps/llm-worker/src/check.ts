export interface SubmissionFields {
  readonly firstName: string;
  readonly lastName: string;
  readonly address: string;
  readonly recordId: string;
}

export interface ModelOutput {
  readonly firstName: string;
  readonly lastName: string;
  readonly address: string;
  readonly recordId: string;
  readonly notes: string;
}

export interface CheckedFields extends SubmissionFields {
  readonly notes: string;
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function sameTokenSequence(original: string, candidate: string): boolean {
  const left = tokens(original);
  const right = tokens(candidate);
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return left.every((token, index) => token === right[index]);
}

function keptText(original: string, candidate: string, label: string, notes: string[]): string {
  const trimmed = candidate.trim();
  if (sameTokenSequence(original, trimmed)) {
    return trimmed;
  }
  notes.push(`The model changed the ${label}; used the original ${label}.`);
  return original;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function parseModelOutput(payload: unknown): ModelOutput | undefined {
  const envelope = asRecord(payload);
  const message = asRecord(envelope?.message);
  const content = message?.content ?? payload;
  let parsed: unknown = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  const fields = asRecord(parsed);
  if (
    fields === undefined ||
    typeof fields.firstName !== "string" ||
    typeof fields.lastName !== "string" ||
    typeof fields.address !== "string" ||
    typeof fields.recordId !== "string"
  ) {
    return undefined;
  }
  const notes = typeof fields.notes === "string" ? fields.notes.trim().slice(0, 500) : "";
  return {
    firstName: fields.firstName,
    lastName: fields.lastName,
    address: fields.address,
    recordId: fields.recordId,
    notes,
  };
}

/**
 * The record id sent onward is always the submission's id. Model text is kept
 * only when it uses the same words in the same order.
 */
export function checkAgainstSubmission(original: SubmissionFields, model: ModelOutput | undefined): CheckedFields {
  if (model === undefined) {
    return {
      ...original,
      notes: "The model did not return usable JSON; used the original fields.",
    };
  }
  const notes: string[] = [];
  if (model.recordId !== original.recordId) {
    notes.push("Record ID from the model did not match the submission; used the original record ID.");
  }
  const firstName = keptText(original.firstName, model.firstName, "first name", notes);
  const lastName = keptText(original.lastName, model.lastName, "last name", notes);
  const address = keptText(original.address, model.address, "address", notes);
  if (notes.length === 0 && model.notes.length > 0) {
    notes.push(model.notes);
  }
  return {
    firstName,
    lastName,
    address,
    recordId: original.recordId,
    notes: notes.join(" "),
  };
}
