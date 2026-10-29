import type { AuthError } from "@supabase/supabase-js";

/** Turns Supabase Auth errors into messages a school user can act on. */
export function authErrorMessage(error: AuthError | null | undefined): string {
  if (!error) return "Something went wrong. Please try again.";
  switch (error.code) {
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "email_not_confirmed":
      return "This email hasn't been confirmed yet. Use the link in your invite email first.";
    case "user_banned":
      return "This account has been disabled. Contact your school administrator.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Wait a minute and try again.";
    case "weak_password":
      return "Choose a stronger password: at least 8 characters, not easy to guess.";
    case "same_password":
      return "The new password must be different from the current one.";
    case "session_not_found":
    case "session_expired":
      return "Your session has expired. Please sign in again.";
  }
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  if (error.name === "AuthRetryableFetchError" || error.status === 0)
    return "Can't reach the sign-in service. Check your internet connection.";
  return error.message || "Something went wrong. Please try again.";
}
