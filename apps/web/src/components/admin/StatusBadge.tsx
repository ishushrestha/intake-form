import type { SubmissionStatus } from "@intake/contracts";
import { statusLabels } from "@/admin/status";
import { cn } from "@/lib/utils";

const tones: Record<SubmissionStatus, string> = {
  pending: "bg-muted text-foreground",
  verified: "bg-amber-100 text-amber-950",
  approved: "bg-emerald-100 text-emerald-950",
  rejected: "bg-red-100 text-red-950",
  queued: "bg-sky-100 text-sky-950",
  processing: "bg-indigo-100 text-indigo-950",
  sent_to_records: "bg-emerald-100 text-emerald-950",
  id_not_found: "bg-orange-100 text-orange-950",
  failed: "bg-red-100 text-red-950",
};

export function StatusBadge({ status }: { readonly status: SubmissionStatus }) {
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium", tones[status])}>
      {statusLabels[status]}
    </span>
  );
}
