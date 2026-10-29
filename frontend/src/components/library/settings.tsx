"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Category, LibrarySettings } from "@/lib/library";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

type Form = Record<"loan_days_student" | "loan_days_staff" | "max_books_student" | "max_books_staff" | "fine_per_day" | "grace_days" | "max_fine" | "max_renewals", string>
  & { block_when_overdue: boolean; block_when_fines_due: boolean };

function RulesCard({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const admin = can("settings:manage");
  const [s, setS] = useState<LibrarySettings | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  function apply(x: LibrarySettings) {
    setS(x);
    setF({ loan_days_student: String(x.loan_days_student), loan_days_staff: String(x.loan_days_staff), max_books_student: String(x.max_books_student),
      max_books_staff: String(x.max_books_staff), fine_per_day: x.fine_per_day, grace_days: String(x.grace_days), max_fine: x.max_fine ?? "",
      max_renewals: String(x.max_renewals), block_when_overdue: x.block_when_overdue, block_when_fines_due: x.block_when_fines_due });
  }
  useEffect(() => { apiFetch<LibrarySettings>("/library/settings", { schoolId }).then(apply).catch((e) => setLoadError(errorMessage(e))); }, [schoolId]);
  if (loadError) return <ErrorState message={loadError} />;
  if (!s || !f) return <LoadingState />;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const form = f;
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const f = form;
    const ints: [keyof Form, string, number, number][] = [["loan_days_student", "Loan period for students", 1, 180], ["loan_days_staff", "Loan period for staff", 1, 365],
      ["max_books_student", "Books per student", 1, 20], ["max_books_staff", "Books per staff member", 1, 50], ["grace_days", "Grace days", 0, 30], ["max_renewals", "Renewals", 0, 5]];
    for (const [k, label, lo, hi] of ints) {
      const v = Number(f[k]);
      if (!/^\d+$/.test(String(f[k])) || v < lo || v > hi) return setError(`${label}: a whole number from ${lo} to ${hi}.`);
    }
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(f.fine_per_day.trim()) || Number(f.fine_per_day) > 1000) return setError("Fine per day: an amount from 0 to 1000, e.g. 2 or 2.50.");
    if (f.max_fine.trim() && (!/^\d{1,6}(\.\d{1,2})?$/.test(f.max_fine.trim()) || Number(f.max_fine) <= 0)) return setError("Maximum fine: an amount above 0, or leave it empty for no limit.");
    setBusy(true);
    try {
      apply(await apiFetch<LibrarySettings>("/library/settings", { schoolId, method: "PUT", body: {
        ...Object.fromEntries(ints.map(([k]) => [k, Number(f[k])])), fine_per_day: f.fine_per_day.trim(), max_fine: f.max_fine.trim() || null,
        block_when_overdue: f.block_when_overdue, block_when_fines_due: f.block_when_fines_due } }));
      toast.success("Library rules saved.");
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <section className="rounded-lg border border-line bg-white" data-testid="library-rules">
      <div className="border-b border-line px-5 py-4">
        <h2 className="font-semibold">Borrowing rules and fines</h2>
        <p className="mt-0.5 text-sm text-muted">{admin ? "Apply to books issued from now on; each loan keeps the fine rate it was issued with." : "Set by the school admin."}</p>
      </div>
      <form onSubmit={save} className="space-y-5 p-5" noValidate>
        <fieldset disabled={!admin} className="grid gap-4 sm:grid-cols-2">
          <TextField label="Loan period, students (days)" inputMode="numeric" value={f.loan_days_student} onChange={set("loan_days_student")} data-testid="rule-loan-days-student" />
          <TextField label="Loan period, staff (days)" inputMode="numeric" value={f.loan_days_staff} onChange={set("loan_days_staff")} />
          <TextField label="Books at a time, students" inputMode="numeric" value={f.max_books_student} onChange={set("max_books_student")} data-testid="rule-max-student" />
          <TextField label="Books at a time, staff" inputMode="numeric" value={f.max_books_staff} onChange={set("max_books_staff")} />
          <TextField label="Fine per day late (₹)" inputMode="decimal" value={f.fine_per_day} onChange={set("fine_per_day")} data-testid="rule-fine"
            hint={Number(f.fine_per_day) === 0 ? "0 = no fines" : undefined} />
          <TextField label="Grace days (no fine)" inputMode="numeric" value={f.grace_days} onChange={set("grace_days")} data-testid="rule-grace" />
          <TextField label="Maximum fine per book (₹)" inputMode="decimal" value={f.max_fine} onChange={set("max_fine")} placeholder="No limit" data-testid="rule-max-fine" />
          <TextField label="Renewals allowed" inputMode="numeric" value={f.max_renewals} onChange={set("max_renewals")} />
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={f.block_when_overdue} onChange={(e) => setF({ ...f, block_when_overdue: e.target.checked })} />
            Don&apos;t issue more books to someone with an overdue book
          </label>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={f.block_when_fines_due} onChange={(e) => setF({ ...f, block_when_fines_due: e.target.checked })} />
            Don&apos;t issue more books to someone with an unpaid fine
          </label>
        </fieldset>
        <p className="rounded-md bg-paper px-3 py-2 text-xs text-muted" data-testid="rules-summary">
          {Number(s.fine_per_day) > 0
            ? `Now: ${formatINR(s.fine_per_day)} for each day late after ${s.grace_days} grace day${s.grace_days === 1 ? "" : "s"}${s.max_fine ? `, at most ${formatINR(s.max_fine)} a book` : ""}. A lost book is charged its recorded price (or the amount entered at return).`
            : "Now: no fines for late returns. A lost book is charged its recorded price (or the amount entered at return)."}
        </p>
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="rules-error">{error}</p>}
        {admin && <Button type="submit" loading={busy} data-testid="save-rules">Save rules</Button>}
        {s.updated_at && <p className="text-xs text-muted">Last changed {formatDateTime(s.updated_at)}</p>}
      </form>
    </section>
  );
}

