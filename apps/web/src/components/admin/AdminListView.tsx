import type { Submission, SubmissionStatus } from "@intake/contracts";
import { flexRender, type Table } from "@tanstack/react-table";
import type { MouseEvent } from "react";
import { formatTimestamp, statusLabels } from "@/admin/status";
import { AdminShell } from "@/components/admin/AdminShell";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { submissionStatuses } from "@intake/contracts";

export interface AdminListViewProps {
  readonly table: Table<Submission>;
  readonly query: string;
  readonly status: SubmissionStatus | "all";
  readonly isLoading: boolean;
  readonly error?: string;
  readonly onGoHome: () => void;
  readonly onGoToSubmissions: () => void;
  readonly onGoToEntryRequests: () => void;
  readonly onOpen: (id: string) => void;
  readonly onQueryChange: (value: string) => void;
  readonly onStatusChange: (value: SubmissionStatus | "all") => void;
  readonly onLogout: () => void;
}

function isPlainLeftClick(event: MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function AdminListView(props: AdminListViewProps) {
  const rows = props.table.getRowModel().rows;

  return (
    <AdminShell
      onGoHome={props.onGoHome}
      onGoToEntryRequests={props.onGoToEntryRequests}
      onGoToSubmissions={props.onGoToSubmissions}
      onLogout={props.onLogout}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-4xl tracking-tight">Submissions</h1>
          <p className="text-muted-foreground">Newest first. Open a row to review it or send it to the record manager.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex-1 text-sm font-medium" htmlFor="submission-search">
            Search
            <input
              className="mt-2 flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="submission-search"
              onChange={(event) => {
                props.onQueryChange(event.target.value);
              }}
              placeholder="Name or record ID"
              type="search"
              value={props.query}
            />
          </label>
          <label className="text-sm font-medium sm:w-48" htmlFor="submission-status">
            Status
            <select
              className="mt-2 flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="submission-status"
              onChange={(event) => {
                props.onStatusChange(event.target.value as SubmissionStatus | "all");
              }}
              value={props.status}
            >
              <option value="all">All</option>
              {submissionStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {props.error === undefined ? null : (
          <p className="text-sm text-destructive" role="alert">
            {props.error}
          </p>
        )}
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">Intake submissions</caption>
            <thead className="bg-muted/70 text-left">
              {props.table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th className="px-4 py-3 font-medium" key={header.id} scope="col">
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {props.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-muted-foreground" colSpan={props.table.getAllColumns().length}>
                    Loading submissions…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-muted-foreground" colSpan={props.table.getAllColumns().length}>
                    No submissions match.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const submission = row.original;
                  const href = `/admin/submissions/${submission.id}`;
                  return (
                    <tr
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                      key={row.id}
                      onClick={(event) => {
                        if (!isPlainLeftClick(event)) {
                          return;
                        }
                        if (event.target instanceof Element && event.target.closest("a") !== null) {
                          return;
                        }
                        props.onOpen(submission.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") {
                          return;
                        }
                        if (event.target instanceof Element && event.target.closest("a") !== null) {
                          return;
                        }
                        event.preventDefault();
                        props.onOpen(submission.id);
                      }}
                      tabIndex={0}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td className="px-4 py-3 align-middle" key={cell.id}>
                          {cell.column.id === "name" ? (
                            <a
                              className="font-medium underline-offset-4 hover:underline"
                              href={href}
                              onClick={(event) => {
                                if (!isPlainLeftClick(event)) {
                                  return;
                                }
                                event.preventDefault();
                                props.onOpen(submission.id);
                              }}
                            >
                              {submission.firstName} {submission.lastName}
                            </a>
                          ) : cell.column.id === "status" ? (
                            <div className="space-y-1">
                              <StatusBadge status={submission.status} />
                              {submission.workerMessage !== null &&
                              (submission.status === "failed" || submission.status === "id_not_found") ? (
                                <p className="max-w-xs text-xs text-muted-foreground">{submission.workerMessage}</p>
                              ) : null}
                            </div>
                          ) : cell.column.id === "externalId" ? (
                            <span className="font-mono">{submission.externalId}</span>
                          ) : (
                            formatTimestamp(submission.createdAt)
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
