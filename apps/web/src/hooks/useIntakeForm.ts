import type { Submission } from "@intake/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { useForm } from "react-hook-form";
import type { IntakeFormViewProps } from "@/components/IntakeFormView";
import { createSubmission, IntakeApiError } from "@/lib/api";
import { intakeFieldNames, intakeFormSchema, isIntakeField, type IntakeFormValues } from "@/intake/schema";

interface FocusRequest {
  readonly id: string;
  readonly token: number;
}

function fieldMessage(message: unknown): string | undefined {
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

export function useIntakeForm(): IntakeFormViewProps {
  const [imageInputKey, setImageInputKey] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [success, setSuccess] = useState<Submission | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  const form = useForm<IntakeFormValues>({
    resolver: zodResolver(intakeFormSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      address: "",
      externalId: "",
    },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });

  useEffect(() => {
    return () => {
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (focus === null) {
      return;
    }
    document.getElementById(focus.id)?.focus();
  }, [focus]);

  const mutation = useMutation({
    mutationFn: createSubmission,
    onSuccess: (submission) => {
      setSuccess(submission);
      form.reset();
      setImageInputKey((key) => key + 1);
      setPreviewUrl(null);
      setFocus({ id: "submission-success-title", token: Date.now() });
    },
    onError: (error) => {
      if (error instanceof IntakeApiError && error.fields !== undefined) {
        let firstId: string | undefined;
        for (const [key, message] of Object.entries(error.fields)) {
          if (!isIntakeField(key)) {
            continue;
          }
          form.setError(key, { message });
          firstId ??= key;
        }
        setFocus({ id: firstId ?? "form-error", token: Date.now() });
        return;
      }
      setFocus({ id: "form-error", token: Date.now() });
    },
  });

  // react-hook-form exposes field values through watch().
  // eslint-disable-next-line react-hooks/incompatible-library -- this is the library's subscription API
  const values = form.watch();
  const image = values.image instanceof File ? values.image : null;
  const errors = form.formState.errors;
  const formError = mutation.isError
    ? mutation.error instanceof IntakeApiError && mutation.error.fields !== undefined
      ? "Check the highlighted fields."
      : "Something went wrong while saving your submission. Try again."
    : undefined;

  const validateOnChange = form.formState.submitCount > 0;

  function onImageSelected(file: File | null) {
    form.setValue("image", file as IntakeFormValues["image"], {
      shouldDirty: true,
      shouldValidate: validateOnChange,
    });
    setPreviewUrl(file === null ? null : URL.createObjectURL(file));
  }

  function onClearImage() {
    setImageInputKey((key) => key + 1);
    onImageSelected(null);
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    void form.handleSubmit(
      (submitted) => {
        mutation.mutate(submitted);
      },
      (fieldErrors) => {
        const first = intakeFieldNames.find((name) => fieldErrors[name] !== undefined);
        if (first !== undefined) {
          setFocus({ id: first, token: Date.now() });
        }
      },
    )(event);
  }

  function onStartAnother() {
    setSuccess(null);
    mutation.reset();
    form.reset();
    setFocus({ id: "firstName", token: Date.now() });
  }

  return {
    firstName: values.firstName ?? "",
    lastName: values.lastName ?? "",
    address: values.address ?? "",
    externalId: values.externalId ?? "",
    imageName: image?.name ?? null,
    imagePreviewUrl: previewUrl,
    imageInputKey,
    errors: {
      firstName: fieldMessage(errors.firstName?.message),
      lastName: fieldMessage(errors.lastName?.message),
      address: fieldMessage(errors.address?.message),
      externalId: fieldMessage(errors.externalId?.message),
      image: fieldMessage(errors.image?.message),
    },
    formError,
    isSubmitting: mutation.isPending,
    success,
    onFirstNameChange: (value) => {
      form.setValue("firstName", value, { shouldDirty: true, shouldValidate: validateOnChange });
    },
    onLastNameChange: (value) => {
      form.setValue("lastName", value, { shouldDirty: true, shouldValidate: validateOnChange });
    },
    onAddressChange: (value) => {
      form.setValue("address", value, { shouldDirty: true, shouldValidate: validateOnChange });
    },
    onExternalIdChange: (value) => {
      form.setValue("externalId", value, { shouldDirty: true, shouldValidate: validateOnChange });
    },
    onImageSelected,
    onClearImage,
    onSubmit,
    onStartAnother,
  };
}
