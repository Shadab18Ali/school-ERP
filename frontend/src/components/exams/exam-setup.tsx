"use client";

import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { ExamType, GradeBand } from "@/lib/types";

interface Setup { types: ExamType[]; grades: GradeBand[] }
type Row = { grade: string; min: string; remark: string };

/** Exam types (Unit Test, Half Yearly, Annual, custom) and the grading scale. */
export function ExamSetup({ schoolId, onChange }: { schoolId: string; onChange?: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [typeError, setTypeError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((s: Setup) => {
    setD(s);
    setRows(s.grades.map((g) => ({ grade: g.grade, min: g.min_percentage, remark: g.remark ?? "" })));
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try { apply(await apiFetch<Setup>("/exams/setup", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId, apply]);
  useEffect(() => { void load(); }, [load]);

  async function call(key: string, fn: () => Promise<Setup>, ok?: string) {
    setBusy(key);
    try { apply(await fn()); onChange?.(); if (ok) toast.success(ok); return true; }
    catch (e) { if (key === "type") setTypeError(errorMessage(e)); else if (key.startsWith("grade")) setGradeError(errorMessage(e)); else toast.error(errorMessage(e)); return false; }
    finally { setBusy(null); }
  }
  async function addType() {
    if (name.trim().length < 2) { setTypeError("Enter a name."); return; }
    setTypeError(null);
    if (await call("type", () => apiFetch<Setup>("/exams/types", { schoolId, method: "POST", body: { name } }))) setName("");
  }
  function saveGrades() {
    setGradeError(null);
    const bad = rows.find((r) => !/^[A-Za-z0-9+-]{1,4}$/.test(r.grade.trim()) || r.min === "" || !(Number(r.min) >= 0 && Number(r.min) <= 100));
    if (bad) { setGradeError("Each grade needs a short name (up to 4 letters, digits, + or -) and a minimum between 0 and 100."); return; }
    void call("grades", () => apiFetch<Setup>("/exams/grades", { schoolId, method: "PUT",
      body: { bands: rows.map((r) => ({ grade: r.grade.trim(), min_percentage: r.min, remark: r.remark.trim() || null })) } }), "Grading scale saved.");
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const sorted = rows.map((r, i) => ({ ...r, i })); // kept in place while typing; saved and reloaded highest first
  const upTo = (min: string) => {
    const higher = rows.map((x) => Number(x.min)).filter((m) => x0(m) > Number(min));
    return higher.length ? `< ${Math.min(...higher)}` : "100";
  };
  function x0(m: number) { return Number.isFinite(m) ? m : -1; }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-lg border border-line bg-white" data-testid="exam-types">
        <div className="flex items-center justify-between gap-3 border-b border-line p-4">
          <div><h2 className="font-semibold">Exam types</h2><p className="text-sm text-muted">Unit Test, Half Yearly, Annual and your own.</p></div>
          <Button size="sm" variant="secondary" onClick={() => call("std", () => apiFetch<Setup>("/exams/types/standard", { schoolId, method: "POST" }))}
            loading={busy === "std"} data-testid="standard-types"><Sparkles className="size-4" /> Add standard types</Button>
        </div>
        <div className="flex items-end gap-2 border-b border-line p-4">
          <TextField label="New exam type" className="flex-1" value={name} maxLength={60} placeholder="e.g. Pre-Board, Periodic Test" onChange={(e) => setName(e.target.value)} error={typeError} />
          <Button onClick={addType} loading={busy === "type"} data-testid="add-type" className={typeError ? "mb-5" : undefined}>Add</Button>
        </div>
        {d.types.length === 0 ? <p className="p-4 text-sm text-muted">No exam types yet.</p> : (
          <ul className="divide-y divide-line">
            {d.types.map((t) => (
              <li key={t.id} className="flex items-center justify-between px-4 py-2 text-sm" data-testid={`type-${t.name}`}>
                <span className={t.is_active ? "" : "text-muted line-through"}>{t.name} <span className="text-xs text-muted">· {t.exams} exam{t.exams === 1 ? "" : "s"}</span></span>
                <button className="text-xs font-medium text-leaf-700 hover:underline"
                  onClick={() => call(t.id, () => apiFetch<Setup>(`/exams/types/${t.id}`, { schoolId, method: "PATCH", body: { is_active: !t.is_active } }))}>
                  {t.is_active ? "Deactivate" : "Activate"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-line bg-white" data-testid="grade-scale">
        <div className="flex items-center justify-between gap-3 border-b border-line p-4">
          <div><h2 className="font-semibold">Grading scale</h2><p className="text-sm text-muted">A grade applies from its minimum percentage up to the next grade.</p></div>
          <Button size="sm" variant="secondary" onClick={() => call("grades-std", () => apiFetch<Setup>("/exams/grades/standard", { schoolId, method: "POST" }), "Standard scale applied.")}
            loading={busy === "grades-std"} data-testid="standard-grades"><Sparkles className="size-4" /> Use standard scale</Button>
        </div>
        <div className="p-4">
          {rows.length === 0 ? <p className="mb-3 text-sm text-muted">No grades yet. Results show percentages without grades until a scale is set.</p> : (
            <table className="mb-3 w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="pb-1">Grade</th><th className="pb-1">From %</th><th className="pb-1">To %</th><th className="pb-1">Remark</th><th /></tr></thead>
              <tbody>
                {sorted.map((r, k) => (
                  <tr key={r.i} data-testid={`band-${r.grade || k}`}>
                    <td className="py-1 pr-2"><input aria-label="Grade" value={r.grade} maxLength={4} onChange={(e) => setRows(rows.map((x, j) => j === r.i ? { ...x, grade: e.target.value } : x))}
                      className="h-9 w-16 rounded-md border border-line px-2 uppercase" /></td>
                    <td className="py-1 pr-2"><input aria-label={`Minimum % for ${r.grade || "grade"}`} inputMode="decimal" value={r.min} onChange={(e) => setRows(rows.map((x, j) => j === r.i ? { ...x, min: e.target.value } : x))}
                      className="tabular h-9 w-20 rounded-md border border-line px-2" /></td>
                    <td className="tabular py-1 pr-2 text-muted">{r.min === "" ? "—" : upTo(r.min)}</td>
                    <td className="py-1 pr-2"><input aria-label="Remark" value={r.remark} maxLength={60} onChange={(e) => setRows(rows.map((x, j) => j === r.i ? { ...x, remark: e.target.value } : x))}
                      className="h-9 w-full rounded-md border border-line px-2" /></td>
                    <td><button className="rounded p-1.5 text-muted hover:bg-danger-50 hover:text-danger-600" aria-label={`Remove grade ${r.grade}`} onClick={() => setRows(rows.filter((_, j) => j !== r.i))}><Trash2 className="size-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {gradeError && <p className="mb-2 text-sm text-danger-600" role="alert" data-testid="grade-error">{gradeError}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { grade: "", min: "", remark: "" }])}><Plus className="size-4" /> Add grade</Button>
            <Button size="sm" onClick={saveGrades} loading={busy === "grades"} data-testid="save-grades">Save scale</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
