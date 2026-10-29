"use client";

import { clsx } from "clsx";
import { BookCheck, ScanLine, Search, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import type { Borrower, BorrowerDetail, CopyLookup, Loan } from "@/lib/library";
import { formatINR } from "@/lib/money";
import { CopyPill, DueText, LoanActions, MoneyText } from "./shared";

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Search students (current session) and staff by name, Student ID, admission number or employee ID. */
export function BorrowerPicker({ schoolId, onPick, autoFocus }: { schoolId: string; onPick: (b: Borrower) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Borrower[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setItems(null); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      apiFetch<Borrower[]>("/library/borrowers", { schoolId, query: { q: term }, signal: ctl.signal })
        .then((x) => { setItems(x); setError(null); })
        .catch((e) => { if (!(e instanceof DOMException)) setError(errorMessage(e)); });
    }, 250);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q, schoolId]);
  return (
    <div>
      <label htmlFor="borrower-search" className="mb-1.5 block text-sm font-medium">Borrower</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input id="borrower-search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} autoComplete="off" data-testid="borrower-search"
          placeholder="Student or staff name, Student ID, admission no., employee ID"
          className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
      </div>
      {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
      {items && (
        items.length === 0 ? <p className="mt-2 text-sm text-muted">No current student or active staff member matches.</p> : (
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-md border border-line" data-testid="borrower-results">
            {items.map((b) => (
              <li key={`${b.kind}:${b.id}`}>
                <button type="button" onClick={() => onPick(b)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-paper" data-testid="borrower-option">
                  <UserRound className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{b.name}</span> <span className="text-muted">· {b.kind === "student" ? "Student" : "Staff"} {b.code}</span>
                    <span className="block text-xs text-muted">{b.detail}</span>
                  </span>
                  <span className="text-right text-xs text-muted">
                    {b.open_loans} out{b.overdue ? <span className="text-danger-600"> · {b.overdue} overdue</span> : null}
                    {Number(b.fines_due) > 0 && <span className="block text-danger-600">{formatINR(b.fines_due)} owed</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/** Issue one copy to a chosen borrower, with the due date (default from the rules). */
export function IssueForm({ schoolId, copy, borrower, onIssued, onChangeBorrower }: {
  schoolId: string; copy: { id: string; accession_number: string; title: string }; borrower: Borrower;
  onIssued: (l: Loan) => void; onChangeBorrower?: () => void;
}) {
  const [detail, setDetail] = useState<BorrowerDetail | null>(null);
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDetail(null); setError(null);
    apiFetch<BorrowerDetail>(`/library/borrowers/${borrower.kind}/${borrower.id}`, { schoolId })
      .then((d) => { setDetail(d); setDue(addDays(todayISO(), d.loan_days)); }).catch((e) => setError(errorMessage(e)));
  }, [borrower, schoolId]);
  async function issue() {
    setBusy(true); setError(null);
    try {
      onIssued(await apiFetch<Loan>("/library/loans", { schoolId, method: "POST", body: {
        copy_id: copy.id, [borrower.kind === "student" ? "student_id" : "teacher_id"]: borrower.id, due_date: due || null } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3 rounded-md border border-line p-4" data-testid="issue-form">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium" data-testid="issue-borrower">{borrower.name}</p>
          <p className="text-xs text-muted">{borrower.kind === "student" ? "Student" : "Staff"} {borrower.code} · {borrower.detail}</p>
          {detail && <p className="mt-1 text-xs text-muted">{detail.open_loans} of {detail.max_books} books out{Number(detail.fines_due) > 0 ? ` · ${formatINR(detail.fines_due)} owed` : ""}</p>}
        </div>
        {onChangeBorrower && <Button size="sm" variant="ghost" onClick={onChangeBorrower} aria-label="Choose another borrower"><X className="size-4" /></Button>}
      </div>
      {detail && detail.blocked.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-md bg-danger-50 py-2 pl-7 pr-3 text-sm text-danger-600" data-testid="issue-blocked">
          {detail.blocked.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      <TextField label="Due date" type="date" value={due} min={todayISO()} onChange={(e) => setDue(e.target.value)} data-testid="issue-due" className="max-w-xs" />
      {error && <p className="text-sm text-danger-600" role="alert" data-testid="issue-error">{error}</p>}
      <Button onClick={issue} loading={busy} disabled={!detail} data-testid="issue-book"><BookCheck className="size-4" /> Issue {copy.accession_number}</Button>
    </div>
  );
}

/** The circulation desk: scan or type an accession number, then issue, return or renew. */
export function Desk({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [acc, setAcc] = useState("");
  const [copy, setCopy] = useState<CopyLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [borrower, setBorrower] = useState<Borrower | null>(null);
  const [done, setDone] = useState<Loan | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function find(e?: FormEvent, value = acc) {
    e?.preventDefault();
    const a = value.trim();
    if (!a) return;
    setBusy(true); setError(null); setCopy(null); setBorrower(null); setDone(null);
    try { setCopy(await apiFetch<CopyLookup>("/library/copies/lookup", { schoolId, query: { accession: a } })); }
    catch (err) { setError(err instanceof ApiError && err.status === 404 ? err.message : errorMessage(err)); }
    finally { setBusy(false); }
  }
  function reset() { setAcc(""); setCopy(null); setBorrower(null); setError(null); window.setTimeout(() => input.current?.focus(), 0); }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section className="space-y-4 rounded-lg border border-line bg-white p-5" data-testid="desk">
        <form onSubmit={find} className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor="desk-accession" className="mb-1.5 block text-sm font-medium">Accession number</label>
            <div className="relative">
              <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input id="desk-accession" ref={input} value={acc} onChange={(e) => setAcc(e.target.value)} autoFocus autoComplete="off" data-testid="desk-accession"
                placeholder="Scan the barcode or type, e.g. ACC-000123"
                className="h-10 w-full rounded-md border border-line pl-9 pr-3 font-mono text-sm uppercase focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
            </div>
          </div>
          <Button type="submit" loading={busy} data-testid="desk-find">Find</Button>
        </form>
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="desk-error">{error}</p>}

        {done && (
          <div className="rounded-md bg-leaf-50 p-4 text-sm" data-testid="desk-done" aria-live="polite">
            {done.is_open
              ? <p><b>{done.accession_number}</b> “{done.title}” issued to <b>{done.borrower_name}</b>. Due <b>{formatDate(done.due_date)}</b>.</p>
              : <p><b>{done.accession_number}</b> “{done.title}” returned by <b>{done.borrower_name}</b>. <MoneyText l={done} /></p>}
            {!done.is_open && done.fine_status === "unpaid" && <div className="mt-2"><LoanActions schoolId={schoolId} loan={done} onChange={setDone} /></div>}
          </div>
        )}

        {copy && (
          <div className="space-y-4" data-testid="desk-copy">
            <div className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-4">
              <div className="min-w-0">
                <p className="font-mono text-xs text-muted">{copy.accession_number}</p>
                <Link href={`/library/books/${copy.book_id}`} className="text-lg font-semibold hover:underline" data-testid="desk-title">{copy.title}</Link>
                {copy.authors && <p className="text-sm text-muted">{copy.authors}</p>}
              </div>
              <CopyPill status={copy.status} />
            </div>

            {copy.status === "available" && copy.book_active && (
              borrower
                ? <IssueForm schoolId={schoolId} copy={copy} borrower={borrower} onChangeBorrower={() => setBorrower(null)}
                    onIssued={(l) => { setDone(l); toast.success(`Issued to ${l.borrower_name}.`); reset(); }} />
                : <BorrowerPicker schoolId={schoolId} onPick={setBorrower} autoFocus />
            )}
            {copy.status === "available" && !copy.book_active && <p className="text-sm text-muted">This title is withdrawn from the catalogue.</p>}

            {copy.loan && (
              <div className={clsx("space-y-3 rounded-md border p-4 text-sm", copy.loan.is_overdue ? "border-danger-600/40 bg-danger-50/40" : "border-line")} data-testid="desk-loan">
                <p>With <Link href={`/library/borrowers/${copy.loan.borrower_kind}/${copy.loan.student_id ?? copy.loan.teacher_id}`} className="font-medium hover:underline">{copy.loan.borrower_name}</Link>
                  {copy.loan.borrower_class ? ` (${copy.loan.borrower_class})` : ""} since {formatDate(copy.loan.issued_on)}{copy.loan.renewals ? ` · renewed ${copy.loan.renewals}×` : ""}</p>
                <p><DueText l={copy.loan} /> {Number(copy.loan.amount_due) > 0 && <> · <MoneyText l={copy.loan} /></>}</p>
                <LoanActions schoolId={schoolId} loan={copy.loan} size="md" onChange={(l) => {
                  if (l.is_open) { setCopy({ ...copy, loan: l }); return; }
                  setDone(l); reset();
                }} />
              </div>
            )}
            {["lost", "damaged", "withdrawn"].includes(copy.status) && (
              <p className="text-sm text-muted">This copy is {copy.status}. Change that on the <Link href={`/library/books/${copy.book_id}`} className="text-leaf-700 hover:underline">book&apos;s page</Link>.</p>
            )}
          </div>
        )}
      </section>
      <aside className="space-y-2 rounded-lg bg-paper p-5 text-sm">
        <p className="font-medium">At the desk</p>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>Scan or type the copy&apos;s accession number.</li>
          <li>On the shelf: choose the borrower and issue it. The due date follows the library rules.</li>
          <li>On loan: return it (fines are worked out automatically) or renew it.</li>
        </ol>
        <p className="pt-2 text-xs text-muted">Limits, overdue books and unpaid fines are checked by the system before a book is issued.</p>
      </aside>
    </div>
  );
}
