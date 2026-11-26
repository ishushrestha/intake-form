import { canSubmitToRecords, type Submission } from "@intake/contracts";
import { formatTimestamp } from "@/admin/status";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";

export interface AdminDetailViewProps {
  readonly submission?: Submission;
  readonly isLoading: boolean;
  readonly isSaving: boolean;
  readonly error?: string;
  readonly onBack: () => void;
  readonly onGoHome: () => void;
  readonly onGoToSubmissions: () => void;
  readonly onGoToEntryRequests: () => void;
  readonly onVerify: () => void;
  readonly onReject: () => void;
  readonly onApprove: () => void;
  readonly onSubmitToRecords: () => void;
  readonly onLogout: () => void;
}

export function AdminDetailView(props: AdminDetailViewProps) {
  const submission = props.submission;

  return (
    <AdminShell
      onGoHome={props.onGoHome}
      onGoToEntryRequests={props.onGoToEntryRequests}
      onGoToSubmissions={props.onGoToSubmissions}
      onLogout={props.onLogout}
    >
      <div className="space-y-6">
        <Button onClick={props.onBack} type="button" variant="outline">
          Back to submissions
        </Button>
        {props.isLoading || submission === undefined ? (
          <p className="text-muted-foreground">{props.error ?? "Loading submission…"}</p>
        ) : (
          <article className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-4xl tracking-tight">
                    {submission.firstName} {submission.lastName}
                  </h1>
                  <StatusBadge status={submission.status} />
                </div>
                <p className="text-sm text-muted-foreground">Submitted {formatTimestamp(submission.createdAt)}</p>
              </div>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Record ID</dt>
                  <dd className="font-mono text-base">{submission.externalId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Reference</dt>
                  <dd className="font-mono break-all">{submission.id}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Address</dt>
                  <dd className="whitespace-pre-wrap">{submission.address}</dd>
                </div>
                {submission.verifiedAt === null ? null : (
                  <div>
                    <dt className="text-muted-foreground">Verified</dt>
                    <dd>{formatTimestamp(submission.verifiedAt)}</dd>
                  </div>
                )}
                {submission.rejectedAt === null ? null : (
                  <div>
                    <dt className="text-muted-foreground">Rejected</dt>
                    <dd>{formatTimestamp(submission.rejectedAt)}</dd>
                  </div>
                )}
                {submission.approvedAt === null ? null : (
                  <div>
                    <dt className="text-muted-foreground">Approved</dt>
                    <dd>{formatTimestamp(submission.approvedAt)}</dd>
                  </div>
                )}
                {submission.recordsRequestId === null ? null : (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">Records request</dt>
                    <dd className="font-mono break-all">{submission.recordsRequestId}</dd>
                  </div>
                )}
              </dl>
              {submission.workerMessage === null ? null : (
                <p
                  className={
                    submission.status === "failed" || submission.status === "id_not_found"
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                  role={submission.status === "failed" || submission.status === "id_not_found" ? "alert" : undefined}
                >
                  {submission.workerMessage}
                </p>
              )}
              {props.error === undefined ? null : (
                <p className="text-sm text-destructive" role="alert">
                  {props.error}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                {submission.status === "pending" ? (
                  <>
                    <Button disabled={props.isSaving} onClick={props.onVerify} type="button">
                      Mark verified
                    </Button>
                    <Button disabled={props.isSaving} onClick={props.onReject} type="button" variant="outline">
                      Reject
                    </Button>
                  </>
                ) : null}
                {canSubmitToRecords(submission.status) ? (
                  <Button disabled={props.isSaving} onClick={props.onSubmitToRecords} type="button">
                    Submit to record manager
                  </Button>
                ) : null}
                {submission.status === "verified" ? (
                  <Button disabled={props.isSaving} onClick={props.onApprove} type="button" variant="outline">
                    Verified, proceed
                  </Button>
                ) : null}
                {submission.status === "queued" ? (
                  <p className="text-sm text-muted-foreground">Queued for the local worker.</p>
                ) : null}
                {submission.status === "processing" ? (
                  <p className="text-sm text-muted-foreground">The local worker is checking this submission.</p>
                ) : null}
                {submission.status === "sent_to_records" ? (
                  <p className="text-sm text-muted-foreground">
                    The worker saved a pending LLM entry request. Review it under LLM entry requests.
                  </p>
                ) : null}
                {submission.status === "approved" ? <p className="text-sm text-muted-foreground">This submission was approved.</p> : null}
                {submission.status === "rejected" ? <p className="text-sm text-muted-foreground">This submission was rejected.</p> : null}
              </div>
            </div>
            <figure className="space-y-2">
              <img
                alt={`Uploaded image for ${submission.firstName} ${submission.lastName}`}
                className="max-h-[32rem] w-full rounded-xl border border-border bg-card object-contain"
                src={`/api/submissions/${submission.id}/image`}
              />
              <figcaption className="text-sm text-muted-foreground">{submission.image.filename}</figcaption>
            </figure>
          </article>
        )}
      </div>
    </AdminShell>
  );
}
