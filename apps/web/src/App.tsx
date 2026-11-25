import { Link, Navigate, Route, Routes } from "react-router";
import { AdminDetailPage } from "@/admin/AdminDetailPage";
import { AdminGuard } from "@/admin/AdminGuard";
import { AdminListPage } from "@/admin/AdminListPage";
import { AdminLoginPage } from "@/admin/AdminLoginPage";
import { IntakeForm } from "@/intake/IntakeForm";

function PublicIntakePage() {
  return (
    <div className="min-h-svh">
      <div className="mx-auto grid max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start lg:py-20">
        <header className="space-y-6 lg:sticky lg:top-12">
          <p className="text-sm font-medium tracking-[0.18em] text-primary uppercase">Public intake</p>
          <div className="space-y-3">
            <h1 className="text-4xl tracking-tight text-balance sm:text-5xl" id="intake-title">
              Submit a record
            </h1>
            <p className="max-w-md text-lg text-muted-foreground">
              Send the details for review. An administrator checks every submission before it can be approved.
            </p>
          </div>
          <ol className="max-w-sm space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <span className="font-mono text-foreground">01</span>
              We store the submission as pending.
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-foreground">02</span>
              Review can mark it verified, approved, or rejected.
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-foreground">03</span>
              The record ID is how an approved submission finds its record.
            </li>
          </ol>
          <Link className="inline-block text-sm text-muted-foreground underline-offset-4 hover:underline" to="/admin">
            Admin review
          </Link>
        </header>
        <section className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
          <IntakeForm />
        </section>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<PublicIntakePage />} path="/" />
      <Route element={<AdminLoginPage />} path="/admin/login" />
      <Route
        element={
          <AdminGuard>
            <AdminListPage />
          </AdminGuard>
        }
        path="/admin"
      />
      <Route
        element={
          <AdminGuard>
            <AdminDetailPage />
          </AdminGuard>
        }
        path="/admin/submissions/:id"
      />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
