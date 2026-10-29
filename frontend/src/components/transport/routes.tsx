"use client";

import { MapPinned, Plus, Route as RouteIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { AMOUNT_PATTERN, formatINR } from "@/lib/money";
import {
  billingText, clock, FREQUENCY_LABEL, MONTHS, showReg, VEHICLE_TYPE_LABEL,
  type Frequency, type Route, type RouteDetail, type Staff, type Stop, type Vehicle, type Zone,
} from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";
import { FormError, LicenceState, Pill, TextArea } from "./shared";

// ------------------------------------------------------------------ routes
export function RouteFormModal({ schoolId, open, route, onClose, onSaved }: {
  schoolId: string; open: boolean; route?: Route | null; onClose: () => void; onSaved: (r: RouteDetail) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [attendant, setAttendant] = useState("");
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState("");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(route?.name ?? ""); setCode(route?.code ?? ""); setVehicle(route?.vehicle_id ?? ""); setDriver(route?.driver_id ?? "");
    setAttendant(route?.attendant_id ?? ""); setActive(route ? route.status === "active" : true); setNotes(route?.notes ?? "");
    Promise.all([apiFetch<Vehicle[]>("/transport/vehicles", { schoolId }), apiFetch<Staff[]>("/transport/staff", { schoolId })])
      .then(([v, s]) => { setVehicles(v); setStaff(s); }).catch((e) => setError(errorMessage(e)));
  }, [open, route, schoolId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Name the route, e.g. North or Route 3.");
    if (code.trim() && !/^[A-Za-z0-9-]{1,12}$/.test(code.trim())) return setError("Use letters, digits and - only in the route code (up to 12).");
    setBusy(true);
    const body = { name, code: code.trim() || null, vehicle_id: vehicle || null, driver_id: driver || null, attendant_id: attendant || null, status: active ? "active" : "inactive", notes: notes || null };
    try { onSaved(await apiFetch<RouteDetail>(route ? `/transport/routes/${route.id}` : "/transport/routes", { schoolId, method: route ? "PUT" : "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const usable = (s: Staff, role: string, current: string | null | undefined) => s.role === role && (s.status === "active" || s.id === current);
  return (
    <Modal open={open} size="lg" title={route ? `Edit ${route.name}` : "Add a route"} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="route-form" loading={busy} data-testid="save-route">{route ? "Save" : "Add route"}</Button></>}>
      <form id="route-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="route-error" /></div>
        <TextField label="Route name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. North – Model Town" data-testid="route-name" />
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} placeholder="e.g. R1" data-testid="route-code" hint="Short label painted on the bus (optional)." />
        <SelectField label="Vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)} data-testid="route-vehicle">
          <option value="">No vehicle yet</option>
          {vehicles.filter((v) => v.status !== "retired" || v.id === route?.vehicle_id).map((v) => (
            <option key={v.id} value={v.id}>{showReg(v.registration_number)} · {VEHICLE_TYPE_LABEL[v.vehicle_type]} · {v.seating_capacity} seats{v.status === "maintenance" ? " (maintenance)" : ""}</option>
          ))}
        </SelectField>
        <SelectField label="Driver" value={driver} onChange={(e) => setDriver(e.target.value)} data-testid="route-driver">
          <option value="">No driver yet</option>
          {staff.filter((s) => usable(s, "driver", route?.driver_id)).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
        </SelectField>
        <SelectField label="Attendant" value={attendant} onChange={(e) => setAttendant(e.target.value)} data-testid="route-attendant">
          <option value="">No attendant</option>
          {staff.filter((s) => usable(s, "attendant", route?.attendant_id)).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
        </SelectField>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="size-4 accent-leaf-600" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="route-active" /> Route is running
        </label>
        <div className="sm:col-span-2"><TextArea label="Notes" value={notes} onChange={setNotes} /></div>
        <p className="text-xs text-muted sm:col-span-2">A vehicle can serve several routes (e.g. two rounds). Seats are checked per route.</p>
      </form>
    </Modal>
  );
}

export function RoutesTab({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Route[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<Route[]>("/transport/routes", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  const manage = can("transport:manage");
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-semibold">Routes</h2>
        {manage && <Button size="sm" onClick={() => setAdding(true)} data-testid="add-route"><Plus className="size-4" /> Add route</Button>}
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !items ? <LoadingState />
        : items.length === 0 ? <div className="p-4"><EmptyState icon={RouteIcon} title="No routes yet" message={manage ? "Set up fare zones first, then add routes and their stops." : "No routes have been added."} /></div>
        : (
          <ul className="divide-y divide-line" data-testid="route-list">
            {items.map((r) => {
              const full = r.seating_capacity !== null && r.riders >= r.seating_capacity;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`route-${r.name}`}>
                  <div className="min-w-0 flex-1 basis-60">
                    <Link href={`/transport/routes/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                    {r.code && <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-xs text-muted">{r.code}</span>}
                    <p className="text-xs text-muted">
                      {r.registration_number ? showReg(r.registration_number) : "No vehicle"} · {r.driver_name ?? "No driver"}{r.attendant_name ? ` · ${r.attendant_name}` : ""}
                      {` · ${r.stops} stop${r.stops === 1 ? "" : "s"}`}{r.first_pickup ? ` · first pickup ${clock(r.first_pickup)}` : ""}
                    </p>
                  </div>
                  <span className={`tabular ${full ? "font-medium text-danger-600" : "text-muted"}`} data-testid="route-riders">
                    {r.riders}{r.seating_capacity !== null ? `/${r.seating_capacity}` : ""} student{r.riders === 1 && r.seating_capacity === null ? "" : "s"}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {r.status === "inactive" && <Pill tone="muted">Not running</Pill>}
                    {full && r.status === "active" && <Pill tone="bad">Full</Pill>}
                    {r.vehicle_status === "maintenance" && <Pill tone="warn">Vehicle in maintenance</Pill>}
                    {r.driver_id && manage && <LicenceState until={r.driver_license_valid_until} />}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      <RouteFormModal schoolId={schoolId} open={adding} onClose={() => setAdding(false)}
        onSaved={(r) => { setAdding(false); toast.success(`${r.name} added. Now add its stops.`); void load(); }} />
    </section>
  );
}

// ------------------------------------------------------------------ stops
export function StopFormModal({ schoolId, open, routeId, stop, onClose, onSaved }: {
  schoolId: string; open: boolean; routeId: string; stop?: Stop | null; onClose: () => void; onSaved: (r: RouteDetail) => void;
}) {
  const [name, setName] = useState("");
  const [landmark, setLandmark] = useState("");
  const [pickup, setPickup] = useState("");
  const [drop, setDrop] = useState("");
  const [zone, setZone] = useState("");
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(stop?.name ?? ""); setLandmark(stop?.landmark ?? ""); setPickup(stop?.pickup_time?.slice(0, 5) ?? ""); setDrop(stop?.drop_time?.slice(0, 5) ?? ""); setZone(stop?.fare_zone_id ?? "");
    apiFetch<Zone[]>("/transport/zones", { schoolId }).then((z) => setZones(z.filter((x) => x.is_active || x.id === stop?.fare_zone_id))).catch((e) => setError(errorMessage(e)));
  }, [open, stop, schoolId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Name the stop.");
    if (!zone) return setError("Choose the stop's fare zone.");
    setBusy(true);
    const body = { name, landmark: landmark || null, pickup_time: pickup || null, drop_time: drop || null, fare_zone_id: zone, ...(stop ? { sequence: stop.sequence } : {}) };
    try { onSaved(await apiFetch<RouteDetail>(stop ? `/transport/stops/${stop.id}` : `/transport/routes/${routeId}/stops`, { schoolId, method: stop ? "PUT" : "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} title={stop ? `Edit stop: ${stop.name}` : "Add a stop"} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="stop-form" loading={busy} data-testid="save-stop">{stop ? "Save" : "Add stop"}</Button></>}>
      <form id="stop-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="stop-error" /></div>
        <TextField label="Stop name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Model Town Market" data-testid="stop-name" />
        <TextField label="Landmark" value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={150} placeholder="e.g. Opposite the post office" />
        <TextField label="Morning pickup" type="time" value={pickup} onChange={(e) => setPickup(e.target.value)} data-testid="stop-pickup" />
        <TextField label="Afternoon drop" type="time" value={drop} onChange={(e) => setDrop(e.target.value)} data-testid="stop-drop" />
        <SelectField className="sm:col-span-2" label="Fare zone" value={zone} onChange={(e) => setZone(e.target.value)} data-testid="stop-zone">
          <option value="">{zones && zones.length === 0 ? "Add a fare zone first (Fare zones tab)" : "Choose the fare zone"}</option>
          {zones?.map((z) => <option key={z.id} value={z.id}>{z.name} · {formatINR(z.amount)} {FREQUENCY_LABEL[z.frequency]}</option>)}
        </SelectField>
        {stop?.used && <p className="text-xs text-muted sm:col-span-2">Changing the zone re-prices this stop&apos;s riders&apos; unpaid transport dues. Paid dues don&apos;t change.</p>}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ fare zones
export function ZoneFormModal({ schoolId, open, zone, onClose, onSaved }: {
  schoolId: string; open: boolean; zone?: Zone | null; onClose: () => void; onSaved: (z: Zone[]) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [months, setMonths] = useState<number[]>(MONTHS.map((_, i) => i + 1));
  const [due, setDue] = useState("4");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(zone?.name ?? ""); setAmount(zone ? String(Number(zone.amount)) : ""); setFrequency(zone?.frequency ?? "monthly");
    setMonths(zone?.billing_months ?? MONTHS.map((_, i) => i + 1)); setDue(String(zone?.due_month ?? 4)); setActive(zone?.is_active ?? true);
  }, [open, zone]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Name the zone, e.g. Zone A or Up to 5 km.");
    if (!AMOUNT_PATTERN.test(amount.trim()) || Number(amount) <= 0) return setError("Enter the fare in rupees, e.g. 1200.");
    if (frequency === "monthly" && months.length === 0) return setError("Choose at least one month to bill.");
    setBusy(true);
    const body = { name, amount: amount.trim(), frequency, billing_months: frequency === "monthly" ? months : null, due_month: frequency === "monthly" ? null : Number(due), is_active: active };
    try { onSaved(await apiFetch<Zone[]>(zone ? `/transport/zones/${zone.id}` : "/transport/zones", { schoolId, method: zone ? "PUT" : "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  const toggle = (m: number) => setMonths((xs) => (xs.includes(m) ? xs.filter((x) => x !== m) : [...xs, m].sort((a, b) => a - b)));
  return (
    <Modal open={open} size="lg" title={zone ? `Edit ${zone.name}` : "Add a fare zone"} onClose={busy ? () => {} : onClose}
      description="Stops in the same zone pay the same transport fee. The fee shows on the fee desk and receipts as “Transport – zone name”."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="zone-form" loading={busy} data-testid="save-zone">{zone ? "Save" : "Add zone"}</Button></>}>
      <form id="zone-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="zone-error" /></div>
        <TextField label="Zone name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Zone A (up to 5 km)" data-testid="zone-name" />
        <TextField label="Fare (₹)" required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1200" data-testid="zone-amount" />
        <SelectField label="Charged" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} data-testid="zone-frequency">
          <option value="monthly">Every month</option>
          <option value="quarterly">Every quarter</option>
          <option value="half_yearly">Every half-year</option>
          <option value="yearly">Once a year</option>
        </SelectField>
        {frequency !== "monthly" ? (
          <SelectField label="First due in" value={due} onChange={(e) => setDue(e.target.value)} data-testid="zone-due-month">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </SelectField>
        ) : <div className="hidden sm:block" />}
        {frequency === "monthly" && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">Months billed</legend>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" data-testid="zone-months">
              {MONTHS.map((m, i) => (
                <label key={m} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-sm">
                  <input type="checkbox" className="size-4 accent-leaf-600" checked={months.includes(i + 1)} onChange={() => toggle(i + 1)} data-testid={`zone-month-${i + 1}`} /> {m}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">Untick months without school transport (e.g. summer vacation).</p>
          </fieldset>
        )}
        {zone && (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="zone-active" />
            <span>In use<span className="block text-xs text-muted">An unused zone can&apos;t be chosen for new stops. Zones are never deleted, so old receipts keep their names.</span></span>
          </label>
        )}
        {zone && zone.riders > 0 && <p className="rounded-md bg-pencil-100/60 px-3 py-2 text-sm sm:col-span-2">A new fare applies to this zone&apos;s {zone.riders} rider{zone.riders === 1 ? "" : "s"}&apos; unpaid transport dues. Paid dues keep the old amount.</p>}
      </form>
    </Modal>
  );
}

export function ZonesTab({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Zone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Zone | "new" | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<Zone[]>("/transport/zones", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  const manage = can("transport:manage");
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-semibold">Fare zones</h2>
        {manage && <Button size="sm" onClick={() => setEditing("new")} data-testid="add-zone"><Plus className="size-4" /> Add zone</Button>}
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !items ? <LoadingState />
        : items.length === 0 ? <div className="p-4"><EmptyState icon={MapPinned} title="No fare zones yet" message={manage ? "Add a zone for each fare you charge, e.g. Zone A ₹1,200 a month. Each stop belongs to one zone." : "No fare zones have been set."} /></div>
        : (
          <ul className="divide-y divide-line" data-testid="zone-list">
            {items.map((z) => (
              <li key={z.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`zone-${z.name}`}>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">{z.name} {!z.is_active && <Pill tone="muted">Not in use</Pill>}</p>
                  <p className="text-xs text-muted">Billed {billingText(z)} · fee head “{z.fee_head}”</p>
                </div>
                <span className="text-muted">{z.stops} stop{z.stops === 1 ? "" : "s"} · {z.riders} rider{z.riders === 1 ? "" : "s"}</span>
                <span className="tabular font-medium" data-testid="zone-fare">{formatINR(z.amount)} <span className="text-xs font-normal text-muted">{FREQUENCY_LABEL[z.frequency]}</span></span>
                {manage && <ActionMenu label={`Actions for ${z.name}`} actions={[{ label: "Edit…", onSelect: () => setEditing(z) }]} />}
              </li>
            ))}
          </ul>
        )}
      <ZoneFormModal schoolId={schoolId} open={editing !== null} zone={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={(list) => { setEditing(null); setItems(list); toast.success("Fare zone saved."); }} />
    </section>
  );
}
