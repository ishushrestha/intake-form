import type { Submission, SubmissionStatus } from "@intake/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { AdminListViewProps } from "@/components/admin/AdminListView";
import { AdminApiError, fetchSubmissions, logout } from "@/lib/adminApi";

const columns = createColumnHelper<Submission>();

const submissionColumns = [
  columns.accessor((row) => `${row.firstName} ${row.lastName}`, {
    id: "name",
    header: "Name",
  }),
  columns.accessor("externalId", {
    header: "Record ID",
  }),
  columns.accessor("status", {
    header: "Status",
  }),
  columns.accessor("createdAt", {
    header: "Submitted",
  }),
];

export function useAdminList(): AdminListViewProps {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [status, setStatus] = useState<SubmissionStatus | "all">("all");

  useEffect(() => {
    const timer = setTimeout(() => {
      setSubmittedQuery(query);
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  const list = useQuery({
    queryKey: ["submissions", status, submittedQuery],
    queryFn: () => fetchSubmissions({ status, query: submittedQuery }),
  });

  useEffect(() => {
    if (list.error instanceof AdminApiError && list.error.status === 401) {
      void navigate("/admin/login");
    }
  }, [list.error, navigate]);

  // TanStack Table owns the row model for the review list.
  // eslint-disable-next-line react-hooks/incompatible-library -- useReactTable is the library's API
  const table = useReactTable({
    data: list.data === undefined ? [] : [...list.data],
    columns: submissionColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  return {
    table,
    query,
    status,
    isLoading: list.isLoading,
    error: list.isError && !(list.error instanceof AdminApiError && list.error.status === 401) ? "Could not load submissions." : undefined,
    onGoHome: () => {
      void navigate("/");
    },
    onOpen: (id) => {
      void navigate(`/admin/submissions/${id}`);
    },
    onQueryChange: setQuery,
    onStatusChange: (value) => {
      setStatus(value);
    },
    onLogout: () => {
      void logout().finally(async () => {
        queryClient.clear();
        await navigate("/admin/login");
      });
    },
  };
}
