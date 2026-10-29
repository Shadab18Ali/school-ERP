"use client";

import { clsx } from "clsx";
import { CreditCard, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatINR } from "@/lib/money";
import { limitText, PLAN_TEMPLATES, type FeatureKey, type Plan, type PlanFeature } from "@/lib/platform";

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,9}$/;

type EntDraft = Record<FeatureKey, { on: boolean; limit: string }>;
interface Draft {
  code: string; name: string; description: string; price_monthly: string; price_yearly: string; trial_days: string; grace_period_days: string;
  features: string; display_order: string; ents: EntDraft;
}

function draftFrom(plan: Plan | null, catalog: PlanFeature[], template?: (typeof PLAN_TEMPLATES)[number]): Draft {
  const ents = Object.fromEntries(catalog.map((f) => {
    const e = plan?.entitlements[f.key];
    const on = plan ? !!e?.included : f.kind === "limit" || !!template?.on.includes(f.key);
    return [f.key, { on, limit: e?.limit != null ? String(e.limit) : "" }];
  })) as EntDraft;
  return plan ? {
    code: plan.code, name: plan.name, description: plan.description ?? "", price_monthly: plan.price_monthly, price_yearly: plan.price_yearly,
    trial_days: String(plan.trial_days), grace_period_days: String(plan.grace_period_days), features: plan.features.join("\n"),
    display_order: String(plan.display_order), ents,
  } : {
    code: template?.code ?? "", name: template?.name ?? "", description: "", price_monthly: "", price_yearly: "", trial_days: "", grace_period_days: "",
    features: "", display_order: String(template ? PLAN_TEMPLATES.indexOf(template) + 1 : 0), ents,
  };
}

