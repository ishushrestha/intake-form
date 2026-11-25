import { AdminListView } from "@/components/admin/AdminListView";
import { useAdminList } from "@/hooks/useAdminList";

export function AdminListPage() {
  const list = useAdminList();
  return <AdminListView {...list} />;
}
