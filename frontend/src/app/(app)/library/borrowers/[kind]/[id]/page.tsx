"use client";

import { ArrowLeft, BookPlus } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState, type FormEvent } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { IssueForm } from "@/components/library/desk";
import { LoanRow } from "@/components/library/loans";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { BorrowerDetail, CopyLookup } from "@/lib/library";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

function IssueToBorrower({ schoolId, b, onIssued }: { schoolId: string; b: BorrowerDetail; onIssued: () => void }) {
  const toast = useToast();
  const [acc, setAcc] = useState("");
  const [copy, setCopy] = useState<CopyLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function find(e: FormEvent) {
    e.preventDefault(); setError(null); setCopy(null);
    if (!acc.trim()) return;
    try {
      const c = await apiFetch<CopyLookup>("/library/copies/lookup", { schoolId, query: { accession: acc.trim() } });
      if (c.status !== "available") return setError(`${c.accession_number} “${c.title}” is ${c.status}${c.loan ? ` (with ${c.loan.borrower_name})` : ""}.`);
      setCopy(c);
    } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <section className="space-y-3 rounded-lg border border-line bg-white p-5" data-testid="issue-to-borrower">
      <h2 className="flex items-center gap-2 font-semibold"><BookPlus className="size-4" /> Issue a book</h2>
      <form onSubmit={find} className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="b-acc" className="mb-1.5 block text-sm font-medium">Accession number</label>
          <input id="b-acc" value={acc} onChange={(e) => setAcc(e.target.value)} autoComplete="off" data-testid="borrower-accession"
            className="h-10 w-full rounded-md border border-line px-3 font-mono text-sm uppercase focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <Button type="submit" variant="secondary">Find</Button>
      </form>
      {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
      {copy && (
        <>
          <p className="text-sm"><span className="font-mono text-xs text-muted">{copy.accession_number}</span> <b>{copy.title}</b>{copy.authors ? ` · ${copy.authors}` : ""}</p>
          <IssueForm schoolId={schoolId} copy={copy} borrower={b} onIssued={(l) => { toast.success(`Issued “${l.title}”.`); setAcc(""); setCopy(null); onIssued(); }} />
        </>
      )}
    </section>
  );
}

function BorrowerPage({ kind, id }: { kind: string; id: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [b, setB] = useState<BorrowerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setB(await apiFetch<BorrowerDetail>(`/library/borrowers/${kind}/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [kind, id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} />;
  if (!b) return <LoadingState />;
  const current = b.history.filter((l) => l.is_open);
  const past = b.history.filter((l) => !l.is_open);
  return (
    <>
      <Link href="/library?tab=Borrowers" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Borrowers</Link>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="borrower-heading">{b.name}</h1>
        <p className="text-sm text-muted">{b.kind === "student" ? "Student" : "Staff"} {b.code}{b.detail ? ` · ${b.detail}` : ""}</p>
        <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm" data-testid="borrower-summary">
          <span><b>{b.open_loans}</b> of {b.max_books} books out</span>
          {b.overdue > 0 && <span className="text-danger-600"><b>{b.overdue}</b> overdue</span>}
          <span className={Number(b.fines_due) > 0 ? "text-danger-600" : ""}>Owes <b>{formatINR(b.fines_due)}</b></span>
          <span className="text-muted">{b.history.length} loan{b.history.length === 1 ? "" : "s"} in all</span>
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <section className="rounded-lg border border-line bg-white">
            <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">Has now</h2></div>
            {current.length === 0 ? <p className="p-4 text-sm text-muted">No books out.</p>
              : <ul className="divide-y divide-line" data-testid="borrower-current">{current.map((l) => <LoanRow key={l.id} schoolId={schoolId} loan={l} onChange={() => void load()} showBorrower={false} />)}</ul>}
          </section>
          <section className="rounded-lg border border-line bg-white">
            <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">History</h2></div>
            {past.length === 0 ? <p className="p-4 text-sm text-muted">Nothing returned yet.</p>
              : <ul className="divide-y divide-line" data-testid="borrower-history">{past.map((l) => <LoanRow key={l.id} schoolId={schoolId} loan={l} onChange={() => void load()} showBorrower={false} />)}</ul>}
          </section>
        </div>
        <div className="space-y-4">
          {b.blocked.length > 0 && (
            <div className="rounded-lg bg-danger-50 p-4 text-sm text-danger-600" data-testid="borrower-blocked">
              <p className="font-medium">Can&apos;t borrow right now</p>
              <ul className="mt-1 list-disc pl-5">{b.blocked.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
          <IssueToBorrower schoolId={schoolId} b={b} onIssued={() => void load()} />
        </div>
      </div>
    </>
  );
}

export default function LibraryBorrowerPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = use(params);
  return <RequirePermission permission="library:manage"><BorrowerPage kind={kind} id={id} /></RequirePermission>;
}
