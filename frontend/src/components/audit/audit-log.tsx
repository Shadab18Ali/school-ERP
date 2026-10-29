"use client";

import { ChevronDown, ChevronRight, Download, ScrollText } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export interface AuditEntry {
  id: number; created_at: string; school_id: string | null; school_name: string | null; actor_id: string | null; actor_label: string | null;
  action: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown>; ip_address: string | null;
  user_agent: string | null; source: "api" | "database" | "auth" | "app";
}
interface AuditPage { items: AuditEntry[]; total: number; page: number; page_size: number }

const CATEGORY_LABEL: Record<string, string> = {
  sign_in: "Sign-ins", students: "Students", fees: "Fees and receipts", attendance: "Attendance", people: "People and roles",
  school: "School setup", billing: "Subscription", payroll: "Payroll",
};
const SOURCE_LABEL: Record<AuditEntry["source"], string> = {
  api: "In the app", database: "Data change", auth: "Sign-in service", app: "In the app",
};

/** "student.updated" → "Student updated" (with clearer words for the common ones) */
const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Signed in", "auth.logout": "Signed out", "auth.password_changed": "Changed password", "auth.email_changed": "Changed email",
  "fee_payment.recorded": "Receipt recorded", "fee_payment.cancelled": "Receipt cancelled", "attendance.changed": "Attendance changed",
  "membership.created": "Given access", "membership.role_changed": "Role changed", "membership.disabled": "Sign-in turned off",
  "membership.enabled": "Sign-in turned on", "membership.deleted": "Access removed", "user.created": "Account created",
  "user.super_admin_granted": "Made platform admin", "user.super_admin_removed": "Platform admin removed",
  "school.activated": "School activated", "school.deactivated": "School deactivated", "audit.exported": "Audit log exported",
};
export function actionLabel(a: string): string {
  if (ACTION_LABEL[a]) return ACTION_LABEL[a];
  const s = a.replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function browser(ua: string | null): string {
  if (!ua) return "";
  const m = ua.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/);
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const name = m ? ({ Edg: "Edge" } as Record<string, string>)[m[1]] ?? m[1] : "";
  return [name, os].filter(Boolean).join(" on ") || ua.slice(0, 40);
}

function value(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Details({ e }: { e: AuditEntry }) {
  const m = e.metadata ?? {};
  const changes = m.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  const record = m.record as Record<string, unknown> | undefined;
  const rest = Object.entries(m).filter(([k]) => !["changes", "record", "label", "student"].includes(k));
  return (
    <div className="space-y-3 text-xs" data-testid="audit-details">
      {changes && (
        <table className="w-full max-w-2xl">
          <thead className="text-left text-muted"><tr><th className="py-1 pr-3 font-medium">Field</th><th className="py-1 pr-3 font-medium">Before</th><th className="py-1 font-medium">After</th></tr></thead>
          <tbody>{Object.entries(changes).map(([k, c]) => (
            <tr key={k} data-testid="audit-change"><td className="py-0.5 pr-3 font-medium">{k.replace(/_/g, " ")}</td>
              <td className="break-all py-0.5 pr-3 text-danger-600">{value(c.from)}</td><td className="break-all py-0.5 text-leaf-700">{value(c.to)}</td></tr>
          ))}</tbody>
        </table>
      )}
      {record && (
        <dl className="grid max-w-3xl grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
          {Object.entries(record).filter(([, v]) => v !== null && v !== "").map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-muted">{k.replace(/_/g, " ")}</dt><dd className="break-all">{value(v)}</dd></div>
          ))}
        </dl>
      )}
      {rest.length > 0 && (
        <dl className="grid max-w-3xl grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
          {rest.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-muted">{k.replace(/_/g, " ")}</dt><dd className="break-all">{value(v)}</dd></div>)}
        </dl>
      )}
      <p className="text-muted">
        {SOURCE_LABEL[e.source]} · {e.entity_type}{e.entity_id ? ` ${e.entity_id}` : ""}{e.ip_address ? ` · IP ${e.ip_address}` : ""}
        {e.user_agent ? ` · ${e.user_agent.slice(0, 160)}` : ""}
      </p>
    </div>
  );
}

