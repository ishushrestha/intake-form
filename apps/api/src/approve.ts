import type { Submission } from "@intake/contracts";
import { Effect } from "effect";
import type { StorageError, TransitionError } from "./errors.js";

export interface ApprovableSubmissions {
  readonly transition: (
    id: string,
    action: "approve",
  ) => Effect.Effect<Submission | undefined, StorageError | TransitionError>;
}

/**
 * Approves a verified submission and records `approvedAt`.
 * Sending the submission to records-admin is separate: an admin queues it, and
 * the local worker claims that job.
 */
export const approveSubmission = (
  submissions: ApprovableSubmissions,
  id: string,
): Effect.Effect<Submission | undefined, StorageError | TransitionError> =>
  Effect.gen(function* () {
    const approved = yield* submissions.transition(id, "approve");
    if (approved === undefined) {
      return undefined;
    }
    // TODO: hand this approved submission to the local LLM.
    return approved;
  });
