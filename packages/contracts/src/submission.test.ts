import { describe, expect, it } from "vitest";
import { canSubmitToRecords, createSubmissionFieldsSchema, nextStatus, statusForWorkerOutcome, submissionSchema } from "./submission.js";

describe("createSubmissionFieldsSchema", () => {
  it("trims names and the external id", () => {
    const parsed = createSubmissionFieldsSchema.parse({
      firstName: "  Ada ",
      lastName: " Lovelace ",
      address: "  12 Analytical Engine\nLondon  ",
      externalId: " rec_1001 ",
    });

    expect(parsed).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      address: "12 Analytical Engine\nLondon",
      externalId: "rec_1001",
    });
  });

  it("rejects an external id that is not a simple token", () => {
    const parsed = createSubmissionFieldsSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      address: "London",
      externalId: "has space",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "externalId")).toBe(true);
    }
  });
});

describe("submissionSchema", () => {
  it("accepts a pending submission", () => {
    const submission = submissionSchema.parse({
      id: "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d",
      firstName: "Ada",
      lastName: "Lovelace",
      address: "London",
      externalId: "rec_1001",
      status: "pending",
      image: {
        filename: "ada.png",
        mimeType: "image/png",
        sizeBytes: 68,
      },
      createdAt: "2026-11-25T00:00:00.000Z",
      updatedAt: "2026-11-25T00:00:00.000Z",
      verifiedAt: null,
      rejectedAt: null,
      approvedAt: null,
      workerMessage: null,
      recordsRequestId: null,
    });

    expect(submission.status).toBe("pending");
  });
});

describe("nextStatus", () => {
  it("allows pending to verified or rejected, and verified to approved", () => {
    expect(nextStatus("pending", "verify")).toBe("verified");
    expect(nextStatus("pending", "reject")).toBe("rejected");
    expect(nextStatus("verified", "approve")).toBe("approved");
  });

  it("queues verified, missing, and failed submissions for another try", () => {
    expect(canSubmitToRecords("verified")).toBe(true);
    expect(canSubmitToRecords("id_not_found")).toBe(true);
    expect(canSubmitToRecords("failed")).toBe(true);
    expect(canSubmitToRecords("pending")).toBe(false);
    expect(canSubmitToRecords("queued")).toBe(false);
    expect(statusForWorkerOutcome("sent")).toBe("sent_to_records");
    expect(statusForWorkerOutcome("id_not_found")).toBe("id_not_found");
    expect(statusForWorkerOutcome("failed")).toBe("failed");
  });

  it("refuses skipping ahead or leaving a terminal status", () => {
    expect(nextStatus("pending", "approve")).toBeUndefined();
    expect(nextStatus("verified", "reject")).toBeUndefined();
    expect(nextStatus("rejected", "approve")).toBeUndefined();
    expect(nextStatus("approved", "verify")).toBeUndefined();
  });
});
