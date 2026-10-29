"use client";

import { clsx } from "clsx";
import { CalendarRange, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { AcademicSession } from "@/lib/types";
import { DeleteSessionDialog } from "./delete-session-dialog";
import { SessionFormModal } from "./session-form-modal";

interface Props {
  schoolId: string;
  canManage: boolean;
  /** Called after the current session changes, so headers etc. can refresh. */
  onCurrentChanged?: () => void;
}

type Pending = { kind: "current" | "archive" | "restore"; session: AcademicSession } | null;

export function SessionsManager({ schoolId, canManage, onCurrentChanged }: Props) {
  const toast = useToast();
  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AcademicSession | null>(null);
  const [deleting, setDeleting] = useState<AcademicSession | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await apiFetch<AcademicSession[]>("/sessions", { schoolId }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [schoolId]);

  useEffect(() => {
    setSessions(null);
    void load();
  }, [load]);

  const archivedCount = sessions?.filter((s) => s.is_archived).length ?? 0;
  const visible = useMemo(() => sessions?.filter((s) => showArchived || !s.is_archived) ?? [], [sessions, showArchived]);
  const current = sessions?.find((s) => s.is_current) ?? null;

  async function runPending() {
    if (!pending) return;
    const { kind, session } = pending;
    setBusy(true);
    try {
      const path = kind === "current" ? "set-current" : kind;
      await apiFetch(`/sessions/${session.id}/${path}`, { method: "POST", schoolId });
      toast.success(
        kind === "current" ? `${session.name} is now the current session.`
          : kind === "archive" ? `${session.name} archived.` : `${session.name} restored.`,
      );
      setPending(null);
      await load();
      if (kind === "current") onCurrentChanged?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!sessions) return <LoadingState label="Loading sessions…" />;

  return (
    <section className="rounded-lg border border-line bg-white" aria-label="Academic sessions">
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted">Current session</p>
          <p className="text-lg font-semibold" data-testid="current-session-name">{current?.name ?? "Not set"}</p>
        </div>
        <div className="flex items-center gap-3">
          {archivedCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived ({archivedCount})
            </label>
          )}
          {canManage && (
            <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="size-4" /> New session
            </Button>
          )}
        </div>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={CalendarRange}
          title="No academic sessions yet"
          message={canManage ? "Create the current year's session, e.g. 2026-27. Admissions, fees and attendance are recorded against it." : "An administrator hasn't set up sessions yet."}
          action={canManage ? <Button onClick={() => setFormOpen(true)}><Plus className="size-4" /> New session</Button> : undefined}
        />
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((s) => (
            <li key={s.id} className={clsx("flex items-center gap-4 px-4 py-3", s.is_archived && "bg-paper/60")} data-testid={`session-${s.name}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{s.name}</p>
                  {s.is_current && <span className="rounded-full bg-pencil-100 px-2 py-0.5 text-xs font-medium">Current</span>}
                  {s.is_archived && <span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs font-medium text-muted">Archived</span>}
                </div>
                <p className="tabular text-sm text-muted">
                  {formatDate(s.start_date)} – {formatDate(s.end_date)}
                  <span className="hidden sm:inline">
                    {" · "}{s.usage.length ? s.usage.map((u) => `${u.count} ${u.table}`).join(", ") : "no records yet"}
                  </span>
                </p>
              </div>
              {canManage && (
                <ActionMenu
                  label={`Actions for ${s.name}`}
                  actions={[
                    { label: "Make current", onSelect: () => setPending({ kind: "current", session: s }), hidden: s.is_current || s.is_archived },
                    { label: "Edit", onSelect: () => { setEditing(s); setFormOpen(true); }, hidden: s.is_archived },
                    { label: "Archive", onSelect: () => setPending({ kind: "archive", session: s }), hidden: s.is_current || s.is_archived },
                    { label: "Restore", onSelect: () => setPending({ kind: "restore", session: s }), hidden: !s.is_archived },
                    { label: "Delete…", onSelect: () => setDeleting(s), tone: "danger" },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <SessionFormModal
        open={formOpen}
        schoolId={schoolId}
        session={editing}
        existing={sessions}
        onClose={() => setFormOpen(false)}
        onSaved={async (saved) => {
          setFormOpen(false);
          toast.success(editing ? "Session updated." : `${saved.name} created${saved.is_current ? " and set as current" : ""}.`);
          await load();
          if (saved.is_current) onCurrentChanged?.();
        }}
      />
      <DeleteSessionDialog
        session={deleting}
        schoolId={schoolId}
        onClose={() => setDeleting(null)}
        onArchive={(s) => { setDeleting(null); setPending({ kind: "archive", session: s }); }}
        onDeleted={async () => { toast.success(`${deleting?.name} deleted.`); setDeleting(null); await load(); }}
      />
      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === "current" ? `Make ${pending.session.name} the current session?`
            : pending?.kind === "archive" ? `Archive ${pending?.session.name}?` : `Restore ${pending?.session.name}?`
        }
        message={
          pending?.kind === "current"
            ? `Everyone in this school will work in ${pending.session.name} from now on. ${current ? `${current.name} stays available and can be archived later.` : ""}`
            : pending?.kind === "archive"
              ? "Archived sessions keep all their records but are hidden from everyday lists and can't be made current. You can restore it at any time."
              : "The session will appear in everyday lists again."
        }
        confirmLabel={pending?.kind === "current" ? "Make current" : pending?.kind === "archive" ? "Archive" : "Restore"}
        tone="primary"
        loading={busy}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
