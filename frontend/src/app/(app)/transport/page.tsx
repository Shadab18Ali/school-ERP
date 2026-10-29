"use client";

import { clsx } from "clsx";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { TransportOverview } from "@/components/transport/dashboard";
import { StaffTab, VehiclesTab } from "@/components/transport/fleet";
import { RoutesTab, ZonesTab } from "@/components/transport/routes";
import { StudentsTab } from "@/components/transport/students";
import { LoadingState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Dashboard", "Students", "Routes", "Vehicles", "Drivers", "Fare zones"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { Dashboard: "Dashboard", Students: "Students", Routes: "Routes & stops", Vehicles: "Vehicles", Drivers: "Drivers & attendants", "Fare zones": "Fare zones" };

function Transport() {
  const { can, currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [tab, setTab] = useState<Tab>("Dashboard");
  const params = useSearchParams(); // /transport?tab=Students&route=<id>
  const route = params.get("route") ?? "";
  useEffect(() => {
    const t = params.get("tab") as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
  }, [params]);
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "Dashboard" ? "/transport" : `/transport?tab=${encodeURIComponent(t)}`); } catch { /* ignore */ }
  }
  return (
    <>
      <PageHeader title="Transport" description={can("transport:manage")
        ? "Vehicles, drivers, routes and stops, which students ride, and their transport fees."
        : "Routes, vehicles and the students who use school transport (view only)."} />
      <div role="tablist" aria-label="Transport" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`transport-tab-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{TAB_LABEL[t]}</button>
        ))}
      </div>
      {tab === "Dashboard" ? <TransportOverview schoolId={schoolId} />
        : tab === "Students" ? <StudentsTab key={route} schoolId={schoolId} initialRoute={route} />
        : tab === "Routes" ? <RoutesTab schoolId={schoolId} />
        : tab === "Vehicles" ? <VehiclesTab schoolId={schoolId} />
        : tab === "Drivers" ? <StaffTab schoolId={schoolId} />
        : <ZonesTab schoolId={schoolId} />}
      <p className="mt-6 text-xs text-muted">Live vehicle tracking (GPS) isn&apos;t part of this module.</p>
    </>
  );
}

export default function TransportPage() {
  return <RequirePermission permission="transport:view"><Suspense fallback={<LoadingState />}><Transport /></Suspense></RequirePermission>;
}
