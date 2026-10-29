"use client";

import { clsx } from "clsx";
import { Download, Search, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { LOAN_STATE_LABEL, type Borrower, type Loan, type LoanList, type LoanState } from "@/lib/library";
import { useAuth } from "@/providers/auth-provider";
import { BorrowerPicker } from "./desk";
import { DueText, LoanActions, MoneyText } from "./shared";

const PAGE_SIZE = 25;
const STATES: LoanState[] = ["open", "overdue", "fines_unpaid", "returned", "fines_settled", "all"];

/** One loan as a list row: book, borrower, dates, money, actions. */
export function LoanRow({ schoolId, loan, onChange, showBorrower = true }: { schoolId: string; loan: Loan; onChange: (l: Loan) => void; showBorrower?: boolean }) {
  const { can } = useAuth();
  const borrowerHref = `/library/borrowers/${loan.borrower_kind}/${loan.student_id ?? loan.teacher_id}`;
  return (
    <li className={clsx("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm", loan.is_overdue && "bg-danger-50/40")} data-testid="loan-row">
      <div className="min-w-0 flex-1">
        <p><Link href={`/library/books/${loan.book_id}`} className="font-medium hover:underline">{loan.title}</Link> <span className="font-mono text-xs text-muted">{loan.accession_number}</span></p>
        {showBorrower && (
          <p className="text-xs text-muted">
            {can("library:manage") ? <Link href={borrowerHref} className="hover:underline">{loan.borrower_name}</Link> : loan.borrower_name}
            {loan.borrower_class ? ` · ${loan.borrower_class}` : loan.borrower_kind === "staff" ? " · Staff" : ""}{loan.borrower_code ? ` · ${loan.borrower_code}` : ""}
          </p>
        )}
        <p className="text-xs text-muted">Issued {formatDate(loan.issued_on)} · <DueText l={loan} />{loan.renewals ? ` · renewed ${loan.renewals}×` : ""}</p>
        {loan.fine_waive_reason && <p className="text-xs text-muted">Waived: {loan.fine_waive_reason}</p>}
      </div>
      <div className="text-right"><MoneyText l={loan} /></div>
      <LoanActions schoolId={schoolId} loan={loan} onChange={onChange} />
    </li>
  );
}

export function LoansTab({ schoolId, initialState = "open" }: { schoolId: string; initialState?: LoanState }) {
  const toast = useToast();
  const [state, setState] = useState<LoanState>(initialState);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LoanList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<LoanList>("/library/loans", { schoolId, query: { state, q: term || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, state, term, page]);
  useEffect(() => { void load(); }, [load]);

  async function csv() {
    setDownloading(true);
    try { const { blob } = await apiFetchBlob("/library/loans", { schoolId, query: { state, q: term || undefined, format: "csv" } }); saveBlob(blob, `library-${state}.csv`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDownloading(false); }
  }

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Loans">
          {STATES.map((s) => (
            <button key={s} role="tab" aria-selected={state === s} onClick={() => { setState(s); setPage(1); }} data-testid={`loans-tab-${s}`}
              className={clsx("rounded-full border px-3 py-1 text-sm", state === s ? "border-leaf-600 bg-leaf-50 font-medium text-leaf-700" : "border-line text-muted hover:text-ink")}>
              {LOAN_STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="loan-search" className="sr-only">Search loans</label>
          <input id="loan-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Borrower, book, accession or receipt no." data-testid="loan-search"
            className="h-9 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <Button variant="secondary" size="sm" onClick={csv} loading={downloading} aria-label="Download CSV"><Download className="size-4" /> CSV</Button>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={UserRound} title="Nothing here" message={term ? "No loans match the search." : `No ${LOAN_STATE_LABEL[state].toLowerCase()} loans.`} /></div>
        : (
          <>
            <ul className="divide-y divide-line" data-testid="loan-list">
              {data.items.map((l) => (
                <LoanRow key={l.id} schoolId={schoolId} loan={l} onChange={() => void load()} />
              ))}
            </ul>
            <div className="border-t border-line px-4 py-3"><Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} /></div>
          </>
        )}
    </section>
  );
}

export function BorrowersTab({ schoolId }: { schoolId: string }) {
  const router = useRouter();
  return (
    <section className="rounded-lg border border-line bg-white p-5">
      <BorrowerPicker schoolId={schoolId} onPick={(b: Borrower) => router.push(`/library/borrowers/${b.kind}/${b.id}`)} autoFocus />
      <p className="mt-3 text-xs text-muted">Students of the current session and active staff. Open one to see their books, history and fines, or to issue a book.</p>
    </section>
  );
}

export function MyBooks({ schoolId }: { schoolId: string }) {
  const [data, setData] = useState<(LoanList & { has_record: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<LoanList & { has_record: boolean }>("/library/my-loans", { schoolId }).then(setData).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState />;
  const current = data.items.filter((l) => l.is_open);
  return (
    <section className="rounded-lg border border-line bg-white" data-testid="my-books">
      <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">My library books</h2></div>
      {!data.has_record ? <p className="p-4 text-sm text-muted">Your login isn&apos;t linked to a staff record, so you have no library loans.</p>
        : data.items.length === 0 ? <p className="p-4 text-sm text-muted">You haven&apos;t borrowed any books.</p>
        : (
          <ul className="divide-y divide-line">
            {[...current, ...data.items.filter((l) => !l.is_open)].map((l) => <LoanRow key={l.id} schoolId={schoolId} loan={l} onChange={() => {}} showBorrower={false} />)}
          </ul>
        )}
    </section>
  );
}
