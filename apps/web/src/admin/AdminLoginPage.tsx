import { AdminLoginView } from "@/components/admin/AdminLoginView";
import { useAdminLogin } from "@/hooks/useAdminLogin";

export function AdminLoginPage() {
  const login = useAdminLogin();
  return <AdminLoginView {...login} />;
}
