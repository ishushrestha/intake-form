import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import type { AdminDetailViewProps } from "@/components/admin/AdminDetailView";
import { AdminApiError, fetchSubmission, logout, reviewSubmission, submitToRecords } from "@/lib/adminApi";

export function useAdminDetail(): AdminDetailViewProps {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const id = params.id;

  const detail = useQuery({
    queryKey: ["submission", id],
    queryFn: () => fetchSubmission(id ?? ""),
    enabled: typeof id === "string" && id.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "processing" ? 3000 : false;
    },
  });

  useEffect(() => {
    if (detail.error instanceof AdminApiError && detail.error.status === 401) {
      void navigate("/admin/login");
    }
  }, [detail.error, navigate]);

  const review = useMutation({
    mutationFn: (action: "verify" | "reject" | "approve") => reviewSubmission(id ?? "", action),
    onSuccess: async (submission) => {
      queryClient.setQueryData(["submission", id], submission);
      await queryClient.invalidateQueries({ queryKey: ["submissions"] });
    },
  });

  const queue = useMutation({
    mutationFn: () => submitToRecords(id ?? ""),
    onSuccess: async (submission) => {
      queryClient.setQueryData(["submission", id], submission);
      await queryClient.invalidateQueries({ queryKey: ["submissions"] });
    },
  });

  const actionError = queue.isError ? queue.error : review.isError ? review.error : undefined;
  const error = actionError instanceof AdminApiError
    ? actionError.message
    : actionError !== undefined
      ? "Could not update the submission."
      : detail.isError && !(detail.error instanceof AdminApiError && detail.error.status === 401)
        ? "Could not load that submission."
        : undefined;

  return {
    submission: detail.data,
    isLoading: detail.isLoading,
    isSaving: review.isPending || queue.isPending,
    error,
    onBack: () => {
      void navigate("/admin");
    },
    onGoHome: () => {
      void navigate("/");
    },
    onVerify: () => {
      review.mutate("verify");
    },
    onReject: () => {
      review.mutate("reject");
    },
    onApprove: () => {
      review.mutate("approve");
    },
    onSubmitToRecords: () => {
      queue.mutate();
    },
    onLogout: () => {
      void logout().finally(async () => {
        queryClient.clear();
        await navigate("/admin/login");
      });
    },
  };
}
