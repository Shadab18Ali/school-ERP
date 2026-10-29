"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { Guardian } from "@/lib/types";

const REL = { father: "Father", mother: "Mother", guardian: "Guardian", other: "Other" } as const;

/** Admins link parent accounts to a student. Only linked parents can see this child in the portal. */
export function GuardiansCard({ studentId, schoolId }: { studentId: string; schoolId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<Guardian[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [rel, setRel] = useState<keyof typeof REL>("mother");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Guardian | null>(null);
  const load = useCallback(() => apiFetch<Guardian[]>(`/students/${studentId}/guardians`, { schoolId }).then(setItems).catch(() => setItems([])), [studentId, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function link() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError("Enter the parent's email address.");
    if (name.trim().length < 2) return setError("Enter the parent's name.");
    setBusy(true); setError(null);
    try {
      setItems(await apiFetch<Guardian[]>(`/students/${studentId}/guardians`, { method: "POST", schoolId, body: { email: email.trim(), full_name: name.trim(), relationship: rel } }));
      toast.success("Parent linked. New accounts receive an email invitation to sign in.");
      setAdding(false); setEmail(""); setName("");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-5" data-testid="guardians-card">
      <div className="mb-3 flex items-center justify-between">
        <div><h3 className="font-semibold">Parents &amp; guardians</h3><p className="text-xs text-muted">Linked accounts can see this child in the parent portal.</p></div>
        {!adding && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Link parent</Button>}
      </div>
      {items && items.length === 0 && !adding && <p className="text-sm text-muted">No parent accounts linked.</p>}
      <ul className="divide-y divide-line">
        {items?.map((g) => (
          <li key={g.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span><span className="font-medium">{g.full_name ?? g.email}</span> <span className="text-muted">· {REL[g.relationship as keyof typeof REL] ?? g.relationship} · {g.email}</span></span>
            <button className="text-xs text-danger-600 hover:underline" onClick={() => setRemoving(g)}>Unlink</button>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="mt-3 space-y-3 rounded-md border border-line p-3">
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label="Parent's email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField label="Parent's name" value={name} onChange={(e) => setName(e.target.value)} />
            <SelectField label="Relationship" value={rel} onChange={(e) => setRel(e.target.value as keyof typeof REL)}>
              {(Object.keys(REL) as (keyof typeof REL)[]).map((r) => <option key={r} value={r}>{REL[r]}</option>)}
            </SelectField>
          </div>
          <div className="flex justify-end gap-2"><Button variant="secondary" size="sm" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button><Button size="sm" onClick={link} loading={busy} data-testid="confirm-link">Link</Button></div>
        </div>
      )}
      <ConfirmDialog open={removing !== null} title={`Unlink ${removing?.full_name ?? removing?.email}?`}
        message="They will immediately stop seeing this child in the parent portal." confirmLabel="Unlink"
        onCancel={() => setRemoving(null)} onConfirm={async () => {
          try { setItems(await apiFetch<Guardian[]>(`/students/${studentId}/guardians/${removing!.id}`, { method: "DELETE", schoolId })); toast.success("Unlinked."); setRemoving(null); }
          catch (e) { toast.error(errorMessage(e)); }
        }} />
    </section>
  );
}
