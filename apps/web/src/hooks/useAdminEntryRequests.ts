import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { AdminEntryRequestsViewProps } from "@/components/admin/AdminEntryRequestsView";
import { AdminApiError, fetchEntryRequests, logout, reviewEntryRequest } from "@/lib/adminApi";

export function useAdminEntryRequests(): AdminEntryRequestsViewProps {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [savingId, setSavingId] = useState<string | undefined>(undefined);

  const list = useQuery({
    queryKey: ["entry-requests"],
    queryFn: fetchEntryRequests,
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (list.error instanceof AdminApiError && list.error.status === 401) {
      void navigate("/admin/login");
    }
  }, [list.error, navigate]);

  const review = useMutation({
    mutationFn: ({ id, action }: { readonly id: string; readonly action: "verify" | "reject" }) =>
      reviewEntryRequest(id, action),
    onMutate: (variables) => {
      setSavingId(variables.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["entry-requests"] });
    },
    onSettled: () => {
      setSavingId(undefined);
    },
  });

  const error = review.isError
    ? review.error instanceof AdminApiError
      ? review.error.message
      : "Could not update the entry request."
    : list.isError && !(list.error instanceof AdminApiError && list.error.status === 401)
      ? "Could not load entry requests."
      : undefined;

  return {
    requests: list.data ?? [],
    isLoading: list.isLoading,
    isSaving: review.isPending,
    error,
    savingId,
    onGoHome: () => {
      void navigate("/");
    },
    onGoToSubmissions: () => {
      void navigate("/admin");
    },
    onGoToEntryRequests: () => {
      void navigate("/admin/entry-requests");
    },
    onOpenSubmission: (id) => {
      void navigate(`/admin/submissions/${id}`);
    },
    onVerify: (id) => {
      review.mutate({ id, action: "verify" });
    },
    onReject: (id) => {
      review.mutate({ id, action: "reject" });
    },
    onLogout: () => {
      void logout().finally(async () => {
        queryClient.clear();
        await navigate("/admin/login");
      });
    },
  };
}
