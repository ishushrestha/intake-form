import { IntakeFormView } from "@/components/IntakeFormView";
import { useIntakeForm } from "@/hooks/useIntakeForm";

export function IntakeForm() {
  const form = useIntakeForm();
  return <IntakeFormView {...form} />;
}
