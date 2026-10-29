"use client";

import { ArrowLeft, Camera, Pencil } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RecordStatusBadge } from "@/components/classes/status";
import { StudentAvatar } from "@/components/students/student-avatar";
import { AssignmentsCard } from "@/components/teachers/assignments-card";
import { TeacherFormModal } from "@/components/teachers/teacher-form-modal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { TeacherDetail } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-1.5 text-sm"><dt className="text-muted">{label}</dt><dd>{value || "—"}</dd></div>;
}

function Profile({ id }: { id: string }) {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const canManage = can("teachers:manage");
  const toast = useToast();
  const [t, setT] = useState<TeacherDetail | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingLogin, setRemovingLogin] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setT(await apiFetch<TeacherDetail>(`/teachers/${id}`, { schoolId })); }
    catch (e) { setError({ message: errorMessage(e), notFound: e instanceof ApiError && (e.status === 404 || e.status === 422) }); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error.notFound ? "This teacher doesn't exist in this school." : error.message} onRetry={error.notFound ? undefined : load} />;
  if (!t) return <LoadingState />;

  async function call(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown, done?: string) {
    setBusy(true);
    try { setT(await apiFetch<TeacherDetail>(`/teachers/${t!.id}${path}`, { method, schoolId, body })); if (done) toast.success(done); return true; }
    catch (e) { toast.error(errorMessage(e)); return false; }
    finally { setBusy(false); }
  }

  async function uploadPhoto(file: File) {
    if (file.size > 2 * 1024 * 1024) return toast.error("The photo must be 2 MB or smaller.");
    const body = new FormData();
    body.append("file", file);
    await call("/photo", "POST", body, "Photo updated.");
  }

  async function changeStatus() {
    if (t!.status === "active" && reason.trim().length < 3) return toast.error("Give a reason for deactivating.");
    const ok = await call("/status", "POST", { status: t!.status === "active" ? "inactive" : "active", reason: reason.trim() || null },
      t!.status === "active" ? "Teacher deactivated." : "Teacher activated.");
    if (ok) { setStatusOpen(false); setReason(""); }
  }

  return (
    <>
      <Link href="/teachers" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> All teachers</Link>
      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-line bg-white p-5 sm:flex-row sm:items-center">
        <div className="flex flex-col items-center gap-1">
          <div className="relative">
            <StudentAvatar name={t.full_name} url={t.photo_url} size="lg" />
            {canManage && (
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
                className="absolute bottom-0 right-0 grid size-8 place-items-center rounded-full border border-line bg-white text-muted shadow hover:text-ink"
                aria-label={t.photo_url ? "Change photo" : "Add photo"}><Camera className="size-4" /></button>
            )}
          </div>
          {canManage && t.photo_url && <button type="button" onClick={() => call("/photo", "DELETE", undefined, "Photo removed.")} disabled={busy} className="text-xs text-muted hover:text-danger-600">Remove photo</button>}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="teacher-photo-input" aria-label="Teacher photo"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadPhoto(f); }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t.full_name}</h1>
            <RecordStatusBadge active={t.status === "active"} />
          </div>
          <p className="text-sm text-muted" data-testid="teacher-summary">{t.employee_id}{t.subject ? ` · ${t.subject}` : ""}{t.qualification ? ` · ${t.qualification}` : ""}</p>
          {t.status === "inactive" && t.status_reason && <p className="mt-1 text-sm">Reason: {t.status_reason}</p>}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</Button>
            <Button variant="secondary" onClick={() => setStatusOpen(true)} data-testid="toggle-teacher-status">{t.status === "active" ? "Deactivate" : "Activate"}</Button>
          </div>
        )}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-white p-5">
          <h2 className="mb-2 font-semibold">Details</h2>
          <dl>
            <Row label="Employee ID" value={t.employee_id} />
            <Row label="Staff type" value={t.staff_type === "teaching" ? "Teaching staff" : "Non-teaching staff"} />
            <Row label="Designation" value={t.designation} />
            <Row label="Phone" value={t.phone} />
            <Row label="Email" value={t.email} />
            <Row label="Qualification" value={t.qualification} />
            <Row label="Subject" value={t.subject} />
            <Row label="Joining date" value={formatDate(t.joining_date)} />
            <Row label="Address" value={t.address} />
          </dl>
        </section>
        <section className="rounded-lg border border-line bg-white p-5" data-testid="teacher-login-card">
          <h2 className="font-semibold">Teacher login</h2>
          <p className="mb-3 text-xs text-muted">Signs in with {t.email}. A teacher sees only the classes assigned below.</p>
          {t.login.linked ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{t.login.email}</span>
              {canManage && <button className="text-xs text-danger-600 hover:underline" onClick={() => setRemovingLogin(true)}>Remove login</button>}
            </div>
          ) : canManage ? (
            <Button size="sm" variant="secondary" disabled={busy || t.status !== "active"} onClick={() => call("/login", "PUT", undefined, "Login created. New accounts receive an email invitation.")}
              data-testid="create-teacher-login">Create login</Button>
          ) : <p className="text-sm text-muted">No login yet.</p>}
          {t.login.linked && (
            <div className="mt-4 border-t border-line pt-4" data-testid="library-duty">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={t.login.library_duty} disabled={!canManage || busy || t.status !== "active"}
                  onChange={(e) => call("/library-duty", "PUT", { enabled: e.target.checked }, e.target.checked ? "Library duty given." : "Library duty removed.")}
                  data-testid="library-duty-toggle" />
                <span><span className="font-medium">Library duty</span>
                  <span className="block text-xs text-muted">Runs the school library: books, issues and returns, fines. Gives no other access.</span></span>
              </label>
            </div>
          )}
        </section>
      </div>

      <AssignmentsCard teacher={t} schoolId={schoolId} canManage={canManage} onChange={setT} />

      <TeacherFormModal open={editing} schoolId={schoolId} teacher={t} onClose={() => setEditing(false)}
        onSaved={(nt) => { setT(nt); setEditing(false); toast.success("Teacher saved."); }} />
      <Modal open={statusOpen} size="sm" onClose={busy ? () => {} : () => setStatusOpen(false)}
        title={t.status === "active" ? `Deactivate ${t.full_name}?` : `Activate ${t.full_name}?`}
        description={t.status === "active" ? "They immediately lose access to the school and their classes. Records and assignments are kept." : "Their login and assigned classes work again."}
        footer={<><Button variant="secondary" onClick={() => setStatusOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={changeStatus} loading={busy} data-testid="confirm-teacher-status">{t.status === "active" ? "Deactivate" : "Activate"}</Button></>}>
        {t.status === "active" && <TextField label="Reason" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Resigned" />}
      </Modal>
      <ConfirmDialog open={removingLogin} title="Remove this teacher's login?" message="They can no longer sign in to this school as a teacher. Their record and assignments stay."
        confirmLabel="Remove" onCancel={() => setRemovingLogin(false)} onConfirm={async () => { if (await call("/login", "DELETE", undefined, "Login removed.")) setRemovingLogin(false); }} />
    </>
  );
}

export default function TeacherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="teachers:view"><Profile id={id} /></RequirePermission>;
}
