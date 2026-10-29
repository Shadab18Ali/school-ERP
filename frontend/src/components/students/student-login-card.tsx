"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";

interface Login { linked: boolean; email: string | null; full_name: string | null }

/** Admins give a student their own login. It only ever shows that student's information. */
export function StudentLoginCard({ studentId, schoolId }: { studentId: string; schoolId: string }) {
  const toast = useToast();
  const [login, setLogin] = useState<Login | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const path = `/students/${studentId}/login`;
  const load = useCallback(() => apiFetch<Login>(path, { schoolId }).then(setLogin).catch(() => setLogin(null)), [path, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError("Enter the student's email address.");
    setBusy(true); setError(null);
    try {
      setLogin(await apiFetch<Login>(path, { method: "PUT", schoolId, body: { email: email.trim() } }));
      toast.success("Student login created. New accounts receive an email invitation to sign in.");
      setAdding(false); setEmail("");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-5" data-testid="student-login-card">
      <div className="mb-3 flex items-center justify-between">
        <div><h3 className="font-semibold">Student login</h3><p className="text-xs text-muted">Lets the student see only their own information.</p></div>
        {login && !login.linked && !adding && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Create login</Button>}
      </div>
      {!login ? null : login.linked ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span><span className="font-medium">{login.email}</span>{login.full_name ? <span className="text-muted"> · {login.full_name}</span> : null}</span>
          <button className="text-xs text-danger-600 hover:underline" onClick={() => setRemoving(true)}>Remove login</button>
        </div>
      ) : !adding ? <p className="text-sm text-muted">No login yet.</p> : (
        <div className="space-y-3 rounded-md border border-line p-3">
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
          <TextField label="Student's email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Use the student's own email, not a parent's." />
          <div className="flex justify-end gap-2"><Button variant="secondary" size="sm" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button><Button size="sm" onClick={create} loading={busy} data-testid="confirm-student-login">Create login</Button></div>
        </div>
      )}
      <ConfirmDialog open={removing} title="Remove this student's login?" message="They will immediately lose access. Their records are not affected." confirmLabel="Remove"
        onCancel={() => setRemoving(false)} onConfirm={async () => {
          try { setLogin(await apiFetch<Login>(path, { method: "DELETE", schoolId })); toast.success("Login removed."); setRemoving(false); }
          catch (e) { toast.error(errorMessage(e)); }
        }} />
    </section>
  );
}
