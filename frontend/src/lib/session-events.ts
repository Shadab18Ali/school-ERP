import { apiFetch } from "@/lib/api";

/**
 * Tells the API about a sign-in or sign-out, for the audit log. Supabase Auth records sessions itself
 * and the database turns that into the log entry; this is the fallback where that isn't available
 * (the API keeps one entry per session either way). Best effort, and never more than 2 seconds:
 * it must not stop anyone signing in or out.
 */
export async function reportSessionEvent(event: "login" | "logout"): Promise<void> {
  try {
    await Promise.race([
      apiFetch("/auth/events", { method: "POST", body: { event } }),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    /* recording is best effort */
  }
}
