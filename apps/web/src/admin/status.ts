import type { SubmissionStatus } from "@intake/contracts";

export const statusLabels: Record<SubmissionStatus, string> = {
  pending: "Pending",
  verified: "Verified",
  approved: "Approved",
  rejected: "Rejected",
};

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
