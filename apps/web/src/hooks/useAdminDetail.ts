import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import type { AdminDetailViewProps } from "@/components/admin/AdminDetailView";
import { AdminApiError, fetchSubmission, logout, reviewSubmission } from "@/lib/adminApi";

export function useAdminDetail(): AdminDetailViewProps {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const id = params.id;

  const detail = useQuery({
    queryKey: ["submission", id],
    queryFn: () => fetchSubmission(id ?? ""),
    enabled: typeof id === "string" && id.length > 0,
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

  const error = review.isError
    ? review.error instanceof AdminApiError
      ? review.error.message
      : "Could not update the submission."
    : detail.isError && !(detail.error instanceof AdminApiError && detail.error.status === 401)
      ? "Could not load that submission."
      : undefined;

  return {
    submission: detail.data,
    isLoading: detail.isLoading,
    isSaving: review.isPending,
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
    onLogout: () => {
      void logout().finally(async () => {
        queryClient.clear();
        await navigate("/admin/login");
      });
    },
  };
}
