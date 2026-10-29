import { config } from "@/lib/config";
import { createClient } from "@/lib/supabase/client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | null | undefined>;

interface Options {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
  /** Active tenant; sent as X-School-Id for school-scoped endpoints. */
  schoolId?: string | null;
  signal?: AbortSignal;
}

function messageFrom(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : null;
    const msg = (first.msg ?? "Invalid input").replace(/^Value error, /, "");
    return field && typeof field === "string" ? `${field.replace(/_/g, " ")}: ${msg}` : msg;
  }
  return null;
}

let expiring = false;

/** Session could not be recovered: clear it and send the user to sign in. */
async function endExpiredSession(): Promise<never> {
  if (!expiring && typeof window !== "undefined") {
    expiring = true;
    await createClient().auth.signOut({ scope: "local" });
    const next = encodeURIComponent(window.location.pathname);
    window.location.assign(`/login?reason=expired&next=${next}`);
  }
  throw new ApiError(401, "Your session has expired. Please sign in again.");
}

async function send(path: string, opts: Options, accessToken: string): Promise<Response> {
  const url = new URL(`${config.apiPrefix}${path}`, config.apiUrl);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  if (opts.schoolId) headers["X-School-Id"] = opts.schoolId;
  try {
    return await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    throw new ApiError(0, offline ? "You're offline. Connect to the internet and try again."
      : "The server can't be reached. Check your connection and try again.");
  }
}

/** Sends an authenticated request, refreshing the session once if the API rejects the token. */
async function request(path: string, opts: Options): Promise<Response> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession(); // refreshes automatically when near expiry
  if (!session) return endExpiredSession();

  let res = await send(path, opts, session.access_token);

  // Token rejected (expired or revoked elsewhere): try one refresh, then give up cleanly.
  if (res.status === 401) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) return endExpiredSession();
    res = await send(path, opts, data.session.access_token);
    if (res.status === 401) return endExpiredSession();
  }
  return res;
}

export async function apiFetch<T>(path: string, opts: Options = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, messageFrom(data) ?? `Request failed (${res.status}).`, data);
  return data as T;
}

function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* fall through */ }
  }
  return header.match(/filename="([^"]+)"/i)?.[1] ?? null;
}

/**
 * Downloads a protected file as an in-memory Blob. Files are never exposed as
 * URLs (public or signed); the bytes come through the API with the user's token.
 */
export async function apiFetchBlob(path: string, opts: Options = {}): Promise<{ blob: Blob; filename: string | null }> {
  const res = await request(path, opts);
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw new ApiError(res.status, messageFrom(data) ?? `Request failed (${res.status}).`, data);
  }
  return { blob: await res.blob(), filename: filenameFrom(res.headers.get("Content-Disposition")) };
}

/** Saves a Blob to the user's device with the given name. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
