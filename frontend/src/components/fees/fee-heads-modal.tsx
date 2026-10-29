"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { FeeHead } from "@/lib/types";

export const COMMON_HEADS = [
  "Admission Fee", "Annual Fee", "Tuition Fee", "Exam Fee", "Transport Fee",
  "Development Fee", "Computer Fee", "Activity Fee", "Library Fee", "Sports Fee",
];

export function FeeHeadsModal({ open, schoolId, canManage, onClose, onChanged }: {
  open: boolean; schoolId: string; canManage: boolean; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [heads, setHeads] = useState<FeeHead[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setHeads(await apiFetch<FeeHead[]>("/fee-heads", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { if (open) { setError(null); void load(); } }, [open, load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Enter a name, e.g. Lab Fee.");
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/fee-heads", { method: "POST", schoolId, body: { name: name.trim() } });
      setName("");
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function addCommon() {
    setBusy(true);
    try {
      const r = await apiFetch<{ created: number }>("/fee-heads/bulk", { method: "POST", schoolId, body: { names: COMMON_HEADS } });
      toast.success(`${r.created} fee heads added.`);
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(h: FeeHead) {
    try {
      await apiFetch(`/fee-heads/${h.id}`, { method: "PATCH", schoolId, body: { is_active: !h.is_active } });
      await load();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const missingCommon = COMMON_HEADS.filter((n) => !heads?.some((h) => h.name.toLowerCase() === n.toLowerCase()));

  return (
    <Modal open={open} onClose={onClose} title="Fee heads"
      description="The names used on fee structures and receipts. Deactivate a head to stop using it; it stays on existing structures."
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="heads-error">{error}</p>}
        {canManage && (
          <form onSubmit={add} className="flex items-end gap-2">
            <TextField className="flex-1" label="New fee head" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" loading={busy}>Add</Button>
          </form>
        )}
        {canManage && heads && missingCommon.length > 0 && (
          <Button variant="secondary" size="sm" onClick={addCommon} disabled={busy}>Add common heads ({missingCommon.length})</Button>
        )}
        {!heads ? <LoadingState /> : heads.length === 0 ? (
          <p className="text-sm text-muted">No fee heads yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line" data-testid="heads-list">
            {heads.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className={h.is_active ? "" : "text-muted line-through"}>{h.name}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted">{h.used_in ? `on ${h.used_in} structure${h.used_in === 1 ? "" : "s"}` : "unused"}</span>
                  {canManage && (
                    <button className="text-xs text-leaf-700 hover:underline" onClick={() => toggle(h)}>{h.is_active ? "Deactivate" : "Activate"}</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
