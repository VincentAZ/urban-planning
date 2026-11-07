export interface Session {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified?: boolean;
    emailVerifiedAt?: string;
  } | null;
  platformAdmin?: boolean;
  organization?: { id: string; name: string };
  csrfToken?: string;
  role?: "owner" | "editor" | "commenter" | "viewer";
  membershipScope?: "workspace" | "project-only";
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
let csrfToken: string | undefined;
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (csrfToken && !headers.has("X-CSRF-Token"))
    headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: "include",
    headers,
  });
  const data = await response
    .json()
    .catch(() => ({ message: "The service returned an unreadable response." }));
  // A body already being decoded can finish after its account scope was cancelled.
  options.signal?.throwIfAborted();
  if (!response.ok)
    throw new ApiError(
      data.message ||
        data.error?.message ||
        (typeof data.error === "string"
          ? data.error
          : "Request failed. Please try again."),
      response.status,
      data.error?.code ?? data.code,
      data.error?.details ?? data.details,
    );
  if (data.csrfToken) csrfToken = data.csrfToken;
  else if (
    path === "/auth/logout" ||
    data.user === null ||
    ((path === "/auth/password-reset/confirm" ||
      path === "/auth/password/change") &&
      data.requireLogin === true)
  )
    csrfToken = undefined;
  return data as T;
}
export function download(
  name: string,
  content: string | Blob,
  type = "application/json",
) {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
