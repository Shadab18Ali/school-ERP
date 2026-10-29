"use client";

import { clsx } from "clsx";
import { ArrowDownLeft, ArrowUpRight, Download, History, PencilLine, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CATEGORIES, CATEGORY_LABEL, CONDITION_LABEL, IN_REASONS, OUT_REASONS, qty, REASON_LABEL, type Category, type Condition, type Movement, type MovementList } from "@/lib/inventory";
import { formatINR } from "@/lib/money";

const FIELD_LABEL: Record<string, string> = { location: "Location", condition: "Condition", assigned_to: "Assigned to", name: "Name", archived: "Archived" };

function changeText(field: string, v: string | boolean | null): string {
  if (v === null || v === "") return field === "assigned_to" ? "nobody" : "—";
  if (field === "condition") return CONDITION_LABEL[v as Condition] ?? String(v);
  if (field === "archived") return v ? "yes" : "no";
  return String(v);
}

/** One line of history: stock in, stock out, or a change of details. */
export function MovementRow({ m, showItem = true }: { m: Movement; showItem?: boolean }) {
  const icon = m.kind === "in" ? <ArrowDownLeft className="size-4 text-leaf-700" aria-hidden /> : m.kind === "out" ? <ArrowUpRight className="size-4 text-danger-600" aria-hidden /> : <PencilLine className="size-4 text-muted" aria-hidden />;
  const to = m.teacher_name ?? m.recipient;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`movement-${m.kind}`}>
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-paper">{icon}</span>
      <div className="min-w-0 flex-1 basis-56">
        {showItem && <p className="font-medium"><Link href={`/inventory/items/${m.item_id}`} className="hover:underline">{m.item_name}</Link> <span className="text-xs font-normal text-muted">{m.item_code}</span></p>}
        {m.kind === "change" ? (
          <p className={clsx(!showItem && "font-medium")}>
            {Object.entries(m.changes ?? {}).map(([f, c], i) => (
              <span key={f}>{i > 0 && "; "}{FIELD_LABEL[f] ?? f}: {changeText(f, c.from)} → <b className="font-medium">{changeText(f, c.to)}</b></span>
            ))}
          </p>
        ) : (
          <p className={clsx(!showItem && "font-medium")}>
            {REASON_LABEL[m.reason] ?? m.reason}
            {to && <span className="text-muted"> · {m.kind === "out" ? "to" : "from"} {to}</span>}
            {m.vendor && <span className="text-muted"> · {m.vendor}</span>}
            {m.reference && <span className="text-muted"> · {m.reference}</span>}
          </p>
        )}
        <p className="text-xs text-muted">{formatDate(m.moved_on)}{m.recorded_by ? ` · recorded by ${m.recorded_by}` : ""}{m.note ? ` · ${m.note}` : ""}</p>
      </div>
      {m.kind !== "change" && (
        <div className="ml-auto text-right">
          <p className={clsx("tabular font-medium", m.kind === "in" ? "text-leaf-700" : "text-danger-600")} data-testid="movement-qty">{m.kind === "in" ? "+" : "−"}{qty(m.quantity, m.unit)}</p>
          <p className="text-xs text-muted">{m.total_cost ? `${formatINR(m.total_cost)} · ` : ""}balance {qty(m.balance_after)}</p>
        </div>
      )}
    </li>
  );
}

const PAGE_SIZE = 50;

/** Stock in / out across all items, with filters and CSV. */
export function HistoryTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [kind, setKind] = useState<"" | "in" | "out">("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MovementList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const query = { kind: kind || undefined, reason: reason || undefined, category: category || undefined, from: from || undefined, to: to || undefined, q: term || undefined };
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<MovementList>("/inventory/movements", { schoolId, query: { kind: kind || undefined, reason: reason || undefined, category: category || undefined, from: from || undefined, to: to || undefined, q: term || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, kind, reason, category, from, to, term, page]);
  useEffect(() => { void load(); }, [load]);
  async function csv() {
    setDownloading(true);
    try { const { blob } = await apiFetchBlob("/inventory/movements", { schoolId, query: { ...query, format: "csv" } }); saveBlob(blob, "inventory-stock-history.csv"); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDownloading(false); }
  }
  const reasons = kind === "in" ? IN_REASONS : kind === "out" ? OUT_REASONS : [];
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-6">
        <SelectField label="In / out" value={kind} onChange={(e) => { setKind(e.target.value as "" | "in" | "out"); setReason(""); setPage(1); }} data-testid="history-kind">
          <option value="">Both</option><option value="in">Stock in</option><option value="out">Stock out</option>
        </SelectField>
        <SelectField label="Reason" value={reason} disabled={!kind} onChange={(e) => { setReason(e.target.value); setPage(1); }} data-testid="history-reason">
          <option value="">Any</option>
          {reasons.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>
        <SelectField label="Category" value={category} onChange={(e) => { setCategory(e.target.value as Category | ""); setPage(1); }}>
          <option value="">All</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </SelectField>
        <TextField label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <TextField label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="history-search" className="sr-only">Search the history</label>
            <input id="history-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item, bill no., vendor, person" data-testid="history-search"
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <Button variant="secondary" onClick={csv} loading={downloading} aria-label="Download CSV"><Download className="size-4" /></Button>
        </div>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={History} title="No stock movements" message="Stock in and out appears here as it is recorded." /></div>
        : (
          <>
            <ul className="divide-y divide-line" data-testid="history-list">{data.items.map((m) => <MovementRow key={m.id} m={m} />)}</ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </>
        )}
    </section>
  );
}
