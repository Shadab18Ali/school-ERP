"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  activeDot, axis, barEnd, barTop, ChartCard, Grid2, grid, gridH, Kpi, KpiRow, lineCursor, lineDot, Section, Tip, tipCursor,
} from "@/components/analytics/chart-kit";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { StateBadge } from "@/components/platform/shared";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { fmtInt, fmtMoney, fmtMoneyShort, INK, monthShort, plural, SERIES } from "@/lib/analytics";
import { formatDate } from "@/lib/format";
import { type PlatformAnalytics, STATUS_LABEL, type SubStatus } from "@/lib/platform";
import { RefreshCw } from "lucide-react";

const n = (v: number | null) => fmtInt(v);
const money = (v: number | null) => fmtMoney(v);
const moneyAxis = { ...axis, tickFormatter: (v: number) => fmtMoneyShort(v) };

function SchoolList({ title, rows, empty, testId, columns }: {
  title: string; empty: string; testId: string;
  rows: { school_id: string; school: string; cells: React.ReactNode[] }[]; columns: string[];
}) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <h3 className="border-b border-line px-4 py-3 font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p> : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs text-muted">
              <tr><th className="px-4 py-2 font-medium">School</th>{columns.map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.school_id}>
                  <td className="px-4 py-2"><Link className="font-medium hover:underline" href={`/admin/schools/${r.school_id}?tab=subscription`}>{r.school}</Link></td>
                  {r.cells.map((c, i) => <td key={i} className="whitespace-nowrap px-4 py-2">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AnalyticsView() {
  const [d, setD] = useState<PlatformAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setD(await apiFetch<PlatformAnalytics>("/admin/analytics")); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !d) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState label="Working out the figures…" />;
  const s = d.schools;
  const sub = d.subscriptions;
  const states = (Object.keys(STATUS_LABEL) as SubStatus[]).filter((k) => k !== "none").map((k) => ({ state: k, label: STATUS_LABEL[k], schools: sub.by_state[k] ?? 0 }));
  const b = d.billing;
  const plans = sub.by_plan.filter((p) => p.schools > 0 || p.is_active);

  return (
    <div className={loading ? "opacity-60 transition-opacity" : ""} aria-busy={loading} data-testid="platform-analytics">
      <PageHeader title="Platform analytics" description={`Every school on the platform, worked out from the records. As of ${formatDate(d.as_of)}.`}
        actions={<Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}><RefreshCw className="size-4" /> Refresh</Button>} />

      <Section title="Schools and people">
        <KpiRow>
          <Kpi label="Schools" value={n(s.total)} hint={`${n(s.active)} active · ${n(s.inactive)} inactive · ${n(s.added_this_month)} added this month`} testId="pa-schools" />
          <Kpi label="In use" value={n(s.active_last_30_days)} hint={`schools active in the last 30 days (${n(s.active_last_7_days)} in the last 7)`} testId="pa-active" />
          <Kpi label="Students" value={n(d.people.students_active)} hint="active, across all schools" testId="pa-students" />
          <Kpi label="Sign-ins" value={n(d.people.accounts)} hint={`${n(d.people.staff)} staff · ${n(d.people.parents)} parents · ${n(d.people.student_logins)} students`} testId="pa-accounts" />
        </KpiRow>
        {(s.without_admin > 0 || s.without_subscription > 0) && (
          <p className="-mt-2 mb-4 text-sm" data-testid="pa-setup-gaps">
            {s.without_admin > 0 && <>{plural(s.without_admin, "school")} without an active administrator. </>}
            {s.without_subscription > 0 && <>{plural(s.without_subscription, "school")} without a plan. </>}
            <Link href="/admin/schools" className="text-leaf-700 hover:underline">Open schools</Link>
          </p>
        )}
        <Grid2>
          <ChartCard title="Schools on the platform" testId="chart-pa-schools" summary="Schools at the end of each month, and how many were added."
            columns={[{ label: "Month" }, { label: "Schools", numeric: true }, { label: "Added", numeric: true }]}
            rows={d.growth.map((g) => [monthShort(g.month), g.schools, g.new_schools])}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={d.growth} margin={{ top: 8, right: 12, left: -8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...axis} allowDecimals={false} width={44} />
                <Tooltip cursor={lineCursor} content={<Tip format={n} title={(l) => monthShort(String(l))} extra={(r) => `${fmtInt(r.new_schools as number)} added`} />} />
                <Line dataKey="schools" name="Schools" stroke={SERIES[0]} strokeWidth={2} dot={lineDot(SERIES[0])} activeDot={activeDot(SERIES[0])} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Schools in use" testId="chart-pa-active" summary="Schools whose people did something in the system each month."
            columns={[{ label: "Month" }, { label: "Schools in use", numeric: true }, { label: "New students", numeric: true }]}
            rows={d.growth.map((g) => [monthShort(g.month), g.active_schools, g.new_students])}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.growth} margin={{ top: 8, right: 8, left: -8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...axis} allowDecimals={false} width={44} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} title={(l) => monthShort(String(l))} extra={(r) => `${fmtInt(r.new_students as number)} new students`} />} />
                <Bar isAnimationActive={false} dataKey="active_schools" name="Schools in use" fill={SERIES[0]} radius={barTop} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>

      <Section title="Subscriptions">
        <KpiRow>
          <Kpi label="Recurring revenue" value={fmtMoneyShort(sub.mrr)} hint={`${fmtMoney(sub.mrr)} a month · ${fmtMoneyShort(sub.arr)} a year`} testId="pa-mrr" />
          <Kpi label="Active" value={n((sub.by_state.active ?? 0) + (sub.by_state.cancelling ?? 0))} hint={`${n(sub.by_state.cancelling ?? 0)} set to end at period end`} testId="pa-paying" />
          <Kpi label="On trial" value={n(sub.by_state.trialing ?? 0)} hint={`${n(sub.by_state.cancelled ?? 0)} cancelled`} testId="pa-trials" />
          <Kpi label="Need attention" value={n(sub.needs_attention.length)} tone={sub.needs_attention.length ? "warn" : undefined}
            hint={`${n(sub.by_state.grace ?? 0)} with a payment due · ${n(sub.by_state.expired ?? 0)} expired`} testId="pa-attention" />
        </KpiRow>
        <KpiRow>
          <Kpi label="Invoiced this month" value={fmtMoneyShort(b.invoiced_this_month)} hint={fmtMoney(b.invoiced_this_month)} testId="pa-invoiced" />
          <Kpi label="Received this month" value={fmtMoneyShort(b.collected_this_month)} hint="subscription payments, less refunds" testId="pa-received" />
          <Kpi label="Outstanding" value={fmtMoneyShort(b.outstanding)} hint={`${plural(b.open_invoices, "unpaid invoice")}`} testId="pa-outstanding" />
          <Kpi label="Overdue" value={fmtMoneyShort(b.overdue)} tone={b.overdue > 0 ? "warn" : undefined} hint={<Link href="/admin/invoices?state=overdue" className="hover:underline">past their due date</Link>} testId="pa-overdue" />
        </KpiRow>
        <Grid2>
          <ChartCard title="Recurring revenue by plan" testId="chart-pa-plans"
            summary="Monthly value of subscriptions that have been paid and are running (a yearly price counts as one twelfth a month). Trials and ended subscriptions count nothing."
            columns={[{ label: "Plan" }, { label: "Schools", numeric: true }, { label: "Paying", numeric: true }, { label: "A month", numeric: true, format: (v) => money(v as number) }]}
            rows={plans.map((p) => [p.plan, p.schools, p.paying, p.mrr])}
            empty={plans.length ? null : "No plans yet. Add them under Plans."} px={Math.max(160, plans.length * 36 + 36)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={plans} layout="vertical" margin={{ top: 0, right: 64, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...moneyAxis} />
                <YAxis type="category" dataKey="plan" {...axis} width={96} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} extra={(r) => `${fmtInt(r.paying as number)} of ${fmtInt(r.schools as number)} schools paying`} />} />
                <Bar isAnimationActive={false} dataKey="mrr" name="A month" fill={SERIES[0]} radius={barEnd} maxBarSize={22}>
                  <LabelList dataKey="mrr" position="right" fontSize={11} fill={INK} formatter={(v: number) => fmtMoneyShort(v)} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Where subscriptions stand" testId="chart-pa-states" summary="Schools by the state of their subscription today."
            columns={[{ label: "State" }, { label: "Schools", numeric: true }]} rows={states.map((x) => [x.label, x.schools])}
            empty={states.some((x) => x.schools) ? null : "No school has a plan yet."} px={Math.max(160, states.length * 32 + 36)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={states} layout="vertical" margin={{ top: 0, right: 40, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...axis} allowDecimals={false} />
                <YAxis type="category" dataKey="label" {...axis} width={96} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} />} />
                <Bar isAnimationActive={false} dataKey="schools" name="Schools" fill={SERIES[1]} radius={barEnd} maxBarSize={18}>
                  <LabelList dataKey="schools" position="right" fontSize={11} fill={INK} formatter={(v: number) => (v ? v : "")} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
        <div className="mt-4">
          <ChartCard title="Subscription money received" testId="chart-pa-revenue" summary="Subscription payments recorded each month, less refunds."
            columns={[{ label: "Month" }, { label: "Received", numeric: true, format: (v) => money(v as number) }]}
            rows={d.growth.map((g) => [monthShort(g.month), g.subscription_revenue])}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.growth} margin={{ top: 8, right: 8, left: 0 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...moneyAxis} width={56} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} title={(l) => monthShort(String(l))} />} />
                <Bar isAnimationActive={false} dataKey="subscription_revenue" name="Received" fill={SERIES[0]} radius={barTop} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <SchoolList title="Renewals and trials due in 30 days" testId="pa-renewals" empty="Nothing due in the next 30 days." columns={["Plan", "State", "Date"]}
            rows={sub.renewals_due.map((r) => ({ school_id: r.school_id, school: r.school, cells: [r.plan, <StateBadge key="s" state={r.state} />, formatDate(r.date)] }))} />
          <SchoolList title="Need attention" testId="pa-needs-attention" empty="Every active school's subscription is in order." columns={["Plan", "State", "Grace ends / ended"]}
            rows={sub.needs_attention.map((r) => ({ school_id: r.school_id, school: r.school, cells: [r.plan, <StateBadge key="s" state={r.state} />, formatDate(r.date)] }))} />
        </div>
      </Section>

      <Section title="Activity">
        <Grid2>
          <ChartCard title="Fees processed" testId="chart-pa-fees" summary="Fee receipts recorded across all schools each month (cancelled ones excluded)."
            columns={[{ label: "Month" }, { label: "Collected", numeric: true, format: (v) => money(v as number) }, { label: "Receipts", numeric: true }]}
            rows={d.growth.map((g) => [monthShort(g.month), g.fees_collected, g.receipts])}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.growth} margin={{ top: 8, right: 8, left: 0 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...moneyAxis} width={56} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} title={(l) => monthShort(String(l))} extra={(r) => `${fmtInt(r.receipts as number)} receipts`} />} />
                <Bar isAnimationActive={false} dataKey="fees_collected" name="Collected" fill={SERIES[0]} radius={barTop} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <SchoolList title="Largest schools" testId="pa-largest" empty="No schools yet." columns={["Students", "Staff"]}
            rows={d.largest_schools.map((r) => ({ school_id: r.school_id, school: r.school, cells: [fmtInt(r.students), fmtInt(r.staff)] }))} />
        </Grid2>
        <div className="mt-4">
          <SchoolList title="Over their plan's limits" testId="pa-over-limits" empty="No school is over its plan's limits." columns={["Plan", "Students", "Teachers"]}
            rows={d.over_limits.map((r) => ({ school_id: r.school_id, school: r.school, cells: [r.plan,
              `${fmtInt(r.students)}${r.max_students != null ? ` of ${fmtInt(r.max_students)}` : ""}`,
              `${fmtInt(r.teachers)}${r.max_teachers != null ? ` of ${fmtInt(r.max_teachers)}` : ""}`] }))} />
        </div>
      </Section>
    </div>
  );
}

export default function PlatformAnalyticsPage() {
  return <RequirePermission permission="platform:schools.manage"><AnalyticsView /></RequirePermission>;
}
