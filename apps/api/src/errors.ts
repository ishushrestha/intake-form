import type { ReviewAction, SubmissionStatus } from "@intake/contracts";

export class StorageError {
  readonly _tag = "StorageError";
  constructor(readonly details: { readonly cause: unknown }) {}
}

export class TransitionError {
  readonly _tag = "TransitionError";
  constructor(
    readonly details: {
      readonly from: SubmissionStatus;
      readonly action: ReviewAction;
    },
  ) {}
}