function CategoriesCard({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [cats, setCats] = useState<Category[] | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => apiFetch<Category[]>("/library/categories", { schoolId }).then(setCats).catch((e) => setError(errorMessage(e))), [schoolId]);
  useEffect(() => { void load(); }, [load]);
  async function add(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (name.trim().length < 2) return setError("Enter a category name.");
    try { await apiFetch("/library/categories", { schoolId, method: "POST", body: { name: name.trim() } }); setName(""); await load(); }
    catch (err) { setError(errorMessage(err)); }
  }
  async function rename() {
    if (!editing) return;
    try { await apiFetch(`/library/categories/${editing.id}`, { schoolId, method: "PATCH", body: { name: editing.name.trim() } }); setEditing(null); await load(); }
    catch (err) { setError(errorMessage(err)); }
  }
  async function remove(c: Category) {
    try { await apiFetch(`/library/categories/${c.id}`, { schoolId, method: "DELETE" }); toast.success(`“${c.name}” deleted.`); await load(); }
    catch (err) { toast.error(errorMessage(err)); }
  }
  return (
    <section className="rounded-lg border border-line bg-white" data-testid="library-categories">
      <div className="border-b border-line px-5 py-4"><h2 className="font-semibold">Categories</h2></div>
      <div className="space-y-3 p-5">
        <form onSubmit={add} className="flex items-end gap-2">
          <TextField className="flex-1" label="New category" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fiction, Reference, Science" data-testid="category-name" />
          <Button type="submit" data-testid="add-category">Add</Button>
        </form>
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
        {!cats ? <LoadingState /> : cats.length === 0 ? <p className="text-sm text-muted">No categories yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {cats.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                {editing?.id === c.id
                  ? <><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Category name"
                      className="h-8 flex-1 rounded-md border border-line px-2 text-sm" /><Button size="sm" onClick={rename}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></>
                  : <><span className="flex-1">{c.name} <span className="text-muted">· {c.books} book{c.books === 1 ? "" : "s"}</span></span>
                      <Button size="sm" variant="ghost" aria-label={`Rename ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name })}><Pencil className="size-4" /></Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}><Trash2 className="size-4" /></Button></>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function LibrarySettingsTab({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  return (
    <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
      <RulesCard schoolId={schoolId} />
      {can("library:manage") && <CategoriesCard schoolId={schoolId} />}
    </div>
  );
}
