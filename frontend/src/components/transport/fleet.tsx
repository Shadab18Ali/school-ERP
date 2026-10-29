"use client";

import { Bus, Plus, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatPhone } from "@/lib/format";
import {
  showReg, VEHICLE_STATUS_LABEL, VEHICLE_TYPE_LABEL,
  type Staff, type StaffDetail, type StaffRole, type Vehicle, type VehicleDetail, type VehicleStatus, type VehicleType,
} from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";
import { FormError, LicenceState, Pill, TextArea } from "./shared";

// ------------------------------------------------------------------ vehicles
interface VehicleForm {
  registration_number: string; vehicle_type: VehicleType; make_model: string; seating_capacity: string; manufacture_year: string;
  ownership: "school" | "contracted"; contractor_name: string; status: VehicleStatus; notes: string;
}
const EMPTY_VEHICLE: VehicleForm = {
  registration_number: "", vehicle_type: "bus", make_model: "", seating_capacity: "", manufacture_year: "",
  ownership: "school", contractor_name: "", status: "active", notes: "",
};

export function VehicleFormModal({ schoolId, open, vehicle, onClose, onSaved }: {
  schoolId: string; open: boolean; vehicle?: Vehicle | null; onClose: () => void; onSaved: (v: VehicleDetail) => void;
}) {
  const [f, setF] = useState<VehicleForm>(EMPTY_VEHICLE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(vehicle ? {
      registration_number: vehicle.registration_number, vehicle_type: vehicle.vehicle_type, make_model: vehicle.make_model ?? "",
      seating_capacity: String(vehicle.seating_capacity), manufacture_year: vehicle.manufacture_year ? String(vehicle.manufacture_year) : "",
      ownership: vehicle.ownership, contractor_name: vehicle.contractor_name ?? "", status: vehicle.status, notes: vehicle.notes ?? "",
    } : EMPTY_VEHICLE);
  }, [open, vehicle]);
  const set = (k: keyof VehicleForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const reg = f.registration_number.toUpperCase().replace(/[\s.\-]/g, "");
    if (!/^[A-Z0-9]{4,12}$/.test(reg)) return setError("Enter the registration number as on the number plate, e.g. DL 1P C 1234.");
    const seats = Number(f.seating_capacity);
    if (!Number.isInteger(seats) || seats < 1 || seats > 100) return setError("Enter the number of seats for students (1–100).");
    if (f.manufacture_year && !/^\d{4}$/.test(f.manufacture_year)) return setError("Enter the year as four digits.");
    if (f.ownership === "contracted" && !f.contractor_name.trim()) return setError("Enter the contractor's name.");
    setBusy(true);
    const body = {
      registration_number: reg, vehicle_type: f.vehicle_type, make_model: f.make_model || null, seating_capacity: seats,
      manufacture_year: f.manufacture_year ? Number(f.manufacture_year) : null, ownership: f.ownership,
      contractor_name: f.ownership === "contracted" ? f.contractor_name : null, status: f.status, notes: f.notes || null,
    };
    try {
      onSaved(await apiFetch<VehicleDetail>(vehicle ? `/transport/vehicles/${vehicle.id}` : "/transport/vehicles", { schoolId, method: vehicle ? "PUT" : "POST", body }));
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" title={vehicle ? `Edit ${showReg(vehicle.registration_number)}` : "Add a vehicle"} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="vehicle-form" loading={busy} data-testid="save-vehicle">{vehicle ? "Save" : "Add vehicle"}</Button></>}>
      <form id="vehicle-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="vehicle-error" /></div>
        <TextField label="Registration number" required value={f.registration_number} onChange={set("registration_number")} maxLength={20} placeholder="e.g. DL 1P C 1234" data-testid="vehicle-reg" />
        <SelectField label="Type" value={f.vehicle_type} onChange={set("vehicle_type")} data-testid="vehicle-type">
          {(Object.keys(VEHICLE_TYPE_LABEL) as VehicleType[]).map((t) => <option key={t} value={t}>{VEHICLE_TYPE_LABEL[t]}</option>)}
        </SelectField>
        <TextField label="Student seats" required inputMode="numeric" value={f.seating_capacity} onChange={set("seating_capacity")} maxLength={3} data-testid="vehicle-seats"
          hint="Students who can ride at one time. Assignments beyond this are refused." />
        <TextField label="Make and model" value={f.make_model} onChange={set("make_model")} maxLength={80} placeholder="e.g. Tata Starbus 40" />
        <TextField label="Year of manufacture" inputMode="numeric" value={f.manufacture_year} onChange={set("manufacture_year")} maxLength={4} />
        <SelectField label="Status" value={f.status} onChange={set("status")} data-testid="vehicle-status">
          {(Object.keys(VEHICLE_STATUS_LABEL) as VehicleStatus[]).map((s) => <option key={s} value={s}>{VEHICLE_STATUS_LABEL[s]}</option>)}
        </SelectField>
        <SelectField label="Owned by" value={f.ownership} onChange={set("ownership")} data-testid="vehicle-ownership">
          <option value="school">The school</option>
          <option value="contracted">A contractor</option>
        </SelectField>
        {f.ownership === "contracted" && <TextField label="Contractor" required value={f.contractor_name} onChange={set("contractor_name")} maxLength={120} data-testid="vehicle-contractor" />}
        <div className="sm:col-span-2"><TextArea label="Notes" value={f.notes} onChange={(v) => setF((x) => ({ ...x, notes: v }))} /></div>
      </form>
    </Modal>
  );
}

