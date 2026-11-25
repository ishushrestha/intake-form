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
 *
 * TODO: After the status change, a local LLM should read the approved submission,
 * log into the records system, and fill the record identified by `externalId`.
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
