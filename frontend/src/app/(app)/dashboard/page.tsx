"use client";

import { Building2, School as SchoolIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { GetTheApp } from "@/components/pwa/get-the-app";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { ChildrenCards } from "@/components/portal/children-cards";
import { NoticeList } from "@/components/portal/notice-list";
import { MyClassesGrid } from "@/components/teachers/my-classes-grid";
import { formatINR } from "@/lib/money";
import { LibraryKpis } from "@/components/library/dashboard";
import { AttendanceTrendChart, EnrollmentChart, MonthlyCollectionChart } from "@/components/dashboard/charts";
import type { MyClass, PlatformStats, PortalChild } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={emphasis ? "rounded-lg bg-board-900 p-5 text-white" : "rounded-lg border border-line bg-white p-5"}>
      <p className={emphasis ? "text-sm text-white/60" : "text-sm text-muted"}>{label}</p>
      <p className="tabular mt-2 text-3xl font-semibold tracking-tight">{value.toLocaleString("en-IN")}</p>
    </div>
  );
}

function PlatformOverview() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setStats(await apiFetch<PlatformStats>("/admin/stats")); } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!stats) return <LoadingState />;
  if (stats.total_schools === 0)
    return (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState icon={Building2} title="Add your first school" message="Each school gets its own isolated workspace. Create one, then invite its administrator."
          action={<Link href="/admin/schools?new=1"><Button>Add school</Button></Link>} />
      </div>
    );

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Schools" value={stats.total_schools} emphasis />
      <Stat label="Active" value={stats.active_schools} />
      <Stat label="Suspended" value={stats.suspended_schools} />
      <Stat label="User accounts" value={stats.total_users} />
    </div>
  );
}

interface DashboardData {
  session_name: string | null;
  today: string;
  students: { total_students: number; total_classes: number; total_sections: number; by_class: { class_name: string; students: number; boys: number; girls: number }[] } | null;
  attendance: { present: number; absent: number; leave: number; unmarked: number; percentage: string | null; trend: { date: string; percentage: string; marked: number }[] } | null;
  fees: { collected: string; pending: string; overdue: string; today: string; today_receipts: number; monthly: { month: string; amount: string }[] } | null;
}

