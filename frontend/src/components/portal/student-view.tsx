"use client";

import { useSearchParams } from "next/navigation";
// Shared by the parent portal (/portal/[id]) and the student portal (/my).

import { clsx } from "clsx";
import { ArrowLeft, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { STATUS_TONE } from "@/components/attendance/student-attendance";
import { ReceiptActions } from "@/components/fees/receipt-actions";
import { PayOnline } from "@/components/payments/pay-online";
import { PageHeader } from "@/components/layout/app-shell";
import { StudentExams } from "@/components/exams/student-exams";
import { StudentHomeworkList } from "@/components/homework/student-homework";
import { TimetablePanel } from "@/components/timetable/timetable-grid";
import { NoticeList } from "@/components/portal/notice-list";
import { StudentLibraryTab } from "@/components/library/student-library";
import { FamilyTransportTab } from "@/components/transport/student-transport";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { formatINR, monthLabel } from "@/lib/money";
import { ATTENDANCE_LABELS, MODE_LABELS, type AttendanceStatus, type Due, type FeeTotalsOut, type PaymentSummary, type PortalProfile } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

export const PARENT_TABS = ["Profile", "Attendance", "Fees", "Notices", "Homework", "Timetable", "Exam results", "Library", "Transport"] as const;
export const STUDENT_TABS = ["Profile", "Attendance", "Fees", "Homework", "Assignments", "Timetable", "Exams", "Results", "Library", "Transport", "Notices"] as const;
type Tab = (typeof STUDENT_TABS)[number] | (typeof PARENT_TABS)[number];

interface Att { session_name: string | null; months: { month: string; present: number; absent: number; leave: number; percentage: string }[];
  overall: { present: number; absent: number; leave: number; percentage: string | null } | null; records: { date: string; status: AttendanceStatus; remarks: string | null }[] }
interface Fees { session_name: string | null; totals: FeeTotalsOut | null; dues: Due[]; payments: PaymentSummary[] }

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="grid grid-cols-[9rem_1fr] gap-2 py-1.5 text-sm"><dt className="text-muted">{label}</dt><dd>{value || "—"}</dd></div>;
}

function AttendanceTab({ base, schoolId }: { base: string; schoolId: string }) {
  const [d, setD] = useState<Att | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<Att>(`${base}/attendance`, { schoolId }).then(setD).catch((e) => setError(errorMessage(e))); }, [base, schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!d) return <LoadingState />;
  if (!d.overall || d.records.length === 0) return <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted">No attendance has been recorded yet.</p>;
  const exceptions = d.records.filter((r) => r.status !== "present");
  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="portal-attendance">
      <section className="rounded-lg border border-line bg-white p-5">
        <p className="text-xs text-muted">Attendance in {d.session_name}</p>
        <p className="tabular mt-1 text-3xl font-semibold" data-testid="portal-attendance-pct">{d.overall.percentage ? `${d.overall.percentage}%` : "—"}</p>
        <p className="tabular text-sm text-muted">{d.overall.present} present · {d.overall.absent} absent · {d.overall.leave} leave</p>
        <table className="mt-4 w-full text-sm"><thead className="text-left text-xs text-muted"><tr><th className="py-1">Month</th><th className="text-right">Present</th><th className="text-right">Absent</th><th className="text-right">Leave</th><th className="text-right">%</th></tr></thead>
          <tbody className="tabular divide-y divide-line">{d.months.map((m) => <tr key={m.month}><td className="py-1.5">{monthLabel(m.month)}</td><td className="text-right">{m.present}</td><td className="text-right">{m.absent}</td><td className="text-right">{m.leave}</td><td className="text-right font-medium">{m.percentage}</td></tr>)}</tbody></table>
      </section>
      <section className="rounded-lg border border-line bg-white p-5">
        <h3 className="mb-3 font-semibold">Absences and leave</h3>
        {exceptions.length === 0 ? <p className="text-sm text-muted">Present every day so far.</p> : (
          <ul className="divide-y divide-line text-sm">{exceptions.map((r) => (
            <li key={r.date} className="flex items-center justify-between gap-3 py-1.5"><span>{formatDate(r.date)}{r.remarks ? <span className="text-muted"> · {r.remarks}</span> : null}</span>
              <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[r.status])}>{ATTENDANCE_LABELS[r.status]}</span></li>))}</ul>
        )}
      </section>
    </div>
  );
}

