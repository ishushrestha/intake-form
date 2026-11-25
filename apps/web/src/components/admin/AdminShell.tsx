import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export function AdminShell({
  children,
  onLogout,
}: {
  readonly children: ReactNode;
  readonly onLogout: () => void;
}) {
  return (
    <div className="min-h-svh">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium tracking-[0.18em] text-primary uppercase">Admin</p>
            <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" to="/">
              Public intake
            </Link>
          </div>
          <Button onClick={onLogout} type="button" variant="outline">
            Log out
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}
