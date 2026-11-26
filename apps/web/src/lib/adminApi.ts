import {
  entryRequestListSchema,
  entryRequestSchema,
  submissionListSchema,
  submissionSchema,
  type EntryRequest,
  type Submission,
  type SubmissionStatus,
} from "@intake/contracts";

export class AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

async function readError(response: Response, fallback: string): Promise<AdminApiError> {
  const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof payload?.message === "string" ? payload.message : fallback;
  return new AdminApiError(response.status, message);
}

export async function fetchSession(): Promise<boolean> {
  const response = await fetch("/api/admin/session", { credentials: "include" });
  return response.ok;
}

export async function login(password: string): Promise<void> {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw await readError(response, "Could not sign in.");
  }
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
  if (!response.ok) {
    throw await readError(response, "Could not sign out.");
  }
}

export async function fetchSubmissions(filter: {
  readonly status: SubmissionStatus | "all";
  readonly query: string;
}): Promise<readonly Submission[]> {
  const params = new URLSearchParams();
  if (filter.status !== "all") {
    params.set("status", filter.status);
  }
  if (filter.query.trim().length > 0) {
    params.set("q", filter.query.trim());
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(`/api/submissions${query}`, { credentials: "include" });
  if (!response.ok) {
    throw await readError(response, "Could not load submissions.");
  }
  const parsed = submissionListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AdminApiError(response.status, "Could not load submissions.");
  }
  return parsed.data.submissions;
}

export async function fetchSubmission(id: string): Promise<Submission> {
  const response = await fetch(`/api/submissions/${id}`, { credentials: "include" });
  if (!response.ok) {
    throw await readError(response, "Could not load that submission.");
  }
  const parsed = submissionSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AdminApiError(response.status, "Could not load that submission.");
  }
  return parsed.data;
}

export async function submitToRecords(id: string): Promise<Submission> {
  const response = await fetch(`/api/admin/submissions/${id}/submit-to-records`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw await readError(response, "Could not queue the submission.");
  }
  const parsed = submissionSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AdminApiError(response.status, "Could not queue the submission.");
  }
  return parsed.data;
}

export async function fetchEntryRequests(): Promise<readonly EntryRequest[]> {
  const response = await fetch("/api/admin/entry-requests", { credentials: "include" });
  if (!response.ok) {
    throw await readError(response, "Could not load entry requests.");
  }
  const parsed = entryRequestListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AdminApiError(response.status, "Could not load entry requests.");
  }
  return parsed.data.requests;
}

export async function reviewEntryRequest(id: string, action: "verify" | "reject"): Promise<EntryRequest> {
  const response = await fetch(`/api/admin/entry-requests/${id}/${action}`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw await readError(response, "Could not update the entry request.");
  }
  const parsed = entryRequestSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AdminApiError(response.status, "Could not update the entry request.");
  }
  return parsed.data;
}

export async function reviewSubmission(id: string, action: "verify" | "reject" | "approve"): Promise<Submission> {
  const response = await fetch(`/api/submissions/${id}/${action}`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw await readError(response, "Could not update the submission.");
  }
  const parsed = submissionSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AdminApiError(response.status, "Could not update the submission.");
  }
  return parsed.data;
}
