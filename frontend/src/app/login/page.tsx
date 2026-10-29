"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { authErrorMessage } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/client";
import { reportSessionEvent } from "@/lib/session-events";
import { safeNextPath } from "@/lib/safe-path";


function LoginForm() {
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const reason = params.get("reason");
  const [error, setError] = useState<string | null>(
    params.get("error") === "invalid_link"
      ? "That link is invalid or has expired. Request a new one."
      : reason === "expired"
        ? "Your session has expired. Please sign in again."
        : null,
  );
  const [notice, setNotice] = useState<string | null>(reason === "signed_out" ? "You've been signed out." : null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        setError(authErrorMessage(error));
        setPassword("");
        setLoading(false);
        return;
      }
      // the sign-in goes in the audit log (Supabase records it too; the API keeps one entry per session)
      await reportSessionEvent("login");
      // Full load so the server-rendered shell sees the new session cookie.
      window.location.assign(safeNextPath(params.get("next")));
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
      setLoading(false);
      if (error) return setError(authErrorMessage(error));
      setNotice("If an account exists for this email, a reset link is on its way.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="form-error">{error}</p>}
      {notice && <p className="rounded-md bg-leaf-50 px-3 py-2 text-sm text-leaf-700" role="status" data-testid="form-notice">{notice}</p>}
      <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      {mode === "signin" && (
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      )}
      <Button type="submit" className="w-full" loading={loading} data-testid="sign-in" disabled={!email || (mode === "signin" && !password)}>
        {mode === "signin" ? "Sign in" : "Send reset link"}
      </Button>
      <button
        type="button"
        onClick={() => { setMode(mode === "signin" ? "reset" : "signin"); setError(null); setNotice(null); }}
        className="w-full text-center text-sm text-leaf-700 hover:underline"
      >
        {mode === "signin" ? "Forgot your password?" : "Back to sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <section className="hidden flex-col justify-between bg-board-900 p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-md bg-pencil-400 font-bold text-board-950">S</div>
          <span className="text-lg font-semibold">School ERP</span>
        </div>
        <div className="max-w-md">
          <p className="text-3xl font-semibold leading-snug tracking-tight">
            Admissions, fees, attendance and results for your whole school, in one place.
          </p>
          <p className="mt-4 text-white/60">Every school&apos;s data is kept separate and visible only to its own staff, parents and students.</p>
        </div>
        <p className="text-sm text-white/65">Need an account? Ask your school administrator for an invite.</p>
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mb-6 mt-1 text-sm text-muted">Use the email your school invited.</p>
          <Suspense><LoginForm /></Suspense>
        </div>
      </section>
    </div>
  );
}
