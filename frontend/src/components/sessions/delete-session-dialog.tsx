"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession } from "@/lib/types";

interface Props {
  session: AcademicSession | null;
  schoolId: string;
  onClose: () => void;
  onDeleted: () => void;
  onArchive: (s: AcademicSession) => void;
}

/** Deleting needs the name typed in; sessions that are current or hold records can't be deleted at all. */
export function DeleteSessionDialog({ session, schoolId, onClose, onDeleted, onArchive }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setTyped(""); setError(null); }, [session]);
  if (!session) return null;

  const blockedReason = session.is_current
    ? "This is the current session. Make another session current before deleting it."
    : session.usage.length > 0
      ? `It still has records: ${session.usage.map((u) => `${u.count} ${u.table}`).join(", ")}. Archive it instead to keep its history.`
      : null;
  const matches = typed.trim().toLowerCase() === session.name.trim().toLowerCase();

  async function del() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/sessions/${session.id}`, { method: "DELETE", schoolId, body: { confirm_name: typed } });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      size="sm"
      onClose={busy ? () => {} : onClose}
      title={blockedReason ? `${session.name} can't be deleted` : `Delete ${session.name}?`}
      footer={
        blockedReason ? (
          <>
            <Button variant="secondary" onClick={onClose}>OK</Button>
            {!session.is_current && !session.is_archived && (
              <Button onClick={() => onArchive(session)}>Archive instead</Button>
            )}
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={del} loading={busy} disabled={!matches} data-testid="confirm-delete-session">
              Delete permanently
            </Button>
          </>
        )
      }
    >
      {blockedReason ? (
        <p className="text-sm text-muted" data-testid="delete-blocked">{blockedReason}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">This session has no records. Deleting it can&apos;t be undone.</p>
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
          <TextField label={`Type ${session.name} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      )}
    </Modal>
  );
}
