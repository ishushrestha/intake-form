import { AdminEntryRequestsView } from "@/components/admin/AdminEntryRequestsView";
import { useAdminEntryRequests } from "@/hooks/useAdminEntryRequests";

export function AdminEntryRequestsPage() {
  const list = useAdminEntryRequests();
  return <AdminEntryRequestsView {...list} />;
}