export function VehiclesTab({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<Vehicle[]>("/transport/vehicles", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  const manage = can("transport:manage");
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-semibold">Vehicles</h2>
        {manage && <Button size="sm" onClick={() => setAdding(true)} data-testid="add-vehicle"><Plus className="size-4" /> Add vehicle</Button>}
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !items ? <LoadingState />
        : items.length === 0 ? <div className="p-4"><EmptyState icon={Bus} title="No vehicles yet" message={manage ? "Add the school's buses and vans, then upload their papers." : "No vehicles have been added."} /></div>
        : (
          <ul className="divide-y divide-line" data-testid="vehicle-list">
            {items.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`vehicle-${v.registration_number}`}>
                <div className="min-w-0 flex-1 basis-56">
                  <Link href={`/transport/vehicles/${v.id}`} className="font-medium hover:underline">{showReg(v.registration_number)}</Link>
                  <span className="ml-2 text-muted">{VEHICLE_TYPE_LABEL[v.vehicle_type]}{v.make_model ? ` · ${v.make_model}` : ""}</span>
                  <p className="text-xs text-muted">{v.route_names ? `Route: ${v.route_names}` : "Not on a route"}{v.ownership === "contracted" ? ` · ${v.contractor_name}` : ""}</p>
                </div>
                <span className="tabular text-muted" title="Riding today / seats">{v.riders ?? 0}/{v.seating_capacity} seats</span>
                <span className="flex flex-wrap gap-1.5">
                  {v.status !== "active" && <Pill tone={v.status === "retired" ? "muted" : "warn"}>{VEHICLE_STATUS_LABEL[v.status]}</Pill>}
                  {v.documents_expired > 0 && <Pill tone="bad">{v.documents_expired} expired</Pill>}
                  {v.documents_missing > 0 && v.status !== "retired" && <Pill tone="warn">{v.documents_missing} paper{v.documents_missing === 1 ? "" : "s"} missing</Pill>}
                </span>
              </li>
            ))}
          </ul>
        )}
      <VehicleFormModal schoolId={schoolId} open={adding} onClose={() => setAdding(false)}
        onSaved={(v) => { setAdding(false); toast.success(`${showReg(v.registration_number)} added.`); void load(); }} />
    </section>
  );
}

// ------------------------------------------------------------------ drivers and attendants
interface StaffForm {
  role: StaffRole; full_name: string; phone: string; alternate_phone: string; license_number: string; license_valid_until: string;
  date_of_birth: string; address: string; joined_on: string; status: "active" | "inactive"; notes: string;
}
const EMPTY_STAFF: StaffForm = {
  role: "driver", full_name: "", phone: "", alternate_phone: "", license_number: "", license_valid_until: "",
  date_of_birth: "", address: "", joined_on: "", status: "active", notes: "",
};

