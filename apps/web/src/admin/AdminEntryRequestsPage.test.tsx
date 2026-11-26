import type { EntryRequest, Submission } from "@intake/contracts";
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
  externalId: "A0001",
  status: "sent_to_records",
  image: { filename: "portrait.png", mimeType: "image/png", sizeBytes: 68 },
  createdAt: "2026-11-25T05:48:00.000Z",
  updatedAt: "2026-11-25T06:10:00.000Z",
  verifiedAt: "2026-11-25T06:00:00.000Z",
  rejectedAt: null,
  approvedAt: null,
  workerMessage: null,
  recordsRequestId: "6f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4f",
};

const pendingRequest: EntryRequest = {
  id: "6f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4f",
  submissionId: submission.id,
  status: "pending",
  artistId: "A0001",
  artistName: "Katherine Johnson",
  firstName: "Katherine",
  lastName: "Johnson",
  address: "1 Langley Boulevard, Hampton",
  notes: "Spacing checked.",
  entryId: null,
  recordsArtistId: null,
  failureReason: null,
  screenshotAvailable: false,
  verifyRequestedAt: null,
  createdAt: "2026-11-25T06:10:00.000Z",
  updatedAt: "2026-11-25T06:10:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function renderApp(path: string) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  window.history.pushState({}, "", path);
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

describe("LLM entry requests page", () => {
  it("is a separate admin page with Verify and Reject only while pending", async () => {
    const user = userEvent.setup();
    let current: EntryRequest = pendingRequest;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/admin/session")) {
          return json({ authenticated: true });
        }
        if (url.includes("/api/admin/entry-requests") && url.endsWith("/verify")) {
          current = { ...current, verifyRequestedAt: "2026-11-25T06:12:00.000Z" };
          return json(current);
        }
        if (url.includes("/api/admin/entry-requests") && !url.includes("/verify") && !url.includes("/reject")) {
          return json({ requests: [current] });
        }
        if (url.includes("/api/submissions")) {
          return json({ submissions: [submission] });
        }
        return json({ error: "not_found", message: "missing" }, 404);
      }),
    );

    renderApp("/admin");
    await user.click(await screen.findByRole("link", { name: "LLM entry requests" }));

    expect(await screen.findByRole("heading", { name: "LLM entry requests" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin/entry-requests");
    expect(screen.getByText("A0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Source submission" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Waiting for the local worker.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("shows Retry on a failed request and the real artist ID next to the entry ID when done", async () => {
    const failed: EntryRequest = {
      ...pendingRequest,
      status: "failed",
      failureReason: "records-admin login failed",
      screenshotAvailable: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/admin/session")) {
          return json({ authenticated: true });
        }
        if (url.includes("/api/admin/entry-requests")) {
          return json({
            requests: [
              failed,
              {
                ...pendingRequest,
                id: "7f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4a",
                status: "done",
                entryId: "entry-1",
                recordsArtistId: "A0001",
                verifyRequestedAt: "2026-11-25T06:12:00.000Z",
                screenshotAvailable: true,
              },
            ],
          });
        }
        return json({ error: "not_found", message: "missing" }, 404);
      }),
    );

    renderApp("/admin/entry-requests");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.getByText("Artist A0001 · Entry entry-1")).toBeInTheDocument();
  });
});
