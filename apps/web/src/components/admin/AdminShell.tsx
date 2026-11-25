import type { MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function AdminShell({
  children,
  onGoHome,
  onLogout,
}: {
  readonly children: ReactNode;
  readonly onGoHome: () => void;
  readonly onLogout: () => void;
}) {
  return (
    <div className="min-h-svh">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium tracking-[0.18em] text-primary uppercase">Admin</p>
            <a
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              href="/"
              onClick={(event) => {
                if (!isPlainLeftClick(event)) {
                  return;
                }
                event.preventDefault();
                onGoHome();
              }}
            >
              Public intake
            </a>
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