export function StaffFormModal({ schoolId, open, person, role, onClose, onSaved }: {
  schoolId: string; open: boolean; person?: StaffDetail | null; role?: StaffRole; onClose: () => void; onSaved: (s: StaffDetail) => void;
}) {
  const [f, setF] = useState<StaffForm>(EMPTY_STAFF);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(person ? {
      role: person.role, full_name: person.full_name, phone: person.phone, alternate_phone: person.alternate_phone ?? "",
      license_number: person.license_number ?? "", license_valid_until: person.license_valid_until ?? "", date_of_birth: person.date_of_birth ?? "",
      address: person.address ?? "", joined_on: person.joined_on ?? "", status: person.status, notes: person.notes ?? "",
    } : { ...EMPTY_STAFF, role: role ?? "driver" });
  }, [open, person, role]);
  const set = (k: keyof StaffForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const driver = f.role === "driver";

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (f.full_name.trim().length < 2) return setError("Enter the full name.");
    if (f.phone.replace(/\D/g, "").length < 10) return setError("Enter a 10-digit mobile number.");
    if (driver && (!f.license_number.trim() || !f.license_valid_until)) return setError("Enter the driving licence number and the date it is valid until.");
    setBusy(true);
    const body = {
      role: f.role, full_name: f.full_name, phone: f.phone, alternate_phone: f.alternate_phone || null,
      license_number: f.license_number || null, license_valid_until: f.license_valid_until || null, date_of_birth: f.date_of_birth || null,
      address: f.address || null, joined_on: f.joined_on || null, status: f.status, notes: f.notes || null,
    };
    try { onSaved(await apiFetch<StaffDetail>(person ? `/transport/staff/${person.id}` : "/transport/staff", { schoolId, method: person ? "PUT" : "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" title={person ? `Edit ${person.full_name}` : driver ? "Add a driver" : "Add an attendant"} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="staff-form" loading={busy} data-testid="save-staff">{person ? "Save" : "Add"}</Button></>}>
      <form id="staff-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="staff-error" /></div>
        <SelectField label="Role" value={f.role} onChange={set("role")} data-testid="staff-role">
          <option value="driver">Driver</option>
          <option value="attendant">Attendant / conductor</option>
        </SelectField>
        <TextField label="Full name" required value={f.full_name} onChange={set("full_name")} maxLength={150} data-testid="staff-name" />
        <TextField label="Mobile" required type="tel" value={f.phone} onChange={set("phone")} maxLength={16} data-testid="staff-phone" hint="Families see this number for their child's route." />
        <TextField label="Other phone" type="tel" value={f.alternate_phone} onChange={set("alternate_phone")} maxLength={16} />
        {driver && <>
          <TextField label="Driving licence number" required value={f.license_number} onChange={set("license_number")} maxLength={30} placeholder="e.g. DL-0420110012345" data-testid="staff-licence" />
          <TextField label="Licence valid until" required type="date" value={f.license_valid_until} onChange={set("license_valid_until")} data-testid="staff-licence-until"
            hint="A driver with an expired licence can't be put on a route." />
        </>}
        <TextField label="Date of birth" type="date" value={f.date_of_birth} onChange={set("date_of_birth")} />
        <TextField label="Joined on" type="date" value={f.joined_on} onChange={set("joined_on")} />
        <SelectField label="Status" value={f.status} onChange={set("status")} data-testid="staff-status">
          <option value="active">Active</option>
          <option value="inactive">Inactive (left / on leave)</option>
        </SelectField>
        <div className="sm:col-span-2"><TextArea label="Address" value={f.address} onChange={(v) => setF((x) => ({ ...x, address: v }))} /></div>
        <div className="sm:col-span-2"><TextArea label="Notes" value={f.notes} onChange={(v) => setF((x) => ({ ...x, notes: v }))} /></div>
      </form>
    </Modal>
  );
}

export function StaffTab({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Staff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<StaffRole | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<Staff[]>("/transport/staff", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  const manage = can("transport:manage");
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-semibold">Drivers and attendants</h2>
        {manage && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setAdding("driver")} data-testid="add-driver"><Plus className="size-4" /> Driver</Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding("attendant")} data-testid="add-attendant"><Plus className="size-4" /> Attendant</Button>
          </div>
        )}
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !items ? <LoadingState />
        : items.length === 0 ? <div className="p-4"><EmptyState icon={UserRound} title="No drivers or attendants yet" message={manage ? "Add drivers with their licence details, and attendants." : "None have been added."} /></div>
        : (
          <ul className="divide-y divide-line" data-testid="staff-list">
            {items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid="staff-row">
                <div className="min-w-0 flex-1 basis-56">
                  {manage ? <Link href={`/transport/staff/${s.id}`} className="font-medium hover:underline">{s.full_name}</Link> : <span className="font-medium">{s.full_name}</span>}
                  <span className="ml-2 text-muted">{s.role === "driver" ? "Driver" : "Attendant"} · {formatPhone(s.phone)}</span>
                  <p className="text-xs text-muted">{s.route_names ? `Route: ${s.route_names}` : "Not on a route"}</p>
                </div>
                <span className="flex flex-wrap gap-1.5">
                  {s.status === "inactive" && <Pill tone="muted">Inactive</Pill>}
                  {s.role === "driver" && manage && <LicenceState until={s.license_valid_until} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      <StaffFormModal schoolId={schoolId} open={adding !== null} role={adding ?? undefined} onClose={() => setAdding(null)}
        onSaved={(s) => { setAdding(null); toast.success(`${s.full_name} added.`); void load(); }} />
    </section>
  );
}