function PlanModal({ plan, template, catalog, open, onClose, onSaved }: {
  plan: Plan | null; template?: (typeof PLAN_TEMPLATES)[number]; catalog: PlanFeature[]; open: boolean; onClose: () => void; onSaved: (p: Plan) => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<Draft>(() => draftFrom(plan, catalog, template));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setError(null); setF(draftFrom(plan, catalog, template)); } }, [open, plan, catalog, template]);
  const set = (k: keyof Omit<Draft, "ents">, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setEnt = (k: FeatureKey, patch: Partial<EntDraft[FeatureKey]>) => setF((x) => ({ ...x, ents: { ...x.ents, [k]: { ...x.ents[k], ...patch } } }));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!plan && !/^[A-Za-z0-9-]{2,30}$/.test(f.code)) return setError("The code is 2–30 letters, numbers or hyphens, e.g. GROWTH.");
    if (f.name.trim().length < 2) return setError("Name the plan.");
    if (!MONEY.test(f.price_monthly) || !MONEY.test(f.price_yearly)) return setError("Enter both prices in rupees (before tax), e.g. 4000 and 42000.");
    if (!WHOLE.test(f.trial_days) || Number(f.trial_days) > 365) return setError("Enter the trial length in days (0 for no trial, up to 365).");
    if (!WHOLE.test(f.grace_period_days) || Number(f.grace_period_days) > 90) return setError("Enter the grace period in days (0 to 90): how long a school keeps working after a renewal is missed.");
    for (const c of catalog) if (c.kind === "limit" && f.ents[c.key].limit && !WHOLE.test(f.ents[c.key].limit)) return setError(`${c.label}: a whole number, or empty for no limit.`);
    const entitlements = Object.fromEntries(catalog.map((c) => [c.key, c.kind === "limit"
      ? { included: true, limit: f.ents[c.key].limit ? Number(f.ents[c.key].limit) : null }
      : { included: f.ents[c.key].on }]));
    const body = {
      name: f.name.trim(), description: f.description.trim() || null, price_monthly: f.price_monthly, price_yearly: f.price_yearly,
      trial_days: Number(f.trial_days), grace_period_days: Number(f.grace_period_days), entitlements,
      features: f.features.split("\n").map((x) => x.trim()).filter(Boolean), display_order: Number(f.display_order) || 0,
    };
    setSaving(true); setError(null);
    try {
      const saved = plan
        ? await apiFetch<Plan>(`/admin/plans/${plan.id}`, { method: "PATCH", body })
        : await apiFetch<Plan>("/admin/plans", { method: "POST", body: { ...body, code: f.code } });
      toast.success(plan ? `${saved.name} saved.` : `${saved.name} added.`);
      onSaved(saved);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title={plan ? `Edit ${plan.name}` : template ? `New plan from the ${template.name} template` : "New plan"} size="lg"
      description={plan && plan.schools > 0
        ? "Limits and features change at once for every school on this plan. Prices apply from each school's next invoice (unless it has an agreed price)."
        : template ? "The template only switches features on or off. Enter the prices, limits, trial and grace period yourself." : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="plan-form" loading={saving} data-testid="save-plan">Save</Button></>}>
      <form id="plan-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="plan-error">{error}</p>}
        <TextField label="Code" value={f.code} disabled={!!plan} onChange={(e) => set("code", e.target.value.toUpperCase())} maxLength={30} data-testid="plan-code" hint="Can't be changed later" />
        <TextField label="Name" value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={60} data-testid="plan-name" />
        <TextField label="Price per month (₹, before tax)" inputMode="decimal" value={f.price_monthly} onChange={(e) => set("price_monthly", e.target.value.trim())} data-testid="plan-monthly" />
        <TextField label="Price per year (₹, before tax)" inputMode="decimal" value={f.price_yearly} onChange={(e) => set("price_yearly", e.target.value.trim())} data-testid="plan-yearly" />
        <TextField label="Free trial (days)" inputMode="numeric" value={f.trial_days} onChange={(e) => set("trial_days", e.target.value.trim())} hint="0 = no trial" data-testid="plan-trial" />
        <TextField label="Grace period (days)" inputMode="numeric" value={f.grace_period_days} onChange={(e) => set("grace_period_days", e.target.value.trim())}
          hint="After a missed renewal, before the school becomes read-only" data-testid="plan-grace" />
        <fieldset className="rounded-md border border-line p-4 sm:col-span-2" data-testid="plan-entitlements">
          <legend className="px-1 text-sm font-medium">Limits and features</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {catalog.filter((c) => c.kind === "limit").map((c) => (
              <TextField key={c.key} label={`${c.label}${c.unit ? ` (${c.unit})` : ""}`} inputMode="numeric" value={f.ents[c.key]?.limit ?? ""}
                onChange={(e) => setEnt(c.key, { limit: e.target.value.trim() })} hint="Empty: no limit" data-testid={`plan-limit-${c.key}`} />
            ))}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {catalog.filter((c) => c.kind === "feature").map((c) => (
              <label key={c.key} className="flex items-start gap-2 text-sm" title={c.description}>
                <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={f.ents[c.key]?.on ?? false}
                  onChange={(e) => setEnt(c.key, { on: e.target.checked })} data-testid={`plan-feature-${c.key}`} />
                <span>{c.label}{!c.available && <span className="block text-xs text-muted">Not built yet: the setting is kept for when it is</span>}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <TextField label="Description" value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={500} />
        </div>
        <label className="text-sm font-medium sm:col-span-2">
          Highlights <span className="font-normal text-muted">(one per line, shown to schools; what the plan allows is set above)</span>
          <textarea value={f.features} onChange={(e) => set("features", e.target.value)} rows={3} data-testid="plan-features"
            className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </label>
        <TextField label="Order on the list" inputMode="numeric" value={f.display_order} onChange={(e) => set("display_order", e.target.value.replace(/\D/g, ""))} />
      </form>
    </Modal>
  );
}

function PlansView() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [catalog, setCatalog] = useState<PlanFeature[]>([]);
  const [template, setTemplate] = useState<(typeof PLAN_TEMPLATES)[number] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ plan: Plan; action: "retire" | "offer" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, c] = await Promise.all([apiFetch<Plan[]>("/admin/plans"), apiFetch<PlanFeature[]>("/admin/features")]);
      setPlans(p); setCatalog(c);
    } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.action === "delete") await apiFetch(`/admin/plans/${confirm.plan.id}`, { method: "DELETE" });
      else await apiFetch(`/admin/plans/${confirm.plan.id}`, { method: "PATCH", body: { is_active: confirm.action === "offer" } });
      toast.success(confirm.action === "delete" ? `${confirm.plan.name} deleted.` : confirm.action === "retire" ? `${confirm.plan.name} retired.` : `${confirm.plan.name} is offered again.`);
      setConfirm(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Plans" description="What schools subscribe to: prices, trial and grace periods, limits and features. Every number here is yours to set."
        actions={<Button onClick={() => { setEditing(null); setTemplate(undefined); setOpen(true); }} data-testid="new-plan"><Plus className="size-4" /> New plan</Button>} />
      {plans && catalog.length > 0 && (
        <section className="mb-6 rounded-lg border border-dashed border-line bg-white p-4" data-testid="plan-templates">
          <p className="text-sm font-medium">Start from a template</p>
          <p className="text-xs text-muted">A template only names the plan and switches features on; you enter its prices, limits, trial and grace period.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PLAN_TEMPLATES.map((t) => {
              const exists = plans.some((p) => p.code === t.code);
              return (
                <Button key={t.code} size="sm" variant="secondary" disabled={exists} title={exists ? `${t.name} already exists` : t.note}
                  onClick={() => { setEditing(null); setTemplate(t); setOpen(true); }} data-testid={`template-${t.code.toLowerCase()}`}>
                  {t.name}{exists ? " (added)" : ""}
                </Button>
              );
            })}
          </div>
        </section>
      )}
      {error ? <ErrorState message={error} onRetry={load} /> : !plans ? <LoadingState /> : plans.length === 0 ? (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState icon={CreditCard} title="No plans yet" message="Add the plans you offer schools (or start from Basic, Professional or Enterprise above). Then start each school's subscription on its Subscription tab." />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="plan-list">
          {plans.map((p) => (
            <article key={p.id} className={clsx("flex flex-col rounded-lg border bg-white p-5", p.is_active ? "border-line" : "border-dashed border-line opacity-80")} data-testid="plan-card">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">{p.name}</h2>
                  <p className="text-xs text-muted">{p.code}{p.is_active ? "" : " · retired"}</p>
                </div>
                <span className="rounded-full bg-paper px-2 py-0.5 text-xs text-muted" data-testid="plan-schools">{p.schools} {p.schools === 1 ? "school" : "schools"}</span>
              </div>
              <p className="mt-3 text-2xl font-semibold tabular-nums">{formatINR(p.price_monthly)}<span className="text-sm font-normal text-muted"> a month</span></p>
              <p className="text-sm text-muted">or {formatINR(p.price_yearly)} a year</p>
              {p.description && <p className="mt-2 text-sm">{p.description}</p>}
              <p className="mt-2 text-sm" data-testid="plan-terms">
                {p.trial_days > 0 ? `${p.trial_days}-day trial` : "No trial"} · {p.grace_period_days}-day grace
              </p>
              <ul className="mt-2 space-y-0.5 text-sm" data-testid="plan-limits">
                {catalog.map((c) => {
                  const e = p.entitlements[c.key];
                  if (c.kind === "limit") return <li key={c.key}>{c.label}: <span className="font-medium">{limitText({ kind: c.kind, unit: c.unit, limit: e?.limit })}</span></li>;
                  return <li key={c.key} className={e?.included ? "" : "text-muted"}>{c.label}{e?.included ? (c.available ? "" : " (coming later)") : " — not included"}</li>;
                })}
              </ul>
              {p.features.length > 0 && <ul className="mt-2 list-inside list-disc text-sm text-muted">{p.features.map((x) => <li key={x}>{x}</li>)}</ul>}
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button size="sm" variant="secondary" onClick={() => { setEditing(p); setOpen(true); }}>Edit</Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirm({ plan: p, action: p.is_active ? "retire" : "offer" })} data-testid="toggle-plan">
                  {p.is_active ? "Retire" : "Offer again"}
                </Button>
                {p.schools === 0 && <Button size="sm" variant="secondary" onClick={() => setConfirm({ plan: p, action: "delete" })}>Delete</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
      <PlanModal open={open} plan={editing} template={template} catalog={catalog} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void load(); }} />
      <ConfirmDialog open={confirm !== null}
        title={confirm?.action === "delete" ? "Delete this plan?" : confirm?.action === "retire" ? "Retire this plan?" : "Offer this plan again?"}
        message={confirm?.action === "delete" ? `${confirm.plan.name} will be removed. No school is on it.`
          : confirm?.action === "retire" ? `Schools on ${confirm.plan.name} keep it; no other school can be given it.`
            : `${confirm?.plan.name} can be given to schools again.`}
        confirmLabel={confirm?.action === "delete" ? "Delete" : confirm?.action === "retire" ? "Retire" : "Offer"}
        tone={confirm?.action === "offer" ? "primary" : "danger"} loading={busy} onConfirm={act} onCancel={() => setConfirm(null)} />
    </>
  );
}

export default function PlansPage() {
  return <RequirePermission permission="platform:schools.manage"><PlansView /></RequirePermission>;
}
