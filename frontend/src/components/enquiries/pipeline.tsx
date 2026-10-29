"use client";

import { clsx } from "clsx";
import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EnquiryStatusBadge, FollowUpDate, sessionLabel, useClassesAndSessions } from "@/components/enquiries/shared";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { type EnquiryStatus, type Pipeline } from "@/lib/enquiries";
import { formatPhone } from "@/lib/format";
import { MONTH_NAMES } from "@/lib/money";

const LEAF = "#2f6b57";
const PENCIL = "#f2c230";
const INK = "#5d6b67";
const LINE = "#dfe4e1";
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "—");

function Tile({ label, value, sub, href, tone, testId, onClick }: {
  label: string; value: string; sub?: string; href?: string; tone?: "danger" | "strong"; testId: string; onClick?: () => void;
}) {
  const body = (
    <div className={clsx("h-full rounded-lg p-4 text-left", tone === "strong" ? "bg-board-900 text-white" : "border border-line bg-white transition-colors hover:border-leaf-600")}>
      <p className={clsx("text-xs", tone === "strong" ? "text-white/60" : "text-muted")}>{label}</p>
      <p className={clsx("tabular mt-1 text-2xl font-semibold tracking-tight", tone === "danger" && "text-danger-600")} data-testid={testId}>{value}</p>
      {sub && <p className={clsx("mt-0.5 text-xs", tone === "strong" ? "text-white/60" : "text-muted")}>{sub}</p>}
    </div>
  );
  if (onClick) return <button type="button" onClick={onClick} className="block w-full">{body}</button>;
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

function Funnel({ stages }: { stages: Pipeline["funnel"] }) {
  const top = stages[0]?.count ?? 0;
  return (
    <section className="rounded-lg border border-line bg-white p-5" aria-labelledby="funnel-title">
      <h2 id="funnel-title" className="font-semibold">Admission funnel</h2>
      <p className="mb-4 text-xs text-muted">How many enquiries reached each stage (or went further), as a share of all enquiries.</p>
      <ol className="space-y-2.5" data-testid="funnel">
        {stages.map((s, i) => {
          const w = top ? Math.max((100 * s.count) / top, s.count ? 2 : 0) : 0;
          const prev = i > 0 ? stages[i - 1].count : null;
          return (
            <li key={s.stage} className="grid grid-cols-[6.5rem_1fr_5.5rem] items-center gap-3 text-sm" data-testid={`funnel-${s.stage}`}>
              <span className="font-medium">{s.label}</span>
              <span className="h-6 rounded bg-paper" aria-hidden>
                <span className="block h-full rounded" style={{ width: `${w}%`, background: s.stage === "admitted" ? "var(--color-board-900)" : LEAF, opacity: 1 - i * 0.09 }} />
              </span>
              <span className="tabular text-right">
                <span className="font-semibold" data-testid="funnel-count">{s.count}</span> <span className="text-xs text-muted">{pct(s.count, top)}</span>
                {prev !== null && prev > 0 && <span className="block text-[11px] text-muted">{pct(s.count, prev)} of previous</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StatusBoard({ items, onPick }: { items: Pipeline["by_status"]; onPick: (s: EnquiryStatus) => void }) {
  return (
    <section className="rounded-lg border border-line bg-white p-5">
      <h2 className="font-semibold">Where enquiries are now</h2>
      <p className="mb-4 text-xs text-muted">Current status of each enquiry. Select one to see the list.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="status-board">
        {items.map((s) => (
          <button key={s.status} type="button" onClick={() => onPick(s.status)} data-testid={`board-${s.status}`}
            className="rounded-md border border-line p-3 text-left hover:border-leaf-600">
            <EnquiryStatusBadge status={s.status} />
            <span className="tabular mt-1.5 block text-xl font-semibold">{s.count}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function MonthlyChart({ data }: { data: Pipeline["monthly"] }) {
  const points = data.map((d) => ({ ...d, label: `${MONTH_NAMES[Number(d.month.slice(5, 7)) - 1]} ${d.month.slice(2, 4)}` }));
  return (
    <figure className="rounded-lg border border-line bg-white p-5" aria-label="Enquiries by month">
      <figcaption className="font-semibold">Enquiries by month</figcaption>
      <p className="mb-3 text-xs text-muted">Enquiries received each month, and how many of them have been admitted so far.</p>
      {points.length === 0 ? <p className="py-6 text-center text-sm text-muted">No enquiries in this period.</p> : (
        <div className="h-56" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ left: 0, right: 8, top: 4 }} maxBarSize={48}>
              <CartesianGrid vertical={false} stroke={LINE} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} width={32} />
              <Tooltip cursor={{ fill: "#eef5f1" }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="enquiries" name="Enquiries" fill={LEAF} radius={[3, 3, 0, 0]} />
              <Bar dataKey="admitted" name="Admitted" fill={PENCIL} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <table className="sr-only"><thead><tr><th>Month</th><th>Enquiries</th><th>Admitted</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.month}><td>{p.label}</td><td>{p.enquiries}</td><td>{p.admitted}</td></tr>)}</tbody></table>
    </figure>
  );
}

function Table({ title, hint, head, rows, testId }: { title: string; hint: string; head: string[]; rows: (string | number)[][]; testId: string }) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="p-5 pb-3"><h2 className="font-semibold">{title}</h2><p className="text-xs text-muted">{hint}</p></div>
      {rows.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">No enquiries in this period.</p> : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
              <tr>{head.map((h, i) => <th key={h} className={clsx("px-5 py-2", i > 0 && "text-right")}>{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => <tr key={String(r[0])}>{r.map((c, i) => <td key={i} className={clsx("px-5 py-2", i > 0 && "tabular text-right")}>{c}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PipelineView({ schoolId, onPickStatus, onPickFollowUp }: {
  schoolId: string; onPickStatus: (s: EnquiryStatus, session: string) => void; onPickFollowUp: (f: "overdue" | "today", session: string) => void;
}) {
  const { sessions } = useClassesAndSessions(schoolId);
  const [session, setSession] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [d, setD] = useState<Pipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<Pipeline>("/enquiries/pipeline", { schoolId, query: { session_id: session || undefined, date_from: from || undefined, date_to: to || undefined } });
      if (mine === latest.current) setD(r);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, session, from, to]);
  useEffect(() => { void load(); }, [load]);

  const sid = session || d?.session?.id || "";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-white p-4">
        <SelectField label="Academic session" value={sid} onChange={(e) => setSession(e.target.value)}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
        </SelectField>
        <TextField label="Enquiries from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {(from || to) && <Button variant="ghost" onClick={() => { setFrom(""); setTo(""); }}>Clear dates</Button>}
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : !d.session ? (
        <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted">Set up an academic session first.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Tile label="Enquiries" value={String(d.total)} sub={`${d.new_last_7_days} in the last 7 days`} tone="strong" testId="kpi-enquiries" />
            <Tile label="Open" value={String(d.open)} sub="not admitted or rejected" testId="kpi-open" />
            <Tile label="Follow-ups due today" value={String(d.follow_ups.today)} sub={`${d.follow_ups.next_7_days} more in the next 7 days`}
              onClick={() => onPickFollowUp("today", d.session!.id)} testId="kpi-today" />
            <Tile label="Overdue follow-ups" value={String(d.follow_ups.overdue)} sub={`${d.follow_ups.not_scheduled} open with no date`}
              tone={d.follow_ups.overdue ? "danger" : undefined} onClick={() => onPickFollowUp("overdue", d.session!.id)} testId="kpi-overdue" />
            <Tile label="Admitted" value={String(d.admitted)}
              sub={d.conversion_rate === null ? "no enquiries yet" : `${d.conversion_rate}% of enquiries${d.win_rate !== null ? ` · ${d.win_rate}% of closed` : ""}`} testId="kpi-admitted" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Funnel stages={d.funnel} />
            <StatusBoard items={d.by_status} onPick={(s) => onPickStatus(s, d.session!.id)} />
          </div>
          <section className="rounded-lg border border-line bg-white">
            <div className="flex items-center gap-2 p-5 pb-3"><CalendarClock className="size-4 text-muted" /><h2 className="font-semibold">Follow-ups due</h2></div>
            {d.due.length === 0 ? <p className="px-5 pb-5 text-sm text-muted" data-testid="no-due">Nothing due today. Well done.</p> : (
              <ul className="divide-y divide-line" data-testid="due-list">
                {d.due.map((e) => (
                  <li key={e.id}>
                    <Link href={`/enquiries/${e.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm hover:bg-paper">
                      <span className="min-w-0 flex-1"><span className="font-medium">{e.student_name}</span> <span className="text-muted">· {e.parent_name} · {formatPhone(e.phone)}</span></span>
                      <EnquiryStatusBadge status={e.status} />
                      <span className="w-36 text-right"><FollowUpDate date={e.follow_up_date} status={e.status} /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <MonthlyChart data={d.monthly} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Table title="By source" hint="Where enquiries came from, and how many were admitted." testId="by-source"
              head={["Source", "Enquiries", "Admitted", "Conversion"]}
              rows={d.by_source.map((s) => [s.label, s.total, s.admitted, s.conversion_rate === null ? "—" : `${s.conversion_rate}%`])} />
            <Table title="By class" hint="Interested class of each enquiry." testId="by-class"
              head={["Class", "Enquiries", "Open", "Admitted"]}
              rows={d.by_class.map((c) => [c.class_name, c.total, c.open, c.admitted])} />
          </div>
        </>
      )}
    </div>
  );
}
