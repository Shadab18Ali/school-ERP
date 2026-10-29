"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import type { BulkResult, SchoolClass } from "@/lib/types";

export const STANDARD_CLASSES = ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)];

function FormError({ error }: { error: string | null }) {
  return error ? (
    <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="modal-error">{error}</p>
  ) : null;
}

export function ClassFormModal({ open, schoolId, cls, onClose, onSaved }: {
  open: boolean; schoolId: string; cls: SchoolClass | null; onClose: () => void; onSaved: (c: SchoolClass) => void;
}) {
  const [name, setName] = useState("");
  const [order, setOrder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(cls?.name ?? "");
    setOrder(cls ? String(cls.display_order) : "");
  }, [open, cls]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a class name, e.g. Class 6.");
    if (order && !(Number.isInteger(Number(order)) && Number(order) >= 0 && Number(order) <= 999))
      return setError("Order must be a whole number from 0 to 999.");
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { name: name.trim() };
    if (order !== "") body.display_order = Number(order);
    try {
      const saved = cls
        ? await apiFetch<SchoolClass>(`/classes/${cls.id}`, { method: "PATCH", schoolId, body })
        : await apiFetch<SchoolClass>("/classes", { method: "POST", schoolId, body });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      size="sm"
      onClose={saving ? () => {} : onClose}
      title={cls ? `Edit ${cls.name}` : "Add class"}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" form="class-form" loading={saving}>{cls ? "Save changes" : "Add class"}</Button>
      </>}
    >
      <form id="class-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError error={error} />
        <TextField label="Class name" required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} hint="e.g. Nursery, LKG, Class 6" />
        <TextField label="Display order" inputMode="numeric" maxLength={3} value={order} onChange={(e) => setOrder(e.target.value)}
          hint={cls ? "Lower numbers appear first." : "Leave empty to add it at the end."} />
      </form>
    </Modal>
  );
}

export function StandardClassesModal({ open, schoolId, existing, onClose, onDone }: {
  open: boolean; schoolId: string; existing: SchoolClass[]; onClose: () => void; onDone: (r: BulkResult) => void;
}) {
  const taken = new Set(existing.filter((c) => !c.is_deleted).map((c) => c.name.toLowerCase()));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPicked(new Set(STANDARD_CLASSES.filter((n) => !taken.has(n.toLowerCase()))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const classes = STANDARD_CLASSES.map((name, i) => ({ name, display_order: i + 1 })).filter((c) => picked.has(c.name));
      onDone(await apiFetch<BulkResult>("/classes/bulk", { method: "POST", schoolId, body: { classes } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title="Add standard classes"
      description="Nursery to Class 12, in the usual order. Classes you already have are left as they are."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={picked.size === 0}>Add {picked.size} classes</Button>
      </>}
    >
      <div className="space-y-3">
        <FormError error={error} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {STANDARD_CLASSES.map((n) => {
            const exists = taken.has(n.toLowerCase());
            return (
              <label key={n} className={`flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm ${exists ? "text-muted" : ""}`}>
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-leaf-600)]"
                  disabled={exists}
                  checked={exists || picked.has(n)}
                  onChange={(e) => setPicked((p) => { const next = new Set(p); if (e.target.checked) next.add(n); else next.delete(n); return next; })}
                />
                {n}{exists && <span className="ml-auto text-xs">added</span>}
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
