import type { SubmitEvent } from "react";
import type { Submission, SubmissionStatus } from "@intake/contracts";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const statusLabels: Record<SubmissionStatus, string> = {
  pending: "Pending review",
  verified: "Verified",
  approved: "Approved",
  rejected: "Rejected",
  queued: "Queued",
  processing: "Processing",
  sent_to_records: "Sent to records",
  id_not_found: "ID not found",
  failed: "Failed",
};

export interface IntakeFormViewProps {
  readonly firstName: string;
  readonly lastName: string;
  readonly address: string;
  readonly externalId: string;
  readonly imageName: string | null;
  readonly imagePreviewUrl: string | null;
  readonly imageInputKey: number;
  readonly errors: {
    readonly firstName?: string;
    readonly lastName?: string;
    readonly address?: string;
    readonly externalId?: string;
    readonly image?: string;
  };
  readonly formError?: string;
  readonly isSubmitting: boolean;
  readonly success: Submission | null;
  readonly onFirstNameChange: (value: string) => void;
  readonly onLastNameChange: (value: string) => void;
  readonly onAddressChange: (value: string) => void;
  readonly onExternalIdChange: (value: string) => void;
  readonly onImageSelected: (file: File | null) => void;
  readonly onClearImage: () => void;
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly onStartAnother: () => void;
}

function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="text-destructive">
        {" "}
        *
      </span>
      <span className="sr-only"> required</span>
    </>
  );
}

function FieldError({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  if (message === undefined) {
    return null;
  }
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function describedBy(hintId: string | undefined, errorId: string, message: string | undefined): string | undefined {
  const ids = [hintId, message === undefined ? undefined : errorId].filter((id) => id !== undefined);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function IntakeFormView(props: IntakeFormViewProps) {
  if (props.success) {
    return (
      <section aria-labelledby="submission-success-title" className="space-y-6" role="status">
        <div className="space-y-2">
          <p className="text-sm font-medium tracking-[0.16em] text-primary uppercase">Received</p>
          <h2
            className="text-3xl tracking-tight text-balance"
            id="submission-success-title"
            tabIndex={-1}
          >
            Submission received
          </h2>
          <p className="text-muted-foreground">
            It is waiting for review. Nothing is sent on until an administrator approves it.
          </p>
        </div>
        <dl className="grid gap-4 rounded-lg border border-border bg-muted/60 p-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Reference</dt>
            <dd className="font-mono text-base break-all">{props.success.id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{statusLabels[props.success.status]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Record ID</dt>
            <dd className="font-mono">{props.success.externalId}</dd>
          </div>
        </dl>
        <Button onClick={props.onStartAnother} type="button" variant="outline">
          Submit another
        </Button>
      </section>
    );
  }

  return (
    <form aria-labelledby="intake-title" className="space-y-6" noValidate onSubmit={props.onSubmit}>
      {props.formError === undefined ? null : (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          id="form-error"
          role="alert"
          tabIndex={-1}
        >
          {props.formError}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="firstName">
            First name
            <RequiredMark />
          </Label>
          <Input
            aria-describedby={describedBy(undefined, "firstName-error", props.errors.firstName)}
            aria-invalid={props.errors.firstName === undefined ? undefined : true}
            aria-required="true"
            autoComplete="given-name"
            id="firstName"
            name="firstName"
            onChange={(event) => {
              props.onFirstNameChange(event.target.value);
            }}
            value={props.firstName}
          />
          <FieldError id="firstName-error" message={props.errors.firstName} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">
            Last name
            <RequiredMark />
          </Label>
          <Input
            aria-describedby={describedBy(undefined, "lastName-error", props.errors.lastName)}
            aria-invalid={props.errors.lastName === undefined ? undefined : true}
            aria-required="true"
            autoComplete="family-name"
            id="lastName"
            name="lastName"
            onChange={(event) => {
              props.onLastNameChange(event.target.value);
            }}
            value={props.lastName}
          />
          <FieldError id="lastName-error" message={props.errors.lastName} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">
          Address
          <RequiredMark />
        </Label>
        <Textarea
          aria-describedby={describedBy("address-hint", "address-error", props.errors.address)}
          aria-invalid={props.errors.address === undefined ? undefined : true}
          aria-required="true"
          autoComplete="street-address"
          id="address"
          name="address"
          onChange={(event) => {
            props.onAddressChange(event.target.value);
          }}
          value={props.address}
        />
        <p className="text-sm text-muted-foreground" id="address-hint">
          Street, city, and anything else needed to find the place.
        </p>
        <FieldError id="address-error" message={props.errors.address} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="externalId">
          Record ID
          <RequiredMark />
        </Label>
        <Input
          aria-describedby={describedBy("externalId-hint", "externalId-error", props.errors.externalId)}
          aria-invalid={props.errors.externalId === undefined ? undefined : true}
          aria-required="true"
          autoComplete="off"
          id="externalId"
          name="externalId"
          onChange={(event) => {
            props.onExternalIdChange(event.target.value);
          }}
          spellCheck={false}
          value={props.externalId}
        />
        <p className="text-sm text-muted-foreground" id="externalId-hint">
          The record this submission should update. Letters, numbers, and . _ - only.
        </p>
        <FieldError id="externalId-error" message={props.errors.externalId} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="image">
          Image
          <RequiredMark />
        </Label>
        <p className="text-sm text-muted-foreground" id="image-hint">
          JPEG, PNG, or WebP. Maximum 5 MB. A preview appears before you submit.
        </p>
        <div className="space-y-3">
          <label
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-input bg-muted/40 p-4 text-sm transition-colors hover:bg-accent/60 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
            htmlFor="image"
          >
            {props.imagePreviewUrl === null ? (
              <>
                <ImagePlus aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="font-medium text-foreground">Choose image</span>
                  <span className="mt-1 block text-muted-foreground">No image selected.</span>
                </span>
              </>
            ) : (
              <span className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
                <img
                  alt="Selected image preview"
                  className="h-32 w-full rounded-md border border-border bg-card object-contain sm:w-40"
                  src={props.imagePreviewUrl}
                />
                <span>
                  <span className="block font-medium text-foreground">Replace image</span>
                  <span className="mt-1 block break-all text-muted-foreground">{props.imageName}</span>
                </span>
              </span>
            )}
          </label>
          {props.imagePreviewUrl === null ? null : (
            <Button onClick={props.onClearImage} type="button" variant="outline">
              Remove image
            </Button>
          )}
          <input
            accept="image/jpeg,image/png,image/webp"
            aria-describedby={describedBy("image-hint", "image-error", props.errors.image)}
            aria-invalid={props.errors.image === undefined ? undefined : true}
            aria-required="true"
            className="sr-only"
            id="image"
            key={props.imageInputKey}
            name="image"
            onChange={(event) => {
              props.onImageSelected(event.target.files?.[0] ?? null);
            }}
            type="file"
          />
        </div>
        <FieldError id="image-error" message={props.errors.image} />
      </div>

      <div className="flex items-center justify-between gap-4 pt-2">
        <p className="text-sm text-muted-foreground">All fields are required.</p>
        <Button aria-busy={props.isSubmitting} disabled={props.isSubmitting} type="submit">
          {props.isSubmitting ? "Submitting…" : "Submit intake"}
        </Button>
      </div>
    </form>
  );
}
