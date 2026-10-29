"use client";

import { clsx } from "clsx";
import { Download, Printer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, apiFetchBlob, ApiError, errorMessage, saveBlob } from "@/lib/api";
import { DAY_NAMES, type TimetableCell, type TimetableGrid, type TimetablePeriod } from "@/lib/types";

const hm = (t: string) => t.slice(0, 5);
export const periodName = (p: TimetablePeriod) => p.label ?? (p.is_break ? "Break" : `Period ${p.period_number}`);

/** Periods down the side, days across. Prints cleanly (the app chrome is hidden when printing). */
export function TimetableGridView({ grid, onCell, testId = "timetable-grid" }: {
  grid: TimetableGrid; onCell?: (day: number, period: TimetablePeriod, cell: TimetableCell | null) => void; testId?: string;
}) {
  const bySlot = new Map(grid.cells.map((c) => [`${c.day_of_week}:${c.period_id}`, c]));
  if (grid.periods.length === 0) {
    return <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted" data-testid="no-periods">The school day (periods) hasn&apos;t been set up for this session yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white print:overflow-visible print:border-0">
      <table className="w-full min-w-[720px] table-fixed border-collapse text-sm print:min-w-0" data-testid={testId}>
        <thead>
          <tr className="bg-paper text-xs text-muted">
            <th scope="col" className="w-28 border-b border-line px-3 py-2 text-left">Period</th>
            {grid.days.map((d) => <th key={d} scope="col" className="border-b border-l border-line px-2 py-2">{DAY_NAMES[d]}</th>)}
          </tr>
        </thead>
        <tbody>
          {grid.periods.map((p) => (
            <tr key={p.id}>
              <th scope="row" className="border-b border-line bg-paper/60 px-3 py-2 text-left align-top">
                <span className="block text-xs font-semibold">{periodName(p)}</span>
                <span className="tabular text-xs font-normal text-muted">{hm(p.start_time)}–{hm(p.end_time)}</span>
              </th>
              {p.is_break ? (
                <td colSpan={grid.days.length} className="border-b border-l border-line bg-pencil-100/40 text-center text-xs font-semibold uppercase tracking-wide text-muted">{periodName(p)}</td>
              ) : grid.days.map((d) => {
                const c = bySlot.get(`${d}:${p.id}`) ?? null;
                const label = c ? `${c.subject_name}, ${DAY_NAMES[d]} ${periodName(p)}` : `Empty, ${DAY_NAMES[d]} ${periodName(p)}`;
                const body = c ? (
                  <>
                    <span className="block font-semibold leading-tight">{c.subject_name}</span>
                    <span className="block text-xs leading-tight text-muted">
                      {[grid.kind === "class" ? c.teacher_name : `${c.class_name} – ${c.section_name}`, c.room].filter(Boolean).join(" · ")}
                    </span>
                  </>
                ) : onCell ? <span className="text-xs text-line print:hidden">+</span> : null;
                return (
                  <td key={d} className="h-14 border-b border-l border-line p-0 text-center align-middle" data-testid={`slot-${d}-${p.period_number}`}>
                    {onCell ? (
                      <button type="button" onClick={() => onCell(d, p, c)} aria-label={label}
                        className={clsx("size-full px-1.5 py-1.5 hover:bg-leaf-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-leaf-600", c && "bg-leaf-50/40")}>
                        {body}
                      </button>
                    ) : <div className="px-1.5 py-1.5">{body}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Print (browser) and Download PDF (server-made, the same layout on every printer). */
export function TimetableActions({ pdfPath, schoolId, name }: { pdfPath: string; schoolId: string; name: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const { blob, filename } = await apiFetchBlob(pdfPath, { schoolId });
      saveBlob(blob, filename ?? `timetable-${name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.pdf`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex gap-2 print:hidden">
      <Button variant="secondary" size="sm" onClick={() => window.print()}><Printer className="size-4" /> Print</Button>
      <Button variant="secondary" size="sm" onClick={download} loading={busy} data-testid="timetable-pdf"><Download className="size-4" /> Download PDF</Button>
    </span>
  );
}

/** Read-only timetable loaded from `path` (used by teacher, parent and student views). */
export function TimetablePanel({ path, schoolId, emptyMessage }: { path: string; schoolId: string; emptyMessage?: string }) {
  const [g, setG] = useState<TimetableGrid | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setG(await apiFetch<TimetableGrid>(path, { schoolId })); }
    catch (e) { setError({ message: errorMessage(e), missing: e instanceof ApiError && e.status === 404 }); }
  }, [path, schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) {
    return error.missing
      ? <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted" data-testid="timetable-missing">{emptyMessage ?? error.message}</p>
      : <ErrorState message={error.message} onRetry={load} />;
  }
  if (!g) return <LoadingState />;
  return (
    <section data-testid="timetable-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold" data-testid="timetable-title">{g.title}</h2>
          {g.session_name && <p className="text-xs text-muted">Session {g.session_name}</p>}
        </div>
        {g.periods.length > 0 && <TimetableActions pdfPath={`${path}/pdf`} schoolId={schoolId} name={g.title} />}
      </div>
      {g.periods.length > 0 && g.cells.length === 0
        ? <p className="mb-3 text-sm text-muted" data-testid="timetable-empty">No lessons have been timetabled yet.</p> : null}
      <TimetableGridView grid={g} />
    </section>
  );
}
