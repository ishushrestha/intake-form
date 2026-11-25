import type { Submission } from "@intake/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRouter } from "react-router";
import { App } from "@/App";

const submission: Submission = {
  id: "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d",
  firstName: "Katherine",
  lastName: "Johnson",
  address: "1 Langley Boulevard, Hampton",
  externalId: "rec_admin_2",
  status: "pending",
  image: { filename: "portrait.png", mimeType: "image/png", sizeBytes: 68 },
  createdAt: "2026-11-25T05:48:00.000Z",
  updatedAt: "2026-11-25T05:48:00.000Z",
  verifiedAt: null,
  rejectedAt: null,
  approvedAt: null,
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/admin/session")) {
        return json({ authenticated: true });
      }
      if (url.includes("/api/submissions?")) {
        return json({ submissions: [submission] });
      }
      if (url.endsWith(`/api/submissions/${submission.id}`)) {
        return json(submission);
      }
      if (url.endsWith("/api/submissions")) {
        return json({ submissions: [submission] });
      }
      return json({ error: "not_found", message: "missing" }, 404);
    }),
  );
}

function renderAdmin() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  window.history.pushState({}, "", "/admin");
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("admin list navigation", () => {
  it("opens the detail page from the name link and returns with Back", async () => {
    installFetch();
    const user = userEvent.setup();
    renderAdmin();

    await user.click(await screen.findByRole("link", { name: "Katherine Johnson" }));

    expect(await screen.findByRole("button", { name: "Mark verified" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Katherine Johnson" })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/admin/submissions/${submission.id}`);

    await user.click(screen.getByRole("link", { name: "Back to submissions" }));
    expect(await screen.findByRole("heading", { name: "Submissions" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin");
  });

  it("opens the detail page from a left-click or Enter on the row", async () => {
    installFetch();
    const user = userEvent.setup();
    renderAdmin();

    await user.click(await screen.findByText("rec_admin_2"));
    expect(await screen.findByRole("button", { name: "Mark verified" })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/admin/submissions/${submission.id}`);

    await user.click(screen.getByRole("link", { name: "Back to submissions" }));
    await screen.findByRole("heading", { name: "Submissions" });

    const row = screen.getByRole("row", { name: /rec_admin_2/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Mark verified" })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/admin/submissions/${submission.id}`);
  });
});
