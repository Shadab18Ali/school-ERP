"use client";

import { clsx } from "clsx";
import { ArrowLeft, Camera, FileBadge, Pencil } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RecordStatusBadge } from "@/components/classes/status";
import { StudentAttendancePanel } from "@/components/attendance/student-attendance";
import { DocumentsPanel } from "@/components/students/documents-panel";
import { StudentTransportPanel } from "@/components/transport/student-transport";
import { GuardiansCard } from "@/components/students/guardians-card";
import { StudentLoginCard } from "@/components/students/student-login-card";
import { PlacementFields, validatePlacement, type Placement } from "@/components/students/placement-fields";
import { StudentAvatar } from "@/components/students/student-avatar";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { ageFrom, formatDate, formatPhone, todayISO } from "@/lib/format";
import { GENDER_LABELS, type AcademicSession, type StudentDetail } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const FUTURE_TABS = ["Fees", "Homework", "Exams", "Results"] as const;
const TABS = ["Overview", "Attendance", "Documents", "Transport", ...FUTURE_TABS] as const;
type Tab = (typeof TABS)[number];

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Detail({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{value || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

function StatusDialog({ student, schoolId, onClose, onDone }: {
  student: StudentDetail; schoolId: string; onClose: () => void; onDone: (s: StudentDetail) => void;
}) {
  const deactivating = student.status === "active";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onDone(await apiFetch<StudentDetail>(`/students/${student.id}/status`, {
        method: "POST", schoolId, body: { status: deactivating ? "inactive" : "active", reason: deactivating ? reason || null : null },
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open size="sm" onClose={busy ? () => {} : onClose}
      title={deactivating ? `Deactivate ${student.full_name}?` : `Activate ${student.full_name}?`}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={deactivating ? "danger" : "primary"} onClick={submit} loading={busy}>{deactivating ? "Deactivate" : "Activate"}</Button>
      </>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
        <p className="text-sm text-muted">
          {deactivating
            ? "Use this when a student leaves or is withdrawn. Their records are kept and they can be activated again."
            : "The student will appear as active in lists again."}
        </p>
        {deactivating && (
          <TextField label="Reason (optional)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)}
            hint="e.g. Transferred to another school" />
        )}
      </div>
    </Modal>
  );
}

function EnrollDialog({ student, schoolId, session, sessions, onClose, onDone }: {
  student: StudentDetail; schoolId: string; session: AcademicSession; sessions: AcademicSession[];
  onClose: () => void; onDone: (s: StudentDetail) => void;
}) {
  const last = student.enrollments[0];
  const [value, setValue] = useState<Placement>({
    academic_session_id: session.id, class_id: "", section_id: "",
    admission_number: last?.admission_number ?? "", admission_date: todayISO(),
  });
  const [errors, setErrors] = useState<Partial<Record<keyof Placement, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const e = validatePlacement(value);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await apiFetch<StudentDetail>(`/students/${student.id}/enrollments`, { method: "POST", schoolId, body: value }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Enrol in ${session.name}`}
      description="Places this student in a class and section for the session. Earlier years are kept."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} loading={busy}>Enrol</Button>
      </>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="enroll-error">{error}</p>}
        <PlacementFields schoolId={schoolId} sessions={sessions} value={value} onChange={setValue} errors={errors} lockSession />
      </div>
    </Modal>
  );
}

function Profile({ id }: { id: string }) {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const canManage = can("students:manage");
  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>("Overview");
  useEffect(() => {
    const t = search.get("tab");
    if (t && (TABS as readonly string[]).includes(t)) setTab(t as Tab);
  }, [search]);
  const [statusOpen, setStatusOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, ss] = await Promise.all([
        apiFetch<StudentDetail>(`/students/${id}`, { schoolId }),
        apiFetch<AcademicSession[]>("/sessions", { schoolId }).catch(() => [] as AcademicSession[]),
      ]);
      setStudent(s);
      setSessions(ss);
    } catch (err) {
      setError({ message: errorMessage(err), notFound: err instanceof ApiError && (err.status === 404 || err.status === 422) });
    }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error.notFound ? "This student doesn't exist in this school." : error.message} onRetry={error.notFound ? undefined : load} />;
  if (!student) return <LoadingState />;

  const current = student.current_enrollment;
  const currentSession = sessions.find((s) => s.is_current && !s.is_archived) ?? null;

  async function uploadPhoto(file: File) {
    if (!student) return;
    if (file.size > 2 * 1024 * 1024) return toast.error("The photo must be 2 MB or smaller.");
    const body = new FormData();
    body.append("file", file);
    setPhotoBusy(true);
    try {
      setStudent(await apiFetch<StudentDetail>(`/students/${student.id}/photo`, { method: "POST", schoolId, body }));
      toast.success("Photo updated.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    if (!student) return;
    setPhotoBusy(true);
    try {
      setStudent(await apiFetch<StudentDetail>(`/students/${student.id}/photo`, { method: "DELETE", schoolId }));
      toast.success("Photo removed.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <>
      <Link href="/students" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All students
      </Link>

      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-line bg-white p-5 sm:flex-row sm:items-center">
        <div className="flex flex-col items-center gap-1">
          <div className="relative">
            <StudentAvatar name={student.full_name} url={student.photo_url} size="lg" />
            {canManage && (
              <button type="button" onClick={() => fileRef.current?.click()} disabled={photoBusy}
                className="absolute bottom-0 right-0 grid size-8 place-items-center rounded-full border border-line bg-white text-muted shadow hover:text-ink"
                aria-label={student.photo_url ? "Change photo" : "Add photo"}>
                <Camera className="size-4" />
              </button>
            )}
          </div>
          {canManage && student.photo_url && (
            <button type="button" onClick={removePhoto} disabled={photoBusy} className="text-xs text-muted hover:text-danger-600">Remove photo</button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="profile-photo-input" aria-label="Student photo"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadPhoto(f); }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{student.full_name}</h1>
            <RecordStatusBadge active={student.status === "active"} />
          </div>
          <p className="mt-1 text-sm text-muted" data-testid="student-summary">
            <span className="font-medium text-ink">{student.student_code}</span>
            {current && <> · {current.class_name} – {current.section_name} · Adm. no. {current.admission_number}</>}
          </p>
          {student.status === "inactive" && student.status_reason && (
            <p className="mt-1 text-sm text-muted">Reason: {student.status_reason}</p>
          )}
        </div>
        {(canManage || can("certificates:manage")) && (
          <div className="flex flex-wrap gap-2">
            {can("certificates:manage") && (
              <Link href={`/certificates?student=${student.id}`} data-testid="student-certificate"><Button variant="secondary"><FileBadge className="size-4" /> Certificate</Button></Link>
            )}
            {canManage && <>
            <Link href={`/students/${student.id}/edit`}><Button variant="secondary"><Pencil className="size-4" /> Edit</Button></Link>
            <Button variant={student.status === "active" ? "secondary" : "primary"} onClick={() => setStatusOpen(true)} data-testid="toggle-student-status">
              {student.status === "active" ? "Deactivate" : "Activate"}
            </Button>
            </>}
          </div>
        )}
      </div>

      <div role="tablist" aria-label="Student profile" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.filter((t) => t !== "Transport" || can("transport:view")).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`student-tab-${t.toLowerCase()}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium",
              tab === t ? "border-leaf-600 text-ink" : "border-transparent text-muted hover:text-ink")}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && can("students:manage") && (
        <div className="mb-6 grid gap-6 lg:grid-cols-2">
          <GuardiansCard studentId={student.id} schoolId={schoolId} />
          <StudentLoginCard studentId={student.id} schoolId={schoolId} />
        </div>
      )}
      {tab === "Attendance" ? (
        can("attendance:mark") ? (
          <StudentAttendancePanel studentId={student.id} schoolId={schoolId} />
        ) : (
          <section className="rounded-lg border border-line bg-white px-6 py-12 text-center" role="tabpanel">
            <p className="text-sm text-muted">Attendance is available to teachers and school administrators.</p>
          </section>
        )
      ) : tab === "Documents" ? (
        can("documents:view") ? (
          <DocumentsPanel studentId={student.id} schoolId={schoolId} canManage={can("documents:manage")} />
        ) : (
          <section className="rounded-lg border border-line bg-white px-6 py-12 text-center" role="tabpanel" data-testid="documents-restricted">
            <h2 className="font-semibold">Documents are restricted</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">Only school administrators can view a student&apos;s documents.</p>
          </section>
        )
      ) : tab === "Transport" && can("transport:view") ? (
        <StudentTransportPanel studentId={student.id} studentName={student.full_name} schoolId={schoolId} active={student.status === "active"} />
      ) : tab !== "Overview" ? (
        <section className="rounded-lg border border-line bg-white px-6 py-12 text-center" role="tabpanel">
          <h2 className="font-semibold">{tab}</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {tab} for {student.full_name.split(" ")[0]} will appear here once the {tab.toLowerCase()} module is set up.
          </p>
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2" role="tabpanel">
          <Card title="Personal details">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail label="Date of birth" value={`${formatDate(student.date_of_birth)} (${ageFrom(student.date_of_birth)} years)`} />
              <Detail label="Gender" value={GENDER_LABELS[student.gender]} />
              <Detail label="Father's name" value={student.father_name} />
              <Detail label="Mother's name" value={student.mother_name} />
            </dl>
          </Card>
          <Card title="Contact">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail label="Mobile" value={<a className="hover:underline" href={`tel:${student.mobile}`}>{formatPhone(student.mobile)}</a>} />
              <Detail label="Alternate mobile" value={student.alternate_mobile ? formatPhone(student.alternate_mobile) : null} />
              <Detail className="sm:col-span-2" label="Address" value={student.address} />
            </dl>
          </Card>
          <div className="lg:col-span-2">
            <Card title="Enrollment history"
              action={canManage && currentSession && !current && student.status === "active" ? (
                <Button size="sm" onClick={() => setEnrollOpen(true)}>Enrol in {currentSession.name}</Button>
              ) : undefined}>
              {!current && currentSession && (
                <p className="mb-4 rounded-md bg-pencil-100 px-3 py-2 text-sm" data-testid="not-enrolled-notice">
                  Not enrolled in the current session ({currentSession.name}).
                </p>
              )}
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm" data-testid="enrollment-history">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th scope="col" className="pb-2 pr-4">Session</th>
                      <th scope="col" className="pb-2 pr-4">Class</th>
                      <th scope="col" className="pb-2 pr-4">Admission no.</th>
                      <th scope="col" className="pb-2">Admission date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {student.enrollments.map((e) => (
                      <tr key={e.id}>
                        <td className="py-2 pr-4">
                          {e.session_name}
                          {e.session_is_current && <span className="ml-2 rounded-full bg-pencil-100 px-2 py-0.5 text-xs">Current</span>}
                          {e.session_is_archived && <span className="ml-2 rounded-full bg-ink/5 px-2 py-0.5 text-xs text-muted">Archived</span>}
                        </td>
                        <td className="py-2 pr-4">{e.class_name} – {e.section_name}</td>
                        <td className="tabular py-2 pr-4">{e.admission_number}</td>
                        <td className="tabular py-2">{formatDate(e.admission_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      )}

      {statusOpen && (
        <StatusDialog student={student} schoolId={schoolId} onClose={() => setStatusOpen(false)}
          onDone={(s) => { setStudent(s); setStatusOpen(false); toast.success(s.status === "active" ? "Student activated." : "Student deactivated."); }} />
      )}
      {enrollOpen && currentSession && (
        <EnrollDialog student={student} schoolId={schoolId} session={currentSession} sessions={sessions}
          onClose={() => setEnrollOpen(false)}
          onDone={(s) => { setStudent(s); setEnrollOpen(false); toast.success(`Enrolled in ${currentSession.name}.`); }} />
      )}
    </>
  );
}

export default function StudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="students:view"><Suspense fallback={<LoadingState />}><Profile id={id} /></Suspense></RequirePermission>;
}
