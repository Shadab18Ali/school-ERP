"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { CATEGORY_LABEL, qty, type InventoryDashboard } from "@/lib/inventory";
import { formatINR } from "@/lib/money";
import { MovementRow } from "./history";
import { ConditionPill, Section, Tile } from "./shared";

const n = (x: number) => x.toLocaleString("en-IN");

export function InventoryOverview({ schoolId }: { schoolId: string }) {
  const [d, setD] = useState<InventoryDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<InventoryDashboard>("/inventory/dashboard", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const maxValue = Math.max(1, ...d.by_category.map((c) => Number(c.value)));
  return (
    <div className="space-y-6" data-testid="inventory-dashboard">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Items" value={n(d.items)} tone="dark" testId="kpi-items" href="/inventory?tab=Items"
          sub={`${n(d.assigned)} assigned to staff${d.archived ? ` · ${n(d.archived)} archived` : ""}`} />
        <Tile label="Stock value" value={formatINR(d.value)} testId="kpi-value"
          sub={d.items_without_cost ? `${n(d.items_without_cost)} item${d.items_without_cost === 1 ? "" : "s"} without a cost` : "at each item's latest cost"} />
        <Tile label="Low stock" value={n(d.low_stock)} testId="kpi-low" href="/inventory?tab=Items&state=low"
          tone={d.low_stock ? "danger" : undefined} sub={`at or below the reorder level · ${n(d.out_of_stock)} out of stock`} />
        <Tile label="Needs attention" value={n(d.needs_attention)} testId="kpi-attention" href="/inventory?tab=Items&state=attention"
          tone={d.needs_attention ? "danger" : undefined} sub="needs repair, damaged or unusable" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="By category" testId="by-category">
          <ul className="space-y-3 p-5">
            {d.by_category.map((c) => (
              <li key={c.category} className="text-sm">
                <div className="mb-1 flex flex-wrap justify-between gap-2">
                  <Link href={`/inventory?tab=Items&category=${c.category}`} className="hover:underline">{CATEGORY_LABEL[c.category]}</Link>
                  <span className="tabular text-muted">{n(c.items)} item{c.items === 1 ? "" : "s"} · {formatINR(c.value)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-ink/5" aria-hidden>
                  <div className="h-full rounded-full bg-leaf-600" style={{ width: `${(Number(c.value) / maxValue) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Purchases" testId="purchases">
          <dl className="grid grid-cols-2 gap-4 p-5 text-sm">
            <div><dt className="text-muted">This month</dt><dd className="tabular text-lg font-semibold" data-testid="spent-month">{formatINR(d.month_spent)}</dd></div>
            <div><dt className="text-muted">This financial year (from April)</dt><dd className="tabular text-lg font-semibold" data-testid="spent-year">{formatINR(d.year_spent)}</dd></div>
            <div><dt className="text-muted">Stock in this month</dt><dd className="tabular text-lg font-semibold">{n(d.month_in)}</dd></div>
            <div><dt className="text-muted">Stock out this month</dt><dd className="tabular text-lg font-semibold">{n(d.month_out)}</dd></div>
          </dl>
          <p className="border-t border-line px-5 py-3 text-xs text-muted">Counted from stock-in entries marked as purchases, at the cost entered.</p>
        </Section>
        <Section title="Low stock" testId="low-stock-list">
          {d.low_stock_items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">Nothing is at or below its reorder level.</p> : (
            <ul className="divide-y divide-line text-sm">
              {d.low_stock_items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                  <span><Link href={`/inventory/items/${i.id}`} className="font-medium hover:underline">{i.name}</Link> <span className="text-xs text-muted">{i.location}</span></span>
                  <span className="tabular text-danger-600">{qty(i.quantity, i.unit)} <span className="text-xs text-muted">(reorder at {qty(i.min_quantity)})</span></span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Needs attention" testId="attention-list">
          {d.attention_items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">Nothing is marked as needing repair, damaged or unusable.</p> : (
            <ul className="divide-y divide-line text-sm">
              {d.attention_items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                  <span><Link href={`/inventory/items/${i.id}`} className="font-medium hover:underline">{i.name}</Link> <span className="text-xs text-muted">{qty(i.quantity, i.unit)} · {i.location}</span></span>
                  <ConditionPill condition={i.condition} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <Section title="Recent stock in and out" action={<Link href="/inventory?tab=Stock%20history" className="text-sm text-leaf-700 hover:underline">All history</Link>}>
        {d.recent.length === 0 ? <p className="px-5 py-6 text-sm text-muted">Nothing recorded yet.</p> : <ul className="divide-y divide-line">{d.recent.map((m) => <MovementRow key={m.id} m={m} />)}</ul>}
      </Section>
    </div>
  );
}
