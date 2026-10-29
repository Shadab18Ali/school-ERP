"use client";

import { clsx } from "clsx";
import { Download, Package, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CATEGORIES, CATEGORY_LABEL, CONDITION_LABEL, CONDITIONS, qty, type Category, type Condition, type ItemList, type ItemState } from "@/lib/inventory";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";
import { ConditionPill, ItemFormModal, StockFlags } from "./shared";

const PAGE_SIZE = 50;
const STATES: [ItemState, string][] = [["active", "In use"], ["low", "Low stock"], ["attention", "Needs attention"], ["assigned", "Assigned"], ["archived", "Archived"], ["all", "All"]];

export function ItemsTab({ schoolId, initialState = "active", initialCategory = "" }: { schoolId: string; initialState?: ItemState; initialCategory?: Category | "" }) {
  const { can } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<ItemState>(initialState);
  const [category, setCategory] = useState<Category | "">(initialCategory);
  const [condition, setCondition] = useState<Condition | "">("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ItemList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<ItemList>("/inventory/items", { schoolId, query: { state, category: category || undefined, condition: condition || undefined, q: term || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, state, category, condition, term, page]);
  useEffect(() => { void load(); }, [load]);
  async function csv() {
    setDownloading(true);
    try { const { blob } = await apiFetchBlob("/inventory/items", { schoolId, query: { state, category: category || undefined, condition: condition || undefined, q: term || undefined, format: "csv" } }); saveBlob(blob, `inventory-${state}.csv`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDownloading(false); }
  }
  const manage = can("inventory:manage");
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which items">
          {STATES.map(([s, label]) => (
            <button key={s} role="tab" aria-selected={state === s} onClick={() => { setState(s); setPage(1); }} data-testid={`items-${s}`}
              className={clsx("rounded-full border px-3 py-1 text-sm", state === s ? "border-leaf-600 bg-leaf-50 font-medium text-leaf-700" : "border-line text-muted hover:text-ink")}>{label}</button>
          ))}
        </div>
        {manage && <Button size="sm" className="ml-auto" onClick={() => setAdding(true)} data-testid="add-item"><Plus className="size-4" /> Add item</Button>}
      </div>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_1fr_2fr_auto]">
        <SelectField label="Category" hideLabel value={category} onChange={(e) => { setCategory(e.target.value as Category | ""); setPage(1); }} data-testid="items-category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </SelectField>
        <SelectField label="Condition" hideLabel value={condition} onChange={(e) => { setCondition(e.target.value as Condition | ""); setPage(1); }}>
          <option value="">Any condition</option>
          {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
        </SelectField>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="item-search" className="sr-only">Search items</label>
          <input id="item-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code (INV-00001), brand or serial no." data-testid="items-search"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <Button variant="secondary" onClick={csv} loading={downloading} aria-label="Download CSV"><Download className="size-4" /> CSV</Button>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? (
          <div className="p-4"><EmptyState icon={Package} title="No items here" message={term || category || condition ? "No item matches the filters." : state === "active" ? (manage ? "Add the school's computers, furniture, lab equipment, sports gear and stationery." : "No items have been added.") : "Nothing in this list."} /></div>
        ) : (
          <>
            <ul className="divide-y divide-line" data-testid="item-list">
              {data.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`item-${i.name}`}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p><Link href={`/inventory/items/${i.id}`} className="font-medium hover:underline">{i.name}</Link> <span className="text-xs text-muted">{i.item_code} · {CATEGORY_LABEL[i.category]}</span></p>
                    <p className="text-xs text-muted">
                      {i.location}{i.assigned_to ? ` · with ${i.assigned_to}` : ""}{i.brand_model ? ` · ${i.brand_model}` : ""}
                      {i.purchase_date ? ` · bought ${formatDate(i.purchase_date)}` : ""}
                    </p>
                  </div>
                  <span className="flex flex-wrap items-center gap-1.5"><ConditionPill condition={i.condition} /><StockFlags i={i} /></span>
                  <div className="ml-auto w-36 text-right">
                    <p className="tabular font-medium" data-testid="item-qty">{qty(i.quantity, i.unit)}</p>
                    <p className="text-xs text-muted">{i.unit_cost ? `${formatINR(i.unit_cost)} each` : "cost not set"}</p>
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </>
        )}
      <ItemFormModal schoolId={schoolId} open={adding} onClose={() => setAdding(false)}
        onSaved={(i) => { setAdding(false); toast.success(`${i.name} added as ${i.item_code}.`); void load(); }} />
    </section>
  );
}
