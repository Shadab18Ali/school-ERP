"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  activeDot, axis, barEnd, barTop, ChartCard, Grid2, grid, gridH, Kpi, KpiRow, lineCursor, lineDot, Section, Tip, tipCursor,
} from "@/components/analytics/chart-kit";
import {
  type FeeAnalytics, fmtInt, fmtMoney, fmtMoneyShort, fmtPct, INK, methodLabel, monthShort, plural, RAMP, SERIES,
} from "@/lib/analytics";
import { formatDate } from "@/lib/format";

// one colour per figure across the whole tab
const C = { collected: SERIES[0], due: SERIES[1], outstanding: SERIES[2], previous: SERIES[3] };
const NOT_DUE = "#b9c4bf";
const money = (v: number | null) => fmtMoney(v);
const moneyAxis = { ...axis, tickFormatter: (v: number) => fmtMoneyShort(v) };
const m = (v: unknown) => fmtMoney(v as number | null);
const rowsH = (count: number) => Math.max(160, count * 32 + 36);

export function FeesTab({ data }: { data: FeeAnalytics }) {
  const k = data.kpis;
  const prev = data.previous_session?.name;
  const range = data.window.from && data.window.to ? `${formatDate(data.window.from)} – ${formatDate(data.window.to)}` : "";
  const anyCollected = data.monthly.some((x) => x.collected > 0 || (x.previous ?? 0) > 0);
  const trendShown = data.outstanding_trend.some((x) => x.due > 0);

  return (
    <>
      <Section title="Collection">
        <KpiRow>
          <Kpi label="Collected" value={fmtMoneyShort(k.collected)} testId="kpi-collected"
            hint={<>{fmtMoney(k.collected)} · {plural(k.receipts, "receipt")}{range && <><br />{range}</>}</>} />
          <Kpi label="Collection rate" value={fmtPct(k.collection_rate)} testId="kpi-rate"
            hint={`${fmtMoneyShort(k.paid_to_date)} paid of ${fmtMoneyShort(k.due_to_date)} due so far`} />
          <Kpi label="Outstanding" value={fmtMoneyShort(k.outstanding)} testId="kpi-outstanding"
            hint={`${fmtMoney(k.outstanding)} · ${plural(k.students_with_dues, "student")}`} />
          <Kpi label="Overdue" value={fmtMoneyShort(k.overdue)} testId="kpi-overdue" tone={k.overdue > 0 ? "warn" : undefined}
            hint="Due this month or earlier, still unpaid" />
        </KpiRow>
        {k.cancelled_receipts > 0 && (
          <p className="-mt-2 mb-4 text-xs text-muted" data-testid="cancelled-note">
            Not counted: {fmtInt(k.cancelled_receipts)} cancelled or refunded receipt{k.cancelled_receipts === 1 ? "" : "s"} ({fmtMoney(k.cancelled)}).
          </p>
        )}
        <Grid2>
          <ChartCard title="Monthly collection" testId="chart-fee-monthly"
            summary={prev ? `Receipts each month, beside the same month of ${prev}. Months outside the period are faded.` : "Receipts each month of the session. Months outside the period are faded."}
            legend={[{ name: "This session", color: C.collected }, ...(prev ? [{ name: prev, color: C.previous }] : [])]}
            columns={[{ label: "Month" }, { label: "Collected", numeric: true, format: m }, { label: "Receipts", numeric: true },
              ...(prev ? [{ label: prev, numeric: true, format: m }] : [])]}
            rows={data.monthly.map((x) => [monthShort(x.month), x.collected, x.receipts, ...(prev ? [x.previous] : [])])}
            empty={anyCollected ? null : "No receipts in this session yet."}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.monthly} margin={{ top: 8, right: 8, left: 0 }} barGap={2}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...moneyAxis} width={56} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} title={(l) => monthShort(String(l))} extra={(r) => `${fmtInt(r.receipts as number)} receipts`} />} />
                <Bar isAnimationActive={false} dataKey="collected" name="This session" fill={C.collected} radius={barTop} barSize={22}>
                  {data.monthly.map((x) => <Cell key={x.month} fillOpacity={x.in_window ? 1 : 0.3} />)}
                </Bar>
                {prev && <Bar isAnimationActive={false} dataKey="previous" name={prev} fill={C.previous} radius={barTop} barSize={22} />}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Outstanding over time" testId="chart-outstanding-trend"
            summary="At each month end: fees due by then, and how much of that was still unpaid."
            legend={[{ name: "Due by month end", color: C.due }, { name: "Outstanding", color: C.outstanding }]}
            columns={[{ label: "Month" }, { label: "Due by month end", numeric: true, format: m }, { label: "Outstanding", numeric: true, format: m }]}
            rows={data.outstanding_trend.map((x) => [monthShort(x.month), x.due, x.outstanding])}
            empty={trendShown ? null : "No fees due yet this session."}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.outstanding_trend} margin={{ top: 8, right: 12, left: 0 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...moneyAxis} width={56} />
                <Tooltip cursor={lineCursor} content={<Tip format={money} title={(l) => `End of ${monthShort(String(l))}`} />} />
                <Line dataKey="due" name="Due by month end" stroke={C.due} strokeWidth={2} dot={lineDot(C.due)} activeDot={activeDot(C.due)} isAnimationActive={false} />
                <Line dataKey="outstanding" name="Outstanding" stroke={C.outstanding} strokeWidth={2} dot={lineDot(C.outstanding)} activeDot={activeDot(C.outstanding)} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>

      <Section title="Pending fees">
        <Grid2>
          <ChartCard title="Collection by class" testId="chart-fee-class"
            summary="Fees collected in the period, and still outstanding, per class. Hover for the collection rate."
            legend={[{ name: "Collected", color: C.collected }, { name: "Outstanding", color: C.outstanding }]}
            columns={[{ label: "Class" }, { label: "Billed", numeric: true, format: m }, { label: "Due so far", numeric: true, format: m },
              { label: "Collected", numeric: true, format: m }, { label: "Outstanding", numeric: true, format: m }, { label: "Overdue", numeric: true, format: m },
              { label: "Collection rate", numeric: true, format: (v) => fmtPct(v as number | null) }]}
            rows={data.by_class.map((c) => [c.class, c.billed, c.due_to_date, c.collected, c.outstanding, c.overdue, c.collection_rate])}
            empty={data.by_class.length ? null : "No fees set for any class this session."} px={rowsH(data.by_class.length * 1.6)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_class} layout="vertical" margin={{ top: 0, right: 16, left: 8 }} barGap={2}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...moneyAxis} />
                <YAxis type="category" dataKey="class" {...axis} width={88} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} extra={(r) => <>
                  <div>Collection rate {fmtPct(r.collection_rate as number | null)}</div>
                  <div>Overdue {fmtMoney(r.overdue as number)}</div></>} />} />
                <Bar isAnimationActive={false} dataKey="collected" name="Collected" fill={C.collected} radius={barEnd} barSize={14} />
                <Bar isAnimationActive={false} dataKey="outstanding" name="Outstanding" fill={C.outstanding} radius={barEnd} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="How late the pending fees are" testId="chart-aging"
            summary="Unpaid dues by the month they fell due. Later months aren't due yet."
            columns={[{ label: "Due" }, { label: "Amount", numeric: true, format: m }]}
            rows={data.aging.map((a) => [a.bucket, a.amount])}
            empty={data.aging.some((a) => a.amount > 0) ? null : "Nothing pending."} px={rowsH(data.aging.length)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.aging} layout="vertical" margin={{ top: 0, right: 56, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...moneyAxis} />
                <YAxis type="category" dataKey="bucket" {...axis} width={104} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} />} />
                <Bar isAnimationActive={false} dataKey="amount" name="Unpaid" radius={barEnd} maxBarSize={22}>
                  {data.aging.map((a, i) => <Cell key={a.bucket} fill={a.bucket === "Not yet due" ? NOT_DUE : RAMP[Math.min(i, 3)]} />)}
                  <LabelList dataKey="amount" position="right" fontSize={11} fill={INK} formatter={(v: number) => (v ? fmtMoneyShort(v) : "")} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="By fee head" testId="chart-fee-head"
            summary="What each fee head bills this session, and how much of it is unpaid."
            legend={[{ name: "Billed", color: C.due }, { name: "Outstanding", color: C.outstanding }]}
            columns={[{ label: "Fee head" }, { label: "Billed", numeric: true, format: m }, { label: "Outstanding", numeric: true, format: m },
              { label: "Overdue", numeric: true, format: m }]}
            rows={data.by_head.map((h) => [h.fee_head, h.billed, h.outstanding, h.overdue])}
            empty={data.by_head.length ? null : "No fee heads billed this session."} px={rowsH(data.by_head.length * 1.6)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_head} layout="vertical" margin={{ top: 0, right: 16, left: 8 }} barGap={2}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...moneyAxis} />
                <YAxis type="category" dataKey="fee_head" {...axis} width={96} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} extra={(r) => `Overdue ${fmtMoney(r.overdue as number)}`} />} />
                <Bar isAnimationActive={false} dataKey="billed" name="Billed" fill={C.due} radius={barEnd} barSize={14} />
                <Bar isAnimationActive={false} dataKey="outstanding" name="Outstanding" fill={C.outstanding} radius={barEnd} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Payment methods" testId="chart-methods"
            summary={`How the money in the period was paid.${data.online_methods.length ? " Online payments are split by what the payer used." : ""}`}
            columns={[{ label: "Method" }, { label: "Amount", numeric: true, format: m }, { label: "Receipts", numeric: true }]}
            rows={[...data.by_method.map((x) => [methodLabel(x.method), x.amount, x.receipts]),
              ...data.online_methods.map((x) => [`Online: ${methodLabel(x.method)}`, x.amount, x.receipts])]}
            empty={data.by_method.length ? null : "No receipts in this period."} px={rowsH(data.by_method.length)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.by_method.map((x) => ({ ...x, label: methodLabel(x.method) }))} layout="vertical" margin={{ top: 0, right: 64, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...moneyAxis} />
                <YAxis type="category" dataKey="label" {...axis} width={96} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={money} extra={(r) => {
                  const online = r.method === "online" ? data.online_methods : [];
                  return <>
                    <div>{fmtInt(r.receipts as number)} receipts</div>
                    {online.map((o) => <div key={o.method}>{methodLabel(o.method)}: {fmtMoney(o.amount)}</div>)}
                  </>;
                }} />} />
                <Bar isAnimationActive={false} dataKey="amount" name="Collected" fill={C.collected} radius={barEnd} maxBarSize={20}>
                  <LabelList dataKey="amount" position="right" fontSize={11} fill={INK} formatter={(v: number) => fmtMoneyShort(v)} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>
    </>
  );
}
