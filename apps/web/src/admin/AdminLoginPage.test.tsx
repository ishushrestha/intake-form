import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminLoginPage } from "@/admin/AdminLoginPage";

function renderLogin() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/admin/login"]}>
          <Routes>
            <Route element={children} path="/admin/login" />
            <Route element={<h1>Submissions</h1>} path="/admin" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(<AdminLoginPage />, { wrapper: Wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminLoginPage", () => {
  it("shows the server error when the password is wrong", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "unauthorized", message: "That password is not correct." }, { status: 401 }),
      ),
    );
    renderLogin();

    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That password is not correct.");
    expect(screen.getByLabelText("Password")).toHaveValue("nope");
  });

  it("opens the review desk after a successful sign in", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ authenticated: true }, { status: 200 })));
    renderLogin();

    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Submissions" })).toBeInTheDocument();
  });
});