"use client";

import { clsx } from "clsx";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { InventoryOverview } from "@/components/inventory/dashboard";
import { HistoryTab } from "@/components/inventory/history";
import { ItemsTab } from "@/components/inventory/items";
import { PageHeader } from "@/components/layout/app-shell";
import { LoadingState } from "@/components/ui/states";
import { CATEGORIES, type Category, type ItemState } from "@/lib/inventory";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Dashboard", "Items", "Stock history"] as const;
type Tab = (typeof TABS)[number];
const STATES: ItemState[] = ["active", "low", "attention", "assigned", "archived", "all"];

function Inventory() {
  const { can, currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const params = useSearchParams(); // /inventory?tab=Items&state=low&category=computer
  const [tab, setTab] = useState<Tab>("Dashboard");
  const state = (STATES as string[]).includes(params.get("state") ?? "") ? (params.get("state") as ItemState) : "active";
  const category = (CATEGORIES as string[]).includes(params.get("category") ?? "") ? (params.get("category") as Category) : "";
  useEffect(() => {
    const t = params.get("tab") as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
  }, [params]);
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "Dashboard" ? "/inventory" : `/inventory?tab=${encodeURIComponent(t)}`); } catch { /* ignore */ }
  }
  return (
    <>
      <PageHeader title="Inventory" description={can("inventory:manage")
        ? "Computers, furniture, lab equipment, sports gear, stationery and electronics: what the school has, where, in what condition, and every stock in and out."
        : "What the school has, where it is, and the stock history (view only)."} />
      <div role="tablist" aria-label="Inventory" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`inventory-tab-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab === "Dashboard" ? <InventoryOverview schoolId={schoolId} />
        : tab === "Items" ? <ItemsTab key={`${state}-${category}`} schoolId={schoolId} initialState={state} initialCategory={category} />
        : <HistoryTab schoolId={schoolId} />}
    </>
  );
}

export default function InventoryPage() {
  return <RequirePermission permission="inventory:view"><Suspense fallback={<LoadingState />}><Inventory /></Suspense></RequirePermission>;
}