/** The audit log, newest first, with filters and CSV export. `base` is /audit (a school) or /admin/audit (the platform). */
export function AuditLog({ base, schoolId, platform = false, schools = [] }: {
  base: string; schoolId?: string; platform?: boolean; schools?: { id: string; name: string }[];
}) {
  const toast = useToast();
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [school, setSchool] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const params = useCallback((withPage: boolean) => {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (search) p.set("q", search);
    if (platform && school === "platform") p.set("platform_only", "true");
    else if (platform && school) p.set("school_id", school);
    if (withPage) { p.set("page", String(page)); p.set("page_size", "50"); }
    return p;
  }, [category, from, to, search, platform, school, page]);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<AuditPage>(`${base}?${params(true)}`, schoolId ? { schoolId } : {})); } catch (e) { setError(errorMessage(e)); }
  }, [base, params, schoolId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [q]);

  async function exportCsv() {
    setExporting(true);
    try {
      const { blob, filename } = await apiFetchBlob(`${base}/export?${params(false)}`, schoolId ? { schoolId } : {});
      saveBlob(blob, filename ?? "audit-log.csv");
    } catch (e) { toast.error(errorMessage(e)); } finally { setExporting(false); }
  }

  return (
    <section className="rounded-lg border border-line bg-white" data-testid="audit-log">
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-5">
        <SelectField label="What" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} data-testid="audit-category">
          <option value="">Everything</option>
          {Object.entries(CATEGORY_LABEL).filter(([k]) => !(platform && k === "payroll")).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>
        {platform && (
          <SelectField label="School" value={school} onChange={(e) => { setSchool(e.target.value); setPage(1); }} data-testid="audit-school">
            <option value="">All schools</option>
            <option value="platform">Platform only (no school)</option>
            {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </SelectField>
        )}
        <TextField label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <TextField label="To" type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Person, student, receipt, IP…" data-testid="audit-search" />
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : !data ? <LoadingState /> : <>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm">
          <span data-testid="audit-total">{data.total.toLocaleString("en-IN")} {data.total === 1 ? "entry" : "entries"}</span>
          <Button size="sm" variant="secondary" onClick={exportCsv} loading={exporting} data-testid="audit-export"><Download className="size-4" /> CSV</Button>
        </div>
        {data.items.length === 0 ? <EmptyState icon={ScrollText} title="Nothing recorded" message="No entries match these filters." /> : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm" data-testid="audit-table">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="w-6 px-2 py-2" /><th className="px-3 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Who</th>
                  <th className="px-3 py-2 font-medium">What</th><th className="px-3 py-2 font-medium">Record</th>
                  {platform && <th className="px-3 py-2 font-medium">School</th>}<th className="px-3 py-2 font-medium">From</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((e) => {
                  const label = (e.metadata?.label as string | undefined) ?? "";
                  const student = (e.metadata?.student as string | undefined) ?? "";
                  return (
                    <Fragment key={e.id}>
                      <tr className="cursor-pointer hover:bg-paper/60" onClick={() => setOpen(open === e.id ? null : e.id)} data-testid="audit-row" data-action={e.action}>
                        <td className="px-2 py-2 text-muted">
                          <button type="button" aria-expanded={open === e.id} aria-label={open === e.id ? "Hide details" : "Show details"} className="grid place-items-center">
                            {open === e.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDateTime(e.created_at)}</td>
                        <td className="px-3 py-2">{e.actor_label ?? "—"}</td>
                        <td className="px-3 py-2 font-medium">{actionLabel(e.action)}</td>
                        <td className="px-3 py-2">{[label, student && student !== label ? student : ""].filter(Boolean).join(" · ") || <span className="text-muted">{e.entity_type}</span>}</td>
                        {platform && <td className="px-3 py-2 text-muted">{e.school_name ?? "Platform"}</td>}
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{e.ip_address ?? ""}<span className="block">{browser(e.user_agent)}</span></td>
                      </tr>
                      {open === e.id && <tr><td /><td colSpan={platform ? 6 : 5} className="px-3 pb-3 pt-1"><Details e={e} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} />
      </>}
    </section>
  );
}
