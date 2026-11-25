import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { useNavigate } from "react-router";
import type { AdminLoginViewProps } from "@/components/admin/AdminLoginView";
import { AdminApiError, login } from "@/lib/adminApi";

export function useAdminLogin(): AdminLoginViewProps {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-session"] });
      await navigate("/admin");
    },
  });

  const error = mutation.isError
    ? mutation.error instanceof AdminApiError
      ? mutation.error.message
      : "Could not sign in."
    : undefined;

  return {
    password,
    error,
    isSubmitting: mutation.isPending,
    onPasswordChange: setPassword,
    onSubmit: (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      mutation.mutate(password);
    },
  };
}
