"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { showReg, type ComplianceItem, type TransportDashboard } from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";
import { Pill, Section, Tile } from "./shared";

const n = (x: number) => x.toLocaleString("en-IN");

export function ComplianceList({ items, link }: { items: ComplianceItem[]; link: boolean }) {
  if (items.length === 0) {
    return <p className="flex items-center gap-2 px-5 py-6 text-sm text-muted"><CheckCircle2 className="size-4 text-leaf-600" aria-hidden /> All vehicle papers and driving licences are in date.</p>;
  }
  return (
    <ul className="divide-y divide-line" data-testid="compliance-list">
      {items.map((c, i) => {
        const name = c.owner_kind === "vehicle" ? showReg(c.owner) : c.owner;
        const owner = link
          ? <Link href={`/transport/${c.owner_kind === "vehicle" ? "vehicles" : "staff"}/${c.owner_id}`} className="font-medium hover:underline">{name}</Link>
          : <span className="font-medium">{name}</span>;
        return (
          <li key={`${c.owner_id}-${c.what}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm" data-testid={`compliance-${c.kind}`}>
            <span className="min-w-0 flex-1">{owner} · {c.what}</span>
            {c.kind === "expired" ? <Pill tone="bad">Expired {formatDate(c.date)}</Pill>
              : c.kind === "expiring" ? <Pill tone="warn">Expires {formatDate(c.date)}</Pill>
              : <Pill tone="muted">Not uploaded</Pill>}
          </li>
        );
      })}
    </ul>
  );
}

export function TransportOverview({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const [d, setD] = useState<TransportDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<TransportDashboard>("/transport/dashboard", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const manage = can("transport:manage");
  const papers = d.documents_expired + d.documents_expiring + d.licenses_expiring;
  return (
    <div className="space-y-6" data-testid="transport-dashboard">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Students using transport" value={n(d.students)} tone="dark" testId="kpi-students" href="/transport?tab=Students"
          sub={`${n(d.seats)} seats in service${d.routes_full ? ` · ${n(d.routes_full)} route${d.routes_full === 1 ? "" : "s"} full` : ""}`} />
        <Tile label="Routes" value={n(d.routes)} sub={`${n(d.stops)} stop${d.stops === 1 ? "" : "s"}`} testId="kpi-routes" href="/transport?tab=Routes" />
        <Tile label="Vehicles" value={n(d.vehicles)} sub={d.vehicles_in_maintenance ? `${n(d.vehicles_in_maintenance)} in maintenance` : "all in service"} testId="kpi-vehicles" href="/transport?tab=Vehicles" />
        <Tile label="Drivers & attendants" value={n(d.drivers + d.attendants)} sub={`${n(d.drivers)} driver${d.drivers === 1 ? "" : "s"} · ${n(d.attendants)} attendant${d.attendants === 1 ? "" : "s"}`} testId="kpi-staff" href="/transport?tab=Drivers" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={`Transport fees${d.session_name ? ` · ${d.session_name}` : ""}`} testId="transport-fees">
          <dl className="grid grid-cols-2 gap-4 p-5 text-sm">
            <div><dt className="text-muted">Billed for the session</dt><dd className="tabular text-lg font-semibold" data-testid="fees-billed">{formatINR(d.fees.billed)}</dd></div>
            <div><dt className="text-muted">Due till now</dt><dd className="tabular text-lg font-semibold">{formatINR(d.fees.due_till_now)}</dd></div>
            <div><dt className="text-muted">Collected</dt><dd className="tabular text-lg font-semibold text-leaf-700" data-testid="fees-collected">{formatINR(d.fees.collected)}</dd></div>
            <div><dt className="text-muted">Overdue</dt><dd className={`tabular text-lg font-semibold ${Number(d.fees.overdue) > 0 ? "text-danger-600" : ""}`} data-testid="fees-overdue">{formatINR(d.fees.overdue)}</dd></div>
          </dl>
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            Transport fees are collected at the fee desk with the other fees, on the same receipt. {can("fees:view") && <Link href="/fees" className="underline">Fee reports</Link>}
          </p>
        </Section>
        <Section title="Papers and licences" testId="compliance"
          action={papers > 0 ? <span className="inline-flex items-center gap-1.5 text-sm text-danger-600"><AlertTriangle className="size-4" aria-hidden /> {n(d.documents_expired)} expired · {n(d.documents_expiring + d.licenses_expiring)} expiring soon</span> : undefined}>
          <ComplianceList items={d.compliance} link={manage} />
          {d.compliance.length >= 8 && <p className="border-t border-line px-5 py-3 text-xs text-muted">Showing the first 8. Open each vehicle or driver to see all their papers.</p>}
        </Section>
      </div>
    </div>
  );
}
