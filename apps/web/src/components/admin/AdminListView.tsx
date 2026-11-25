import type { SubmissionStatus } from "@intake/contracts";
import { flexRender, type Table } from "@tanstack/react-table";
import type { Submission } from "@intake/contracts";
import { AdminShell } from "@/components/admin/AdminShell";
import { submissionStatuses } from "@intake/contracts";
import { statusLabels } from "@/admin/status";

export interface AdminListViewProps {
  readonly table: Table<Submission>;
  readonly query: string;
  readonly status: SubmissionStatus | "all";
  readonly isLoading: boolean;
  readonly error?: string;
  readonly onQueryChange: (value: string) => void;
  readonly onStatusChange: (value: SubmissionStatus | "all") => void;
  readonly onLogout: () => void;
}

export function AdminListView(props: AdminListViewProps) {
  const rows = props.table.getRowModel().rows;

  return (
    <AdminShell onLogout={props.onLogout}>
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-4xl tracking-tight">Submissions</h1>
          <p className="text-muted-foreground">Newest first. Open a row to verify or approve it.</p>
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
                rows.map((row) => (
                  <tr className="border-t border-border" key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td className="px-4 py-3 align-middle" key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
