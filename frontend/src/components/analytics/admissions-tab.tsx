"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { staffLabel } from "@/components/admissions/shared";
import {
  activeDot, axis, barEnd, barTop, ChartCard, Grid2, grid, gridH, Kpi, KpiRow, lineCursor, lineDot, Section, Tip, tipCursor,
} from "@/components/analytics/chart-kit";
import { type AdmissionAnalytics, fmtInt, fmtPct, INK, monthShort, RAMP, SERIES } from "@/lib/analytics";
import { ENQUIRY_STATUS_LABEL, type EnquirySource, type EnquiryStatus, SOURCE_LABEL } from "@/lib/enquiries";
import type { AdmissionStatus } from "@/lib/public-api";

// one colour per figure across the tab
const C = { enquiries: SERIES[0], applications: SERIES[1], admissions: SERIES[2] };
const n = (v: number | null) => fmtInt(v);
const rowsH = (count: number) => Math.max(160, count * 32 + 36);

function Funnel({ title, summary, stages, testId }: { title: string; summary: string; stages: { stage: string; count: number }[]; testId: string }) {
  const first = stages[0]?.count ?? 0;
  const rows = stages.map((s) => ({ ...s, share: first ? Math.round((1000 * s.count) / first) / 10 : null }));
  return (
    <ChartCard title={title} summary={summary} testId={testId}
      columns={[{ label: "Stage" }, { label: "Count", numeric: true }, { label: `% of ${stages[0]?.stage.toLowerCase() ?? "first"}`, numeric: true, format: (v) => fmtPct(v as number | null) }]}
      rows={rows.map((r) => [r.stage, r.count, r.share])}
      empty={first ? null : "Nothing in this period."} px={rowsH(stages.length)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 88, left: 8 }} barCategoryGap="18%">
          <CartesianGrid {...gridH} />
          <XAxis type="number" {...axis} allowDecimals={false} />
          <YAxis type="category" dataKey="stage" {...axis} width={80} interval={0} />
          <Tooltip cursor={tipCursor} content={<Tip format={n} extra={(r) => `${fmtPct(r.share as number | null)} of ${stages[0].stage.toLowerCase()}`} />} />
          <Bar isAnimationActive={false} dataKey="count" name="Count" radius={barEnd} maxBarSize={28}>
            {rows.map((r, i) => <Cell key={r.stage} fill={RAMP[Math.min(i, 3)]} />)}
            <LabelList position="right" fontSize={11} fill={INK}
              content={(props) => {
                const { x = 0, y = 0, width = 0, height = 0, index = 0 } = props as { x?: number; y?: number; width?: number; height?: number; index?: number };
                const r = rows[index];
                return <text x={Number(x) + Number(width) + 6} y={Number(y) + Number(height) / 2} dy={4} fontSize={11} fill={INK}>
                  {fmtInt(r.count)}{index > 0 && r.share !== null ? ` · ${r.share}%` : ""}
                </text>;
              }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function AdmissionsTab({ data }: { data: AdmissionAnalytics }) {
  const k = data.kpis;
  const sources = data.by_source.map((s) => ({ ...s, label: SOURCE_LABEL[s.source as EnquirySource] ?? s.source }));
  const statuses = data.by_status.map((s) => ({ ...s, label: ENQUIRY_STATUS_LABEL[s.status as EnquiryStatus] ?? s.status }));
  const appStatuses = data.application_status.map((s) => ({ ...s, label: staffLabel(s.status as AdmissionStatus) }));
  const monthlyAny = data.monthly.some((x) => x.enquiries || x.applications || x.admissions);
  const three = [
    { key: "enquiries", name: "Enquiries", color: C.enquiries },
    { key: "applications", name: "Applications", color: C.applications },
    { key: "admissions", name: "Admissions", color: C.admissions },
  ];

  return (
    <>
      <Section title="Overview">
        <KpiRow>
          <Kpi label="Enquiries" value={n(k.enquiries)} testId="kpi-enquiries"
            hint={`${n(k.enquiries_open)} still open${k.follow_ups_overdue ? ` · ${n(k.follow_ups_overdue)} follow-ups overdue` : ""}`} />
          <Kpi label="Applications" value={n(k.applications)} testId="kpi-applications"
            hint={`${n(k.applications_pending)} pending · ${n(k.applications_approved)} approved · ${n(k.applications_rejected)} rejected`} />
          <Kpi label="Admissions" value={n(k.admissions)} testId="kpi-admissions"
            hint={`${n(k.admissions_online)} from online applications · ${n(k.admissions_direct)} direct`} />
          <Kpi label="Enquiry conversion" value={fmtPct(k.enquiry_conversion)} testId="kpi-conversion"
            hint={`Enquiries that became students · applications: ${fmtPct(k.application_conversion)}`} />
        </KpiRow>
        {k.follow_ups_overdue > 0 && (
          <p className="-mt-2 mb-4 text-xs text-muted">
            Overdue follow-ups count open enquiries whose follow-up date has passed, whatever the period.
          </p>
        )}
        <ChartCard title="Enquiries, applications and admissions by month" testId="chart-adm-monthly"
          summary="Enquiries by enquiry date, online applications by the day they were sent, admissions by admission date."
          legend={three.map((s) => ({ name: s.name, color: s.color }))}
          columns={[{ label: "Month" }, { label: "Enquiries", numeric: true }, { label: "Applications", numeric: true }, { label: "Admissions", numeric: true }]}
          rows={data.monthly.map((x) => [monthShort(x.month), x.enquiries, x.applications, x.admissions])}
          empty={monthlyAny ? null : "No enquiries, applications or admissions in this period."}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.monthly} margin={{ top: 8, right: 12, left: -8 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="month" tickFormatter={monthShort} {...axis} padding={{ left: 12, right: 12 }} />
              <YAxis {...axis} allowDecimals={false} width={44} />
              <Tooltip cursor={lineCursor} content={<Tip format={n} title={(l) => monthShort(String(l))} />} />
              {three.map((s) => (
                <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={lineDot(s.color)} activeDot={activeDot(s.color)} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </Section>

      <Section title="Conversion">
        <Grid2>
          <Funnel title="Enquiry funnel" testId="chart-enquiry-funnel" stages={data.enquiry_funnel}
            summary="Enquiries in the period, and how far they have got: applied online, approved, became a student." />
          <Funnel title="Online application funnel" testId="chart-application-funnel" stages={data.application_funnel}
            summary="Online applications in the period by the furthest stage reached." />
          <ChartCard title="Enquiries by source" testId="chart-sources"
            summary="Where enquiries came from, and how many of each became students."
            legend={[{ name: "Enquiries", color: C.enquiries }, { name: "Admitted", color: C.admissions }]}
            columns={[{ label: "Source" }, { label: "Enquiries", numeric: true }, { label: "Admitted", numeric: true },
              { label: "Conversion", numeric: true, format: (v) => fmtPct(v as number | null) }]}
            rows={sources.map((s) => [s.label, s.enquiries, s.admitted, s.conversion])}
            empty={sources.length ? null : "No enquiries in this period."} px={rowsH(sources.length * 1.6)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sources} layout="vertical" margin={{ top: 0, right: 24, left: 8 }} barGap={2}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...axis} allowDecimals={false} />
                <YAxis type="category" dataKey="label" {...axis} width={104} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} extra={(r) => `${fmtPct(r.conversion as number | null)} became students`} />} />
                <Bar isAnimationActive={false} dataKey="enquiries" name="Enquiries" fill={C.enquiries} radius={barEnd} barSize={14} />
                <Bar isAnimationActive={false} dataKey="admitted" name="Admitted" fill={C.admissions} radius={barEnd} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="By class" testId="chart-adm-class"
            summary="Enquiries, online applications and admissions for each class."
            legend={three.map((s) => ({ name: s.name, color: s.color }))}
            columns={[{ label: "Class" }, { label: "Enquiries", numeric: true }, { label: "Applications", numeric: true }, { label: "Admissions", numeric: true }]}
            rows={data.by_class.map((c) => [c.class, c.enquiries, c.applications, c.admissions])}
            empty={data.by_class.length ? null : "Nothing in this period."}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_class} margin={{ top: 8, right: 8, left: -8 }} barGap={2}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="class" {...axis} interval={0} />
                <YAxis {...axis} allowDecimals={false} width={44} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} />} />
                {three.map((s) => <Bar isAnimationActive={false} key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={barTop} barSize={18} />)}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>

      <Section title="Where things stand">
        <Grid2>
          <ChartCard title="Enquiries by status" testId="chart-enquiry-status"
            summary="Enquiries in the period by their status today."
            columns={[{ label: "Status" }, { label: "Enquiries", numeric: true }]}
            rows={statuses.map((s) => [s.label, s.enquiries])}
            empty={k.enquiries ? null : "No enquiries in this period."} px={rowsH(statuses.length)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statuses} layout="vertical" margin={{ top: 0, right: 40, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...axis} allowDecimals={false} />
                <YAxis type="category" dataKey="label" {...axis} width={88} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} />} />
                <Bar isAnimationActive={false} dataKey="enquiries" name="Enquiries" fill={C.enquiries} radius={barEnd} maxBarSize={18}>
                  <LabelList dataKey="enquiries" position="right" fontSize={11} fill={INK} formatter={(v: number) => (v ? v : "")} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Online applications by status" testId="chart-application-status"
            summary="Online applications in the period by their status today."
            columns={[{ label: "Status" }, { label: "Applications", numeric: true }]}
            rows={appStatuses.map((s) => [s.label, s.applications])}
            empty={k.applications ? null : "No online applications in this period."} px={rowsH(appStatuses.length)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={appStatuses} layout="vertical" margin={{ top: 0, right: 40, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...axis} allowDecimals={false} />
                <YAxis type="category" dataKey="label" {...axis} width={104} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} />} />
                <Bar isAnimationActive={false} dataKey="applications" name="Applications" fill={C.applications} radius={barEnd} maxBarSize={18}>
                  <LabelList dataKey="applications" position="right" fontSize={11} fill={INK} formatter={(v: number) => (v ? v : "")} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>
    </>
  );
}
