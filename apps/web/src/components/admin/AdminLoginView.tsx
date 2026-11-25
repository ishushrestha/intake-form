import type { SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AdminLoginViewProps {
  readonly password: string;
  readonly error?: string;
  readonly isSubmitting: boolean;
  readonly onPasswordChange: (value: string) => void;
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}

export function AdminLoginView(props: AdminLoginViewProps) {
  return (
    <div className="min-h-svh">
      <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
        <p className="text-sm font-medium tracking-[0.18em] text-primary uppercase">Admin</p>
        <h1 className="mt-3 text-4xl tracking-tight" id="admin-login-title">
          Review sign in
        </h1>
        <p className="mt-3 text-muted-foreground">One shared password opens the submission review desk.</p>
        <form aria-labelledby="admin-login-title" className="mt-8 space-y-4" noValidate onSubmit={props.onSubmit}>
          {props.error === undefined ? null : (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {props.error}
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="admin-password">Password</Label>
            <Input
              autoComplete="current-password"
              autoFocus
              id="admin-password"
              name="password"
              onChange={(event) => {
                props.onPasswordChange(event.target.value);
              }}
              type="password"
              value={props.password}
            />
          </div>
          <Button aria-busy={props.isSubmitting} className="w-full" disabled={props.isSubmitting} type="submit">
            {props.isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
