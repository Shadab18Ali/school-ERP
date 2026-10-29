"use client";

import { clsx } from "clsx";
import { AlertTriangle, BarChart3, Download, Table2, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { downloadCsv, GRID, MUTED, slug, toCsv } from "@/lib/analytics";

type Raw = string | number | null | undefined;
export interface Col { label: string; format?: (v: Raw) => string; numeric?: boolean }
export interface LegendItem { name: string; color: string; dashed?: boolean }

/** Recessive axes and grid shared by every chart. */
export const axis = { tick: { fontSize: 11, fill: MUTED }, tickLine: false, axisLine: false } as const;
export const grid = { stroke: GRID, strokeDasharray: "0", vertical: false } as const;
export const gridH = { stroke: GRID, strokeDasharray: "0", horizontal: false } as const;
/** 4px rounded data end, anchored to the baseline. */
export const barTop: [number, number, number, number] = [4, 4, 0, 0];
export const barEnd: [number, number, number, number] = [0, 4, 4, 0];
export const lineDot = (color: string) => ({ r: 4, fill: color, stroke: "#fff", strokeWidth: 2 });
export const activeDot = (color: string) => ({ r: 5, fill: color, stroke: "#fff", strokeWidth: 2 });

/**
 * One chart: title and one-line reading, a legend when there are two or more series, the chart,
 * and the same figures as a table (switch with the Chart / Table buttons; screen readers always
 * get the table). "CSV" downloads exactly the table.
 */
export function ChartCard({
  title, summary, columns, rows, legend, children, empty, height: heightClass = "h-64", px, className, testId, filename,
}: {
  title: string; summary: string; columns: Col[]; rows: Raw[][]; legend?: LegendItem[]; children: ReactNode;
  empty?: string | null; height?: string; px?: number; className?: string; testId?: string; filename?: string;
}) {
  const box = px ? { height: px } : undefined;
  const height = px ? "" : heightClass;
  const [view, setView] = useState<"chart" | "table">("chart");
  const id = useId();
  const isEmpty = !!empty;
  const fmt = (c: Col, v: Raw) => (c.format ? c.format(v) : v === null || v === undefined ? "—" : String(v));
  const table = (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-muted">
          {columns.map((c) => <th key={c.label} scope="col" className={clsx("px-2 py-1.5 font-medium", c.numeric && "text-right")}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line/60 last:border-0">
            {columns.map((c, j) => (
              <td key={c.label} className={clsx("px-2 py-1.5", c.numeric && "text-right tabular-nums", j === 0 && "font-medium")}>{fmt(c, r[j])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <figure className={clsx("flex min-w-0 flex-col rounded-lg border border-line bg-white p-4 sm:p-5", className)}
      aria-labelledby={`${id}-t`} data-testid={testId}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <figcaption id={`${id}-t`} className="font-semibold">{title}</figcaption>
          <p className="mt-0.5 text-xs text-muted">{summary}</p>
        </div>
        {!isEmpty && (
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex rounded-md border border-line p-0.5" role="group" aria-label={`${title}: show as`}>
              <IconToggle icon={BarChart3} label="Chart" active={view === "chart"} onClick={() => setView("chart")} />
              <IconToggle icon={Table2} label="Table" active={view === "table"} onClick={() => setView("table")} testId={testId && `${testId}-table`} />
            </div>
            <button type="button" title="Download CSV" aria-label={`Download ${title} as CSV`} data-testid={testId && `${testId}-csv`}
              onClick={() => downloadCsv(`${filename ?? slug(title)}.csv`, toCsv(columns.map((c) => c.label), rows))}
              className="grid size-8 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink">
              <Download className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
      {isEmpty ? (
        <p className={clsx("grid min-h-40 place-items-center rounded-md bg-paper px-4 text-center text-sm text-muted", height)}>{empty}</p>
      ) : view === "table" ? (
        <div className={clsx("overflow-auto", height || "max-h-96")}>{table}</div>
      ) : (
        <>
          {legend && legend.length > 1 && <Legend items={legend} />}
          <div className={clsx("min-w-0", height)} style={box} aria-hidden>{children}</div>
          <div className="sr-only">{table}</div>
        </>
      )}
    </figure>
  );
}

function IconToggle({ icon: Icon, label, active, onClick, testId }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={label} data-testid={testId}
      className={clsx("grid size-7 place-items-center rounded", active ? "bg-leaf-50 text-leaf-700" : "text-muted hover:text-ink")}>
      <Icon className="size-4" aria-hidden /><span className="sr-only">{label}</span>
    </button>
  );
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          {i.dashed
            ? <span className="h-0 w-3.5 border-t-2 border-dashed" style={{ borderColor: i.color }} aria-hidden />
            : <span className="size-2.5 rounded-sm" style={{ background: i.color }} aria-hidden />}
          {i.name}
        </li>
      ))}
    </ul>
  );
}

interface TipEntry { name?: string | number; value?: number | string | null; color?: string; dataKey?: string | number; payload?: Record<string, unknown> }

/** Hover card: the category, then each series with its swatch; values in ink, never in the series colour. */
export function Tip({ active, payload, label, title, format, extra }: {
  active?: boolean; payload?: TipEntry[]; label?: string | number;
  title?: (label: string | number | undefined, row: Record<string, unknown> | undefined) => string;
  format: (v: number | null, key: string) => string;
  extra?: (row: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="min-w-36 rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-ink">{title ? title(label, row) : label}</p>
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />{p.name}
            </span>
            <span className="font-medium tabular-nums text-ink">{format(p.value === undefined || p.value === null ? null : Number(p.value), String(p.dataKey))}</span>
          </li>
        ))}
      </ul>
      {extra && row && <div className="mt-1.5 border-t border-line pt-1.5 text-muted">{extra(row)}</div>}
    </div>
  );
}

export const tipCursor = { fill: "#f1f4f2" };
export const lineCursor = { stroke: MUTED, strokeWidth: 1, strokeDasharray: "3 3" };

/** A headline figure. */
export function Kpi({ label, value, hint, testId, tone }: { label: string; value: string; hint?: ReactNode; testId?: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4" data-testid={testId}>
      <p className="flex items-center gap-1 text-xs font-medium text-muted">
        {tone === "warn" && <AlertTriangle className="size-3.5 text-danger-600" aria-hidden />}{label}
      </p>
      <p className={clsx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", tone === "warn" ? "text-danger-600" : "text-ink")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8" aria-label={title}>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export function Grid2({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2">{children}</div>;
}
