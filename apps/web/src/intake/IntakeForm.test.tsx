import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntakeForm } from "@/intake/IntakeForm";

const submission = {
  id: "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d",
  firstName: "Ada",
  lastName: "Lovelace",
  address: "12 Analytical Engine\nLondon",
  externalId: "rec_1001",
  status: "pending",
  image: {
    filename: "portrait.png",
    mimeType: "image/png",
    sizeBytes: 68,
  },
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
  verifiedAt: null,
  rejectedAt: null,
  approvedAt: null,
};

function renderForm() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<IntakeForm />, { wrapper: Wrapper });
}

async function fillValidFields(user: ReturnType<typeof userEvent.setup>, image?: File) {
  await user.type(screen.getByLabelText(/first name/i), "Ada");
  await user.type(screen.getByLabelText(/last name/i), "Lovelace");
  await user.type(screen.getByLabelText(/^address/i), "12 Analytical Engine\nLondon");
  await user.type(screen.getByLabelText(/record id/i), "rec_1001");
  if (image !== undefined) {
    await user.upload(screen.getByLabelText(/^image/i), image);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IntakeForm", () => {
  it("shows inline errors and does not submit an empty form", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderForm();

    await user.click(screen.getByRole("button", { name: "Submit intake" }));

    expect(await screen.findByText("Enter a first name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a last name.")).toBeInTheDocument();
    expect(screen.getByText("Enter an address.")).toBeInTheDocument();
    expect(screen.getByText("Enter the record ID.")).toBeInTheDocument();
    expect(screen.getByText("Choose a JPEG, PNG, or WebP image.")).toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("id", "firstName");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a record id with spaces and a file that is not an image", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    renderForm();

    await user.type(screen.getByLabelText(/first name/i), "Ada");
    await user.type(screen.getByLabelText(/last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/^address/i), "12 Analytical Engine\nLondon");
    await user.type(screen.getByLabelText(/record id/i), "not valid");
    const imageInput = screen.getByLabelText(/^image/i);
    fireEvent.change(imageInput, {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });
    await user.click(screen.getByRole("button", { name: "Submit intake" }));

    expect(await screen.findByText(/letters, numbers, dots, underscores, or hyphens/i)).toBeInTheDocument();
    expect(screen.getByText("Use a JPEG, PNG, or WebP image.")).toBeInTheDocument();
  });

  it("shows a success state after the server accepts the submission", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(submission, {
          status: 201,
        }),
      ),
    );
    renderForm();

    const image = new File([new Uint8Array([1, 2, 3])], "portrait.png", { type: "image/png" });
    await fillValidFields(user, image);
    expect(screen.getByRole("img", { name: "Selected image preview" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit intake" }));

    expect(await screen.findByRole("heading", { name: "Submission received" })).toBeInTheDocument();
    expect(screen.getByText(submission.id)).toBeInTheDocument();
    expect(screen.getByText("Pending review")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("id", "submission-success-title");
    });
  });

  it("keeps the entered values when the server fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "internal_error", message: "database unavailable" },
          { status: 500 },
        ),
      ),
    );
    renderForm();

    await fillValidFields(user, new File([new Uint8Array([1])], "portrait.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Submit intake" }));

    expect(
      await screen.findByText("Something went wrong while saving your submission. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toHaveValue("Ada");
    expect(screen.getByLabelText(/record id/i)).toHaveValue("rec_1001");
    expect(screen.queryByRole("heading", { name: "Submission received" })).not.toBeInTheDocument();
  });
});