function Kpi({ label, value, sub, href, strong, tone, testId }: { label: string; value: string; sub?: string; href?: string; strong?: boolean; tone?: "danger"; testId: string }) {
  const body = (
    <div className={strong ? "h-full rounded-lg bg-board-900 p-4 text-white" : "h-full rounded-lg border border-line bg-white p-4 transition-colors hover:border-leaf-600"}>
      <p className={strong ? "text-xs text-white/60" : "text-xs text-muted"}>{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold tracking-tight ${tone === "danger" ? "text-danger-600" : ""}`} data-testid={testId}>{value}</p>
      {sub && <p className={strong ? "mt-0.5 text-xs text-white/60" : "mt-0.5 text-xs text-muted"}>{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

function EnquiryFollowUps({ schoolId }: { schoolId: string }) {
  const [d, setD] = useState<{ overdue: number; today: number } | null>(null);
  useEffect(() => { apiFetch<{ overdue: number; today: number }>("/enquiries/follow-ups/summary", { schoolId }).then(setD).catch(() => setD(null)); }, [schoolId]);
  if (!d) return null;
  return (
    <Kpi label="Enquiry follow-ups today" value={String(d.today)} href={d.overdue ? "/enquiries?tab=list&follow_up=overdue" : "/enquiries?tab=list&follow_up=today"}
      sub={d.overdue ? `${d.overdue} overdue` : "none overdue"} tone={d.overdue ? "danger" : undefined} testId="kpi-follow-ups" />
  );
}

function ParentHome({ schoolId }: { schoolId: string }) {
  const [kids, setKids] = useState<PortalChild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<PortalChild[]>("/portal/children", { schoolId }).then(setKids).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!kids) return <LoadingState />;
  return (
    <div className="space-y-6">
      <section><h2 className="mb-3 font-semibold">My children</h2><ChildrenCards items={kids} /></section>
      <section><h2 className="mb-3 font-semibold">Latest notices</h2><NoticeList schoolId={schoolId} limit={3} /></section>
    </div>
  );
}

function StudentHome({ schoolId }: { schoolId: string }) {
  const [me, setMe] = useState<PortalChild | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    apiFetch<PortalChild>("/my", { schoolId }).then(setMe).catch(() => setMissing(true));
  }, [schoolId]);
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 font-semibold">Me</h2>
        {missing ? <p className="rounded-lg border border-line bg-white p-5 text-sm text-muted">No student record is linked to your account yet. Please contact the school office.</p>
          : !me ? <LoadingState /> : <ChildrenCards items={[{ ...me, relationship: "self" }]} hrefFor={() => "/my"} />}
      </section>
      <section><h2 className="mb-3 font-semibold">Latest notices</h2><NoticeList schoolId={schoolId} limit={3} /></section>
    </div>
  );
}

function TeacherClasses({ schoolId }: { schoolId: string }) {
  const [d, setD] = useState<{ today: string; items: MyClass[] } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => { apiFetch<{ today: string; items: MyClass[] }>("/teaching/classes", { schoolId }).then(setD).catch(() => setMissing(true)); }, [schoolId]);
  return (
    <section>
      <h2 className="mb-3 font-semibold">My classes</h2>
      {missing ? <p className="rounded-lg border border-line bg-white p-5 text-sm text-muted">No teacher record is linked to your account yet. Please contact the school office.</p>
        : !d ? <LoadingState /> : d.items.length === 0
        ? <p className="rounded-lg border border-line bg-white p-5 text-sm text-muted">No classes assigned to you yet.</p>
        : <MyClassesGrid items={d.items} today={d.today} />}
    </section>
  );
}

function SchoolOverview({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  if (can("library:manage") && !can("students:view")) return <LibraryKpis schoolId={schoolId} />;  // librarian
  if (can("self:view") && !can("students:view")) return <StudentHome schoolId={schoolId} />;
  if (can("portal:view") && !can("students:view")) return <ParentHome schoolId={schoolId} />;
  if (can("teaching:view")) return <div className="space-y-8"><TeacherClasses schoolId={schoolId} /><StaffOverview schoolId={schoolId} /></div>;
  return <StaffOverview schoolId={schoolId} />;
}

function StaffOverview({ schoolId }: { schoolId: string }) {
  const { can, hasFeature } = useAuth();
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    setD(null);
    try { setD(await apiFetch<DashboardData>("/dashboard", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  if (!d.session_name) {
    return <div className="rounded-lg border border-line bg-white"><EmptyState icon={SchoolIcon} title="No academic session yet" message="Set up the current academic session to start using the dashboard." /></div>;
  }
  const n = (v: number) => v.toLocaleString("en-IN");
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">Session {d.session_name} · today, {formatDate(d.today)}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {d.students && <>
          <Kpi label="Total students" value={n(d.students.total_students)} sub="active, this session" href="/students" testId="kpi-students" />
          <Kpi label="Total classes" value={n(d.students.total_classes)} sub={`${n(d.students.total_sections)} sections`} href="/classes" testId="kpi-classes" />
        </>}
        {d.attendance && <>
          <Kpi label="Today's attendance" value={d.attendance.percentage ? `${d.attendance.percentage}%` : "Not marked"} strong
            sub={d.attendance.unmarked ? `${n(d.attendance.unmarked)} students not marked yet` : "all sections marked"} href="/attendance/reports" testId="kpi-attendance" />
          <Kpi label="Present / absent today" value={`${n(d.attendance.present)} / ${n(d.attendance.absent)}`} sub={d.attendance.leave ? `${n(d.attendance.leave)} on leave` : undefined} testId="kpi-present-absent" />
        </>}
        {d.fees && <>
          <Kpi label="Fees collected" value={formatINR(d.fees.collected)} sub="this session" href="/fees/payments" testId="kpi-collected" />
          <Kpi label="Pending fees" value={formatINR(d.fees.pending)} sub={`${formatINR(d.fees.overdue)} overdue`} tone={Number(d.fees.overdue) > 0 ? "danger" : undefined} href={hasFeature("reports") ? "/reports?report=pending-fees" : undefined} testId="kpi-pending" />
          <Kpi label="Today's collection" value={formatINR(d.fees.today)} strong={!d.attendance} sub={`${n(d.fees.today_receipts)} receipt${d.fees.today_receipts === 1 ? "" : "s"}`} href="/fees/payments" testId="kpi-today" />
        </>}
        {can("enquiries:view") && <EnquiryFollowUps schoolId={schoolId} />}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {d.fees && <MonthlyCollectionChart data={d.fees.monthly} />}
        {d.attendance && <AttendanceTrendChart data={d.attendance.trend} />}
        {d.students && <EnrollmentChart data={d.students.by_class} />}
      </div>
      {!d.students && !d.attendance && !d.fees && (
        <div className="rounded-lg border border-line bg-white p-6 text-sm text-muted">Your school&apos;s information for your role will appear here.</div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { me, currentSchool } = useAuth();
  const firstName = me?.full_name?.split(" ")[0];

  return (
    <>
      <PageHeader title={firstName ? `Welcome, ${firstName}` : "Welcome"}
        description={me?.is_super_admin ? "Platform overview across all schools." : undefined} />
      <GetTheApp />
      {me?.is_super_admin ? (
        <PlatformOverview />
      ) : currentSchool ? (
        <SchoolOverview schoolId={currentSchool.school_id} />
      ) : (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState icon={SchoolIcon} title="You're not linked to a school yet"
            message="Ask your school administrator to add you. If your school was recently suspended, contact the platform team." />
        </div>
      )}
    </>
  );
}
