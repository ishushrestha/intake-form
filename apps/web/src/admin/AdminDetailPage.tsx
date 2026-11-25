import { AdminDetailView } from "@/components/admin/AdminDetailView";
import { useAdminDetail } from "@/hooks/useAdminDetail";

export function AdminDetailPage() {
  const detail = useAdminDetail();
  return <AdminDetailView {...detail} />;
}
