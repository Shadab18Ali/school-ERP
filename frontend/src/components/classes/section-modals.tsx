"use client";

import { clsx } from "clsx";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, BulkResult, SchoolClass, Section } from "@/lib/types";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

function FormError({ error }: { error: string | null }) {
  return error ? (
    <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="modal-error">{error}</p>
  ) : null;
}

function parseCapacity(v: string): number | null | "invalid" {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : "invalid";
}

/** Assign the same sections (e.g. A–D) to several classes at once. */
export function AssignSectionsModal({ open, schoolId, session, classes, preselect, onClose, onDone }: {
  open: boolean; schoolId: string; session: AcademicSession; classes: SchoolClass[]; preselect: string[];
  onClose: () => void; onDone: (r: BulkResult) => void;
}) {
  const usable = useMemo(() => classes.filter((c) => c.is_active && !c.is_deleted), [classes]);
  const [classIds, setClassIds] = useState<Set<string>>(new Set());
  const [letters, setLetters] = useState<Set<string>>(new Set(["A"]));
  const [extra, setExtra] = useState("");
  const [capacity, setCapacity] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setClassIds(new Set(preselect));
    setLetters(new Set(["A"]));
    setExtra("");
    setCapacity("");
  }, [open, preselect]);

  const names = [...LETTERS.filter((l) => letters.has(l)), ...extra.split(",").map((s) => s.trim()).filter(Boolean)];
  const toggle = (set: Set<string>, v: string) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  async function submit() {
    if (classIds.size === 0) return setError("Choose at least one class.");
    if (names.length === 0) return setError("Choose at least one section name.");
    if (names.some((n) => n.length > 20)) return setError("Section names can be at most 20 characters.");
    const cap = parseCapacity(capacity);
    if (cap === "invalid") return setError("Capacity must be a whole number from 1 to 500.");
    setSaving(true);
    setError(null);
    try {
      onDone(await apiFetch<BulkResult>("/sections/bulk", {
        method: "POST", schoolId,
        body: { academic_session_id: session.id, class_ids: [...classIds], names, capacity: cap },
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const count = classIds.size * names.length;
  return (
    <Modal
      open={open}
      size="lg"
      onClose={saving ? () => {} : onClose}
      title="Assign sections to classes"
      description={`Session ${session.name}. Sections that already exist are skipped.`}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={count === 0}>Assign {count > 0 ? `up to ${count}` : ""} sections</Button>
      </>}
    >
      <div className="space-y-5">
        <FormError error={error} />
        <fieldset>
          <div className="mb-2 flex items-center justify-between">
            <legend className="text-sm font-medium">Classes</legend>
            <button type="button" className="text-xs text-leaf-700 hover:underline"
              onClick={() => setClassIds(classIds.size === usable.length ? new Set() : new Set(usable.map((c) => c.id)))}>
              {classIds.size === usable.length ? "Clear all" : "Select all"}
            </button>
          </div>
          {usable.length === 0 ? (
            <p className="text-sm text-muted">No active classes. Add or activate a class first.</p>
          ) : (
            <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
              {usable.map((c) => (
                <label key={c.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={classIds.has(c.id)}
                    onChange={() => setClassIds((s) => toggle(s, c.id))} />
                  <span className="truncate">{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Sections</legend>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Section letters">
            {LETTERS.map((l) => (
              <button key={l} type="button" aria-pressed={letters.has(l)} onClick={() => setLetters((s) => toggle(s, l))}
                className={clsx("size-10 rounded-md border text-sm font-semibold",
                  letters.has(l) ? "border-leaf-600 bg-leaf-600 text-white" : "border-line bg-white hover:bg-paper")}>
                {l}
              </button>
            ))}
          </div>
          <TextField className="mt-3" label="Other names (optional)" value={extra} onChange={(e) => setExtra(e.target.value)}
            hint="Comma-separated, e.g. Rose, Lily or Science, Commerce" />
        </fieldset>
        <TextField label="Capacity per section (optional)" inputMode="numeric" maxLength={3} value={capacity}
          onChange={(e) => setCapacity(e.target.value)} className="sm:max-w-xs" />
      </div>
    </Modal>
  );
}

/** Add one section, or edit one (including moving it to another class). */
export function SectionFormModal({ open, schoolId, session, classes, section, onClose, onSaved }: {
  open: boolean; schoolId: string; session: AcademicSession; classes: SchoolClass[]; section: Section | null;
  onClose: () => void; onSaved: (s: Section) => void;
}) {
  const usable = classes.filter((c) => (c.is_active && !c.is_deleted) || c.id === section?.class_id);
  const [classId, setClassId] = useState("");
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [room, setRoom] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setClassId(section?.class_id ?? usable[0]?.id ?? "");
    setName(section?.name ?? "");
    setCapacity(section?.capacity ? String(section.capacity) : "");
    setRoom(section?.room ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!classId) return setError("Choose a class.");
    if (!name.trim()) return setError("Enter a section name, e.g. A.");
    const cap = parseCapacity(capacity);
    if (cap === "invalid") return setError("Capacity must be a whole number from 1 to 500.");
    setSaving(true);
    setError(null);
    try {
      const saved = section
        ? await apiFetch<Section>(`/sections/${section.id}`, {
            method: "PATCH", schoolId,
            body: { class_id: classId, name: name.trim(), capacity: cap, room: room.trim() || null },
          })
        : await apiFetch<Section>("/sections", {
            method: "POST", schoolId,
            body: { class_id: classId, academic_session_id: session.id, name: name.trim(), capacity: cap, room: room.trim() || null },
          });
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
      title={section ? `Edit ${section.class_name} ${section.name}` : "Add section"}
      description={`Session ${session.name}`}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" form="section-form" loading={saving}>{section ? "Save changes" : "Add section"}</Button>
      </>}
    >
      <form id="section-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError error={error} />
        <SelectField label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
          {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <TextField label="Section name" required maxLength={20} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Capacity" inputMode="numeric" maxLength={3} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          <TextField label="Room" maxLength={50} value={room} onChange={(e) => setRoom(e.target.value)} />
        </div>
      </form>
    </Modal>
  );
}

/** Copy last year's sections (names, capacity, rooms) into the selected session. */
export function CopySectionsModal({ open, schoolId, target, sessions, onClose, onDone }: {
  open: boolean; schoolId: string; target: AcademicSession; sessions: AcademicSession[];
  onClose: () => void; onDone: (r: BulkResult) => void;
}) {
  const sources = sessions.filter((s) => s.id !== target.id);
  const [from, setFrom] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const earlier = sources.filter((s) => s.start_date < target.start_date).sort((a, b) => b.start_date.localeCompare(a.start_date));
    setFrom((earlier[0] ?? sources[0])?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.id]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      onDone(await apiFetch<BulkResult>("/sections/copy", { method: "POST", schoolId, body: { from_session_id: from, to_session_id: target.id } }));
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
      title={`Copy sections into ${target.name}`}
      description="Copies section names, capacities and rooms for active classes. Students are not copied."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!from}>Copy sections</Button>
      </>}
    >
      <div className="space-y-4">
        <FormError error={error} />
        {sources.length === 0 ? (
          <p className="text-sm text-muted">There is no other session to copy from.</p>
        ) : (
          <SelectField label="Copy from" value={from} onChange={(e) => setFrom(e.target.value)}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_archived ? " (archived)" : ""}</option>)}
          </SelectField>
        )}
      </div>
    </Modal>
  );
}
