"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import { suggestSession } from "@/lib/format";
import type { AcademicSession } from "@/lib/types";

interface Props {
  open: boolean;
  schoolId: string;
  session: AcademicSession | null; // null = create
  existing: AcademicSession[];
  onClose: () => void;
  onSaved: (s: AcademicSession) => void;
}

function nextSuggestion(existing: AcademicSession[]) {
  const latest = existing.reduce<number | null>((max, s) => {
    const y = Number(s.start_date.slice(0, 4));
    return max === null || y > max ? y : max;
  }, null);
  const now = new Date();
  const thisAcademicYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return suggestSession(latest === null ? thisAcademicYear : latest + 1);
}

export function SessionFormModal({ open, schoolId, session, existing, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [makeCurrent, setMakeCurrent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNameTouched(Boolean(session));
    if (session) {
      setName(session.name);
      setStart(session.start_date);
      setEnd(session.end_date);
      setMakeCurrent(false);
    } else {
      const s = nextSuggestion(existing);
      setName(s.name);
      setStart(s.start_date);
      setEnd(s.end_date);
      setMakeCurrent(!existing.some((x) => x.is_current));
    }
  }, [open, session, existing]);

  function onStartChange(value: string) {
    setStart(value);
    const year = Number(value.slice(0, 4));
    if (!nameTouched && year > 1900) {
      const s = suggestSession(year);
      setName(s.name);
      if (value.endsWith("-04-01")) setEnd(s.end_date);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Enter a session name, e.g. 2026-27.");
    if (!start || !end) return setError("Choose both a start and an end date.");
    if (end <= start) return setError("The end date must be after the start date.");
    setSaving(true);
    setError(null);
    try {
      const saved = session
        ? await apiFetch<AcademicSession>(`/sessions/${session.id}`, {
            method: "PATCH",
            schoolId,
            body: { name: name.trim(), start_date: start, end_date: end },
          })
        : await apiFetch<AcademicSession>("/sessions", {
            method: "POST",
            schoolId,
            body: { name: name.trim(), start_date: start, end_date: end, make_current: makeCurrent },
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
      onClose={saving ? () => {} : onClose}
      title={session ? `Edit ${session.name}` : "New academic session"}
      description={session ? undefined : "Indian schools usually run 1 April to 31 March."}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="session-form" loading={saving}>{session ? "Save changes" : "Create session"}</Button>
        </>
      }
    >
      <form id="session-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error && (
          <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="session-form-error">
            {error}
          </p>
        )}
        <TextField
          className="sm:col-span-2"
          label="Session name"
          required
          maxLength={50}
          value={name}
          onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
          hint="Shown on receipts, report cards and certificates."
        />
        <TextField label="Starts on" type="date" required value={start} onChange={(e) => onStartChange(e.target.value)} />
        <TextField label="Ends on" type="date" required value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
        {!session && (
          <label className="flex items-start gap-2.5 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-leaf-600)]"
              checked={makeCurrent}
              onChange={(e) => setMakeCurrent(e.target.checked)}
            />
            <span>
              Make this the current session
              <span className="block text-xs text-muted">New records (admissions, fees, attendance) will use the current session.</span>
            </span>
          </label>
        )}
      </form>
    </Modal>
  );
}
