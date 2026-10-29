"use client";

import { clsx } from "clsx";
import { Download, Eye, FileText, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { formatBytes } from "@/components/students/documents-panel";
import { useToast } from "@/components/ui/toast";
import { apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { HomeworkFile, HomeworkKind, HomeworkStatus } from "@/lib/types";

export const KIND_LABEL: Record<HomeworkKind, string> = { homework: "Homework", assignment: "Assignment" };

const STATUS: Record<HomeworkStatus, { label: string; tone: string }> = {
  pending: { label: "To do", tone: "bg-pencil-100 text-ink" },
  submitted: { label: "Submitted", tone: "bg-leaf-50 text-leaf-700" },
  late: { label: "Submitted late", tone: "bg-pencil-100 text-ink" },
  reviewed: { label: "Reviewed", tone: "bg-leaf-600 text-white" },
  missing: { label: "Missed", tone: "bg-danger-50 text-danger-600" },
};

export function HomeworkStatusBadge({ status }: { status: HomeworkStatus }) {
  const s = STATUS[status];
  return <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", s.tone)} data-testid="homework-status">{s.label}</span>;
}

export function KindBadge({ kind }: { kind: HomeworkKind }) {
  return <span className="rounded border border-line px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">{KIND_LABEL[kind]}</span>;
}

/** "Due 12 Oct 2026, 5:00 pm" plus a hint: in 3 days / today / closed. */
export function DueText({ dueAt, closed, allowLate }: { dueAt: string; closed: boolean; allowLate?: boolean }) {
  const ms = new Date(dueAt).getTime() - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  const hint = ms < 0
    ? (closed ? "closed" : allowLate ? "late work accepted" : "past due")
    : ms < 86_400_000 ? "due soon" : `in ${days} day${days === 1 ? "" : "s"}`;
  return (
    <span className={clsx("text-sm", ms < 0 ? "text-muted" : ms < 86_400_000 ? "text-danger-600" : "")}>
      Due {formatDateTime(dueAt)} <span className="text-xs text-muted">({hint})</span>
    </span>
  );
}

const VIEWABLE = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** Files streamed through the API (never public links). Download, open (PDF/images) and optionally remove. */
export function HomeworkFiles({ files, schoolId, path, onRemove, removing, testId = "file-list" }: {
  files: HomeworkFile[]; schoolId: string; path: (f: HomeworkFile) => string;
  onRemove?: (f: HomeworkFile) => void; removing?: string | null; testId?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (files.length === 0) return <p className="text-sm text-muted" data-testid={`${testId}-empty`}>No files.</p>;

  async function download(f: HomeworkFile) {
    setBusy(f.id);
    try {
      const { blob } = await apiFetchBlob(path(f), { schoolId, query: { download: "true" } });
      saveBlob(blob, f.file_name);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  async function view(f: HomeworkFile) {
    const w = window.open("", "_blank"); // opened now, so pop-up blockers allow it
    try {
      const { blob } = await apiFetchBlob(path(f), { schoolId });
      const url = URL.createObjectURL(new Blob([blob], { type: f.mime_type }));
      if (w) w.location.href = url; else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { w?.close(); toast.error(errorMessage(e)); }
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line" data-testid={testId}>
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-testid={`file-${f.file_name}`}>
          {f.mime_type.startsWith("image/") ? <Paperclip className="size-4 shrink-0 text-muted" /> : <FileText className="size-4 shrink-0 text-muted" />}
          <span className="min-w-0 flex-1 truncate">{f.file_name}</span>
          <span className="tabular text-xs text-muted">{formatBytes(f.size_bytes)}</span>
          {VIEWABLE.has(f.mime_type) && (
            <button className="rounded p-1.5 text-muted hover:bg-ink/5" aria-label={`Open ${f.file_name}`} onClick={() => view(f)}><Eye className="size-4" /></button>
          )}
          <button className="rounded p-1.5 text-muted hover:bg-ink/5 disabled:opacity-50" aria-label={`Download ${f.file_name}`} disabled={busy === f.id}
            onClick={() => download(f)}><Download className="size-4" /></button>
          {onRemove && (
            <button className="rounded p-1.5 text-muted hover:bg-danger-50 hover:text-danger-600 disabled:opacity-50" aria-label={`Remove ${f.file_name}`}
              disabled={removing === f.id} onClick={() => onRemove(f)}><X className="size-4" /></button>
          )}
        </li>
      ))}
    </ul>
  );
}

export const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,.pptx,.txt";
export const FILE_HINT = "PDF, photos, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or text · up to 10 MB each, 5 at a time";
