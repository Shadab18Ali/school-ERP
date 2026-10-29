"use client";

import { Library } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Loan, StudentLibrary } from "@/lib/library";
import { formatINR } from "@/lib/money";
import { DueText, MoneyText } from "./shared";

function Row({ l }: { l: Loan }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" data-testid="student-loan">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{l.title}</p>
        <p className="text-xs text-muted">Borrowed {formatDate(l.issued_on)} · <DueText l={l} />{l.renewals ? ` · renewed ${l.renewals}×` : ""}</p>
      </div>
      <MoneyText l={l} />
    </li>
  );
}

/** A student's library books, for the parent and student portals (read only). */
export function StudentLibraryTab({ base, schoolId }: { base: string; schoolId: string }) {
  const [d, setD] = useState<StudentLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<StudentLibrary>(`${base}/library`, { schoolId }).then(setD).catch((e) => setError(errorMessage(e))); }, [base, schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!d) return <LoadingState />;
  const r = d.rules;
  return (
    <div className="space-y-6" data-testid="student-library">
      {Number(d.amount_due) > 0 && (
        <p className="rounded-lg bg-danger-50 px-4 py-3 text-sm text-danger-600" data-testid="library-owed">
          Library fines and charges: <b>{formatINR(d.amount_due)}</b>. Please pay at the school library.
        </p>
      )}
      <section className="rounded-lg border border-line bg-white">
        <div className="border-b border-line px-5 py-3"><h2 className="font-semibold">Books borrowed now</h2></div>
        {d.current.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No library books at the moment.</p>
          : <ul className="divide-y divide-line" data-testid="library-current">{d.current.map((l) => <Row key={l.id} l={l} />)}</ul>}
      </section>
      <section className="rounded-lg border border-line bg-white">
        <div className="border-b border-line px-5 py-3"><h2 className="font-semibold">History</h2></div>
        {d.history.length === 0 ? <div className="p-4"><EmptyState icon={Library} title="Nothing returned yet" message="Books borrowed from the school library will be listed here." /></div>
          : <ul className="divide-y divide-line" data-testid="library-history">{d.history.map((l) => <Row key={l.id} l={l} />)}</ul>}
      </section>
      <p className="text-xs text-muted">
        Up to {r.max_books_student} book{r.max_books_student === 1 ? "" : "s"} at a time, for {r.loan_days_student} days.
        {Number(r.fine_per_day) > 0 ? ` Late returns: ${formatINR(r.fine_per_day)} a day${r.grace_days ? ` after ${r.grace_days} grace day${r.grace_days === 1 ? "" : "s"}` : ""}${r.max_fine ? `, at most ${formatINR(r.max_fine)} a book` : ""}.` : ""}
      </p>
    </div>
  );
}