function FeesTab({ base, schoolId }: { base: string; schoolId: string }) {
  const [d, setD] = useState<Fees | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { apiFetch<Fees>(`${base}/fees`, { schoolId }).then(setD).catch((e) => setError(errorMessage(e))); }, [base, schoolId]);
  useEffect(() => { reload(); }, [reload]);
  const parentOf = base.startsWith("/portal/children/") ? base.slice("/portal/children/".length) : null; // parents can pay online
  if (error) return <ErrorState message={error} />;
  if (!d) return <LoadingState />;
  if (!d.totals) return <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted">No fees for this session yet.</p>;
  const month = `${todayISO().slice(0, 7)}-01`;
  const pending = d.dues.filter((x) => Number(x.balance) > 0);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-4" data-testid="portal-fee-totals">
        {([["Total", d.totals.total], ["Paid", d.totals.paid], ["Pending", d.totals.outstanding], ["Overdue", d.totals.overdue]] as const).map(([l, v]) => (
          <div key={l} className={clsx("rounded-lg p-4", l === "Pending" ? "bg-board-900 text-white" : "border border-line bg-white")}>
            <p className={clsx("text-xs", l === "Pending" ? "text-white/60" : "text-muted")}>{l}</p>
            <p className={clsx("tabular mt-1 text-xl font-semibold", l === "Overdue" && Number(v) > 0 && "text-danger-600")} data-testid={`portal-fee-${l.toLowerCase()}`}>{formatINR(v)}</p>
          </div>
        ))}
      </div>
      {parentOf && <PayOnline schoolId={schoolId} studentId={parentOf} dues={d.dues} onChanged={reload} />}
      <section className="rounded-lg border border-line bg-white">
        <h3 className="border-b border-line px-5 py-3.5 font-semibold">Pending fees</h3>
        {pending.length === 0 ? <p className="px-5 py-6 text-sm text-muted">Nothing pending. Thank you!</p> : (
          <div className="relative overflow-x-auto"><table className="w-full text-sm" data-testid="portal-pending">
            <thead className="text-left text-xs text-muted"><tr><th className="px-5 py-2">Fee</th><th className="px-3 py-2">Period</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Paid</th><th className="px-5 py-2 text-right">Due</th></tr></thead>
            <tbody className="tabular divide-y divide-line">{pending.map((x) => (
              <tr key={x.due_id}><td className="px-5 py-2">{x.fee_head_name}</td><td className="px-3 py-2">{monthLabel(x.due_month)}{x.due_month <= month && <span className="ml-2 rounded-full bg-danger-50 px-2 py-0.5 text-xs text-danger-600">Overdue</span>}</td>
                <td className="px-3 py-2 text-right">{formatINR(x.amount)}</td><td className="px-3 py-2 text-right text-muted">{formatINR(x.paid)}</td><td className="px-5 py-2 text-right font-medium">{formatINR(x.balance)}</td></tr>))}</tbody></table></div>
        )}
      </section>
      <section className="rounded-lg border border-line bg-white">
        <h3 className="border-b border-line px-5 py-3.5 font-semibold">Payment history and receipts</h3>
        {d.payments.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No payments yet.</p> : (
          <ul className="divide-y divide-line" data-testid="portal-payments">{d.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div><p className={p.cancelled_at ? "font-medium text-muted line-through" : "font-medium"}>{p.receipt_number} · {formatINR(p.amount)}</p>
                <p className="text-xs text-muted">{p.cancelled_at && <span className="ml-2 rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-600" title={p.cancel_reason ?? undefined} data-testid="receipt-cancelled">Cancelled · refunded</span>}{formatDate(p.payment_date)} · {MODE_LABELS[p.payment_mode]}{p.reference_number ? ` (${p.reference_number})` : ""}</p></div>
              <ReceiptActions paymentId={p.id} receiptNumber={p.receipt_number} schoolId={schoolId} size="sm" path={`${base}/payments/${p.id}/receipt.pdf`} />
            </li>))}</ul>
        )}
      </section>
    </div>
  );
}

