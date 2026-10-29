"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, ClassList, FeeStructureList, SchoolClass } from "@/lib/types";

export function CopyStructureModal({ open, schoolId, structureId, className, sessions, defaultSessionId, onClose, onDone }: {
  open: boolean; schoolId: string; structureId: string; className: string; sessions: AcademicSession[];
  defaultSessionId: string; onClose: () => void; onDone: (created: number, skipped: string[]) => void;
}) {
  const writable = sessions.filter((s) => !s.is_archived);
  const [sessionId, setSessionId] = useState(defaultSessionId);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [percent, setPercent] = useState("0");
  const [roundTo, setRoundTo] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setSessionId(defaultSessionId); setPercent("0"); setRoundTo("1"); setError(null); } }, [open, defaultSessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;
    setPicked(new Set());
    Promise.all([
      apiFetch<ClassList>("/classes", { schoolId, query: { status: "active" } }),
      apiFetch<FeeStructureList>("/fee-structures", { schoolId, query: { session_id: sessionId } }),
    ]).then(([c, f]) => {
      setClasses(c.items);
      setTaken(new Set(f.items.map((x) => x.class_id)));
    }).catch((e) => setError(errorMessage(e)));
  }, [open, sessionId, schoolId]);

  async function submit() {
    if (picked.size === 0) return setError("Choose at least one class.");
    if (!/^-?\d{1,3}(\.\d{1,2})?$/.test(percent.trim()) || Number(percent) < -50 || Number(percent) > 100)
      return setError("The change must be a number between -50 and 100.");
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ created: string[]; skipped: string[] }>(`/fee-structures/${structureId}/copy`, {
        method: "POST", schoolId,
        body: {
          targets: [...picked].map((class_id) => ({ academic_session_id: sessionId, class_id })),
          increase_percent: percent.trim(), round_to: roundTo,
        },
      });
      onDone(r.created.length, r.skipped);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title={`Copy ${className} fee structure`}
      description="Creates new structures with the same items. Classes that already have one for that session are skipped."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} loading={busy} disabled={picked.size === 0} data-testid="confirm-copy">Copy to {picked.size || ""} {picked.size === 1 ? "class" : "classes"}</Button>
      </>}>
      <div className="space-y-5">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="copy-error">{error}</p>}
        <SelectField label="Into session" value={sessionId} onChange={(e) => setSessionId(e.target.value)} className="sm:max-w-xs">
          {writable.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
        </SelectField>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Classes</legend>
          <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {classes.map((c) => {
              const has = taken.has(c.id);
              return (
                <label key={c.id} className={`flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm ${has ? "text-muted" : ""}`}>
                  <input type="checkbox" aria-label={has ? `${c.name} (already has a fee structure)` : c.name} className="size-4 accent-[var(--color-leaf-600)]" disabled={has} checked={picked.has(c.id)}
                    onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                  <span className="truncate">{c.name}</span>
                  {has && <span className="ml-auto text-xs">has one</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Change amounts by (%)" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)}
            hint="e.g. 8 for an 8% increase; 0 to copy as is" />
          <SelectField label="Round to" value={roundTo} onChange={(e) => setRoundTo(e.target.value)}>
            {["1", "5", "10", "50", "100"].map((r) => <option key={r} value={r}>Nearest ₹{r}</option>)}
          </SelectField>
        </div>
      </div>
    </Modal>
  );
}
