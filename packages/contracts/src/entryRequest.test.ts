import { describe, expect, it } from "vitest";
import { canRejectEntryRequest, canReviewEntryRequest, createEntryRequestSchema } from "./entryRequest.js";

describe("entry request review", () => {
  it("allows Verify on pending or failed, and Reject only while pending and not queued", () => {
    expect(canReviewEntryRequest("pending", null)).toBe(true);
    expect(canReviewEntryRequest("pending", "2026-11-26T00:00:00.000Z")).toBe(false);
    expect(canReviewEntryRequest("failed", null)).toBe(true);
    expect(canReviewEntryRequest("verifying", null)).toBe(false);
    expect(canReviewEntryRequest("done", null)).toBe(false);
    expect(canReviewEntryRequest("rejected", null)).toBe(false);
    expect(canRejectEntryRequest("pending", null)).toBe(true);
    expect(canRejectEntryRequest("failed", null)).toBe(false);
  });

  it("accepts mapped fields for a pending request", () => {
    const parsed = createEntryRequestSchema.parse({
      sourceSubmissionId: "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d",
      artistId: "A0001",
      artistName: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      address: "London",
    });
    expect(parsed.artistId).toBe("A0001");
  });
});