export function StudentView({ base, tabs, backHref, backLabel, notFound, title }: {
  base: string; // API base: /portal/children/{id} (parents) or /my (students)
  tabs: readonly Tab[];
  backHref?: string;
  backLabel?: string;
  notFound: string;
  title?: string; // page heading shown when there is no record to display
}) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [p, setP] = useState<PortalProfile | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("Profile");
  const linkBase = base === "/my" ? "/my" : base.replace("/portal/children/", "/portal/");
  const wanted = useSearchParams().get("tab") as Tab | null;
  useEffect(() => { // ?tab=Homework (coming back from a homework page, or a tab in the app's bottom bar)
    if (wanted && tabs.includes(wanted)) setTab(wanted);
  }, [wanted, tabs]);
  const load = useCallback(async () => {
    setError(null);
    try { setP(await apiFetch<PortalProfile>(base, { schoolId })); }
    catch (e) { setError({ message: errorMessage(e), notFound: e instanceof ApiError && (e.status === 404 || e.status === 422) }); }
  }, [base, schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) {
    // nothing linked yet is a normal state for a new account, not a failure: say what to do, without "couldn't be loaded"
    const state = error.notFound
      ? <div className="rounded-lg border border-line bg-white"><EmptyState icon={UserRound} title="No record to show yet" message={notFound} /></div>
      : <ErrorState message={error.message} onRetry={load} />;
    return title ? <><PageHeader title={title} />{state}</> : state;
  }
  if (!p) return <LoadingState />;
  return (
    <>
      {backHref && <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> {backLabel}</Link>}
      <div className="mb-5 flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {p.photo_url ? <img src={p.photo_url} alt={`Photo of ${p.full_name}`} className="size-16 rounded-full object-cover" /> : null}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{p.full_name}</h1>
          <p className="text-sm text-muted">{p.class_section ?? "Not enrolled"}{p.session_name ? ` · ${p.session_name}` : ""} · {p.student_code}</p>
        </div>
      </div>
      <div role="tablist" aria-label="Child information" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab === "Profile" ? (
        <section className="grid gap-6 rounded-lg border border-line bg-white p-5 lg:grid-cols-2" data-testid="portal-profile">
          <dl>
            <Row label="Student ID" value={p.student_code} /><Row label="Admission no." value={p.admission_number} />
            <Row label="Admitted" value={p.admission_date && formatDate(p.admission_date)} /><Row label="Class" value={p.class_section} />
            <Row label="Date of birth" value={formatDate(p.date_of_birth)} /><Row label="Gender" value={p.gender[0].toUpperCase() + p.gender.slice(1)} />
          </dl>
          <dl>
            <Row label="Father" value={p.father_name} /><Row label="Mother" value={p.mother_name} />
            <Row label="Mobile" value={p.mobile} /><Row label="Address" value={p.address} />
            <Row label="Attendance" value={p.attendance_percentage ? `${p.attendance_percentage}%` : null} />
            <Row label="Fees pending" value={p.outstanding && formatINR(p.outstanding)} />
          </dl>
          <p className="text-xs text-muted lg:col-span-2">Something wrong? Please ask the school office to correct it.</p>
        </section>
      ) : tab === "Attendance" ? <AttendanceTab base={base} schoolId={schoolId} />
        : tab === "Fees" ? <FeesTab base={base} schoolId={schoolId} />
        : tab === "Notices" ? <NoticeList schoolId={schoolId} />
        : tab === "Homework" ? <StudentHomeworkList base={base} linkBase={linkBase} kind={tabs.includes("Assignments") ? "homework" : undefined} />
        : tab === "Assignments" ? <StudentHomeworkList base={base} linkBase={linkBase} kind="assignment" />
        : tab === "Timetable" ? <TimetablePanel path={`${base}/timetable`} schoolId={schoolId} emptyMessage="Not enrolled in a class this session, so there is no timetable." />
        : tab === "Exams" ? <StudentExams base={base} mode="schedule" />
        : tab === "Results" ? <StudentExams base={base} mode="results" />
        : tab === "Library" ? <StudentLibraryTab base={base} schoolId={schoolId} />
        : tab === "Transport" ? <FamilyTransportTab base={base} schoolId={schoolId} />
        : <StudentExams base={base} mode="both" />}
    </>
  );
}

