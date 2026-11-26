import { canReviewEntryRequest, type EntryRequest, type EntryRequestStatus } from "@intake/contracts";
import type { MouseEvent } from "react";
import { formatTimestamp } from "@/admin/status";
import { AdminShell } from "@/components/admin/AdminShell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const requestLabels: Record<EntryRequestStatus, string> = {
  pending: "Pending",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  rejected: "Rejected",
};

const requestTones: Record<EntryRequestStatus, string> = {
  pending: "bg-muted text-foreground",
  verifying: "bg-indigo-100 text-indigo-950",
  done: "bg-emerald-100 text-emerald-950",
  failed: "bg-red-100 text-red-950",
  rejected: "bg-red-100 text-red-950",
};

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export interface AdminEntryRequestsViewProps {
  readonly requests: readonly EntryRequest[];
  readonly isLoading: boolean;
  readonly isSaving: boolean;
  readonly error?: string;
  readonly savingId?: string;
  readonly onGoHome: () => void;
  readonly onGoToSubmissions: () => void;
  readonly onGoToEntryRequests: () => void;
  readonly onOpenSubmission: (id: string) => void;
  readonly onVerify: (id: string) => void;
  readonly onReject: (id: string) => void;
  readonly onLogout: () => void;
}

export function AdminEntryRequestsView(props: AdminEntryRequestsViewProps) {
  return (
    <AdminShell
      onGoHome={props.onGoHome}
      onGoToEntryRequests={props.onGoToEntryRequests}
      onGoToSubmissions={props.onGoToSubmissions}
      onLogout={props.onLogout}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-4xl tracking-tight">LLM entry requests</h1>
          <p className="text-muted-foreground">
            The local worker maps a submission, then waits here. Verify drives the records-admin pages. Reject
            stops there.
          </p>
        </div>
        {props.error === undefined ? null : (
          <p className="text-sm text-destructive" role="alert">
            {props.error}
          </p>
        )}
        {props.isLoading ? (
          <p className="text-muted-foreground">Loading entry requests…</p>
        ) : props.requests.length === 0 ? (
          <p className="text-muted-foreground">No LLM entry requests yet.</p>
        ) : (
          <ul className="space-y-4">
            {props.requests.map((request) => {
              const busy = props.isSaving && props.savingId === request.id;
              const actionable = canReviewEntryRequest(request.status, request.verifyRequestedAt);
              return (
                <li key={request.id}>
                  <article className="space-y-4 rounded-xl border border-border bg-card p-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium",
                          requestTones[request.status],
                        )}
                      >
                        {requestLabels[request.status]}
                      </span>
                      {request.status === "pending" && request.verifyRequestedAt !== null ? (
                        <p className="text-sm text-muted-foreground">Waiting for the local worker.</p>
                      ) : null}
                      {request.status === "verifying" ? (
                        <p className="text-sm text-muted-foreground">
                          The worker is typing this into records-admin. Stuck requests are not retried.
                        </p>
                      ) : null}
                    </div>
                    <dl className="grid gap-4 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">Proposed artist</dt>
                        <dd>
                          <span className="font-mono">{request.artistId}</span>
                          <span className="text-muted-foreground"> · {request.artistName}</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Proposed entry</dt>
                        <dd>
                          {request.firstName} {request.lastName}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Address</dt>
                        <dd className="whitespace-pre-wrap">{request.address}</dd>
                      </div>
                      {request.notes === null ? null : (
                        <div className="sm:col-span-2">
                          <dt className="text-muted-foreground">Notes</dt>
                          <dd>{request.notes}</dd>
                        </div>
                      )}
                      {request.entryId === null ? null : (
                        <div>
                          <dt className="text-muted-foreground">Entry ID</dt>
                          <dd className="font-mono break-all">{request.entryId}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-muted-foreground">Received</dt>
                        <dd>{formatTimestamp(request.createdAt)}</dd>
                      </div>
                    </dl>
                    {request.failureReason === null ? null : (
                      <p className="text-sm text-destructive" role="alert">
                        {request.failureReason}
                      </p>
                    )}
                    <a
                      className="inline-block text-sm underline-offset-4 hover:underline"
                      href={`/admin/submissions/${request.submissionId}`}
                      onClick={(event) => {
                        if (!isPlainLeftClick(event)) {
                          return;
                        }
                        event.preventDefault();
                        props.onOpenSubmission(request.submissionId);
                      }}
                    >
                      Source submission
                    </a>
                    {actionable ? (
                      <div className="flex flex-wrap gap-3">
                        <Button disabled={busy} onClick={() => props.onVerify(request.id)} type="button">
                          Verify
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => props.onReject(request.id)}
                          type="button"
                          variant="outline"
                        >
                          Reject
                        </Button>
                      </div>
                    ) : null}
                    {request.screenshotAvailable && (request.status === "done" || request.status === "failed") ? (
                      <figure className="space-y-2">
                        <img
                          alt={`Verification screenshot for ${request.firstName} ${request.lastName}`}
                          className="max-h-[28rem] w-full rounded-lg border border-border bg-muted object-contain"
                          src={`/api/admin/entry-requests/${request.id}/screenshot`}
                        />
                        <figcaption className="text-sm text-muted-foreground">Worker screenshot</figcaption>
                      </figure>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AdminShell>
  );
}
