"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import { todayISO } from "@/lib/format";
import {
  CATEGORIES, CATEGORY_LABEL, CONDITION_LABEL, CONDITIONS, IN_REASONS, isMeasured, OUT_REASONS, qty, UNITS,
  type Category, type Condition, type Item, type StaffOption, type Unit,
} from "@/lib/inventory";
import { AMOUNT_PATTERN, formatINR } from "@/lib/money";

export function Pill({ tone, children, testId }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode; testId?: string }) {
  const cls = { ok: "bg-leaf-50 text-leaf-700", warn: "bg-pencil-100 text-ink", bad: "bg-danger-50 text-danger-600", muted: "bg-ink/5 text-muted" }[tone];
  return <span className={clsx("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", cls)} data-testid={testId}>{children}</span>;
}

export function ConditionPill({ condition }: { condition: Condition }) {
  const tone = condition === "new" || condition === "good" ? "ok" : condition === "fair" ? "muted" : condition === "needs_repair" ? "warn" : "bad";
  return <Pill tone={tone} testId="condition">{CONDITION_LABEL[condition]}</Pill>;
}

/** Stock state for a row: out of stock / low / archived. */
export function StockFlags({ i }: { i: Pick<Item, "quantity" | "is_low" | "is_active" | "min_quantity" | "unit"> }) {
  return (
    <>
      {!i.is_active && <Pill tone="muted">Archived</Pill>}
      {i.is_active && Number(i.quantity) === 0 && <Pill tone="bad" testId="out-of-stock">Out of stock</Pill>}
      {i.is_active && Number(i.quantity) > 0 && i.is_low && <Pill tone="warn" testId="low-stock">Low (reorder at {qty(i.min_quantity)})</Pill>}
    </>
  );
}

export function Section({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Tile({ label, value, sub, tone, href, testId }: { label: string; value: string; sub?: string; tone?: "dark" | "danger"; href?: string; testId: string }) {
  const body = (
    <div className={tone === "dark" ? "h-full rounded-lg bg-board-900 p-5 text-white" : "h-full rounded-lg border border-line bg-white p-5 hover:border-leaf-600/40"} data-testid={testId}>
      <p className={tone === "dark" ? "text-sm text-white/60" : "text-sm text-muted"}>{label}</p>
      <p className={clsx("tabular mt-2 text-3xl font-semibold tracking-tight", tone === "danger" && "text-danger-600")} data-testid={`${testId}-value`}>{value}</p>
      {sub && <p className={tone === "dark" ? "mt-1 text-xs text-white/60" : "mt-1 text-xs text-muted"}>{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

function FormError({ error, testId }: { error: string | null; testId?: string }) {
  return error ? <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid={testId}>{error}</p> : null;
}

function TextArea({ label, value, onChange, maxLength = 500 }: { label: string; value: string; onChange: (v: string) => void; maxLength?: number }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={2}
        className="block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
    </div>
  );
}

const QTY = /^\d{1,9}(\.\d{1,2})?$/;
function checkQty(v: string, unit: Unit, label: string): string | null {
  if (!QTY.test(v.trim())) return `Enter the ${label} as a number, e.g. 10.`;
  if (!isMeasured(unit) && !Number.isInteger(Number(v))) return `Enter a whole number for the ${label} (counted in ${qty(2, unit).split(" ")[1]}).`;
  return null;
}

/** Locations already in use, offered as suggestions. */
function useLocations(schoolId: string, open: boolean) {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => { if (open) apiFetch<string[]>("/inventory/locations", { schoolId }).then(setList).catch(() => setList([])); }, [open, schoolId]);
  return list;
}
function useStaff(schoolId: string, open: boolean) {
  const [list, setList] = useState<StaffOption[]>([]);
  useEffect(() => { if (open) apiFetch<StaffOption[]>("/inventory/staff", { schoolId }).then(setList).catch(() => setList([])); }, [open, schoolId]);
  return list;
}

// ------------------------------------------------------------------ add / edit an item
interface Form {
  name: string; category: Category | ""; unit: Unit; brand_model: string; serial_number: string; description: string; min_quantity: string;
  unit_cost: string; purchase_date: string; vendor: string; location: string; condition: Condition; assigned_teacher_id: string; notes: string;
  // new items: the stock they arrive with
  o_quantity: string; o_reason: "purchase" | "opening" | "donation"; o_date: string; o_cost: string; o_vendor: string; o_reference: string;
}
const EMPTY: Form = {
  name: "", category: "", unit: "piece", brand_model: "", serial_number: "", description: "", min_quantity: "", unit_cost: "", purchase_date: "",
  vendor: "", location: "", condition: "good", assigned_teacher_id: "", notes: "",
  o_quantity: "", o_reason: "purchase", o_date: "", o_cost: "", o_vendor: "", o_reference: "",
};
const num = (v: string | null) => (v === null ? "" : String(Number(v)));

export function ItemFormModal({ schoolId, open, item, onClose, onSaved }: {
  schoolId: string; open: boolean; item?: Item | null; onClose: () => void; onSaved: (i: Item) => void;
}) {
  const [f, setF] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locations = useLocations(schoolId, open);
  const staff = useStaff(schoolId, open);
  const listId = useId();
  const editing = Boolean(item);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(item ? {
      ...EMPTY, name: item.name, category: item.category, unit: item.unit, brand_model: item.brand_model ?? "", serial_number: item.serial_number ?? "",
      description: item.description ?? "", min_quantity: num(item.min_quantity), unit_cost: num(item.unit_cost), purchase_date: item.purchase_date ?? "",
      vendor: item.vendor ?? "", location: item.location, condition: item.condition, assigned_teacher_id: item.assigned_teacher_id ?? "", notes: item.notes ?? "",
    } : { ...EMPTY, o_date: todayISO() });
  }, [open, item]);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (f.name.trim().length < 2) return setError("Enter the item's name.");
    if (!f.category) return setError("Choose the category.");
    if (!f.location.trim()) return setError("Enter where the item is kept, e.g. Computer Lab or Store room.");
    if (f.min_quantity.trim()) { const m = checkQty(f.min_quantity, f.unit, "reorder level"); if (m) return setError(m); }
    if (f.unit_cost.trim() && !AMOUNT_PATTERN.test(f.unit_cost.trim())) return setError("Enter the cost in rupees, e.g. 450 or 450.50.");
    let opening: Record<string, unknown> | null = null;
    if (!editing && f.o_quantity.trim()) {
      const m = checkQty(f.o_quantity, f.unit, "quantity"); if (m) return setError(m);
      if (Number(f.o_quantity) <= 0) return setError("Enter a quantity greater than zero, or leave it empty.");
      if (!f.o_date) return setError("Enter the date of the stock.");
      if (f.o_cost.trim() && !AMOUNT_PATTERN.test(f.o_cost.trim())) return setError("Enter the cost per unit in rupees, e.g. 450.");
      opening = { quantity: f.o_quantity.trim(), reason: f.o_reason, moved_on: f.o_date, unit_cost: f.o_cost.trim() || null,
        vendor: f.o_vendor.trim() || null, reference: f.o_reference.trim() || null };
    }
    setBusy(true);
    const body: Record<string, unknown> = {
      name: f.name, category: f.category, unit: f.unit, brand_model: f.brand_model || null, serial_number: f.serial_number || null,
      description: f.description || null, min_quantity: f.min_quantity.trim() || null, location: f.location, condition: f.condition,
      assigned_teacher_id: f.assigned_teacher_id || null, notes: f.notes || null,
      ...(editing
        ? { unit_cost: f.unit_cost.trim() || null, purchase_date: f.purchase_date || null, vendor: f.vendor || null, is_active: item!.is_active }
        : { opening }),
    };
    try { onSaved(await apiFetch<Item>(editing ? `/inventory/items/${item!.id}` : "/inventory/items", { schoolId, method: editing ? "PUT" : "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" title={editing ? `Edit ${item!.name}` : "Add an item"} description={editing ? item!.item_code : undefined} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="item-form" loading={busy} data-testid="save-item">{editing ? "Save" : "Add item"}</Button></>}>
      <form id="item-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="item-error" /></div>
        <TextField className="sm:col-span-2" label="Item" required value={f.name} onChange={set("name")} maxLength={150} placeholder="e.g. Desktop computer, Student chair, A4 paper" data-testid="item-name" />
        <SelectField label="Category" value={f.category} onChange={set("category")} data-testid="item-category">
          <option value="">Choose…</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </SelectField>
        <SelectField label="Counted in" value={f.unit} onChange={set("unit")} disabled={editing && Number(item!.quantity) > 0} data-testid="item-unit">
          {UNITS.map((u) => <option key={u} value={u}>{qty(2, u).split(" ")[1]}</option>)}
        </SelectField>
        <div>
          <TextField label="Location" required value={f.location} onChange={set("location")} maxLength={100} list={listId} placeholder="e.g. Computer Lab" data-testid="item-location" />
          <datalist id={listId}>{locations.map((l) => <option key={l} value={l} />)}</datalist>
        </div>
        <SelectField label="Condition" value={f.condition} onChange={set("condition")} data-testid="item-condition">
          {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
        </SelectField>
        <SelectField label="Assigned to" value={f.assigned_teacher_id} onChange={set("assigned_teacher_id")} data-testid="item-assignee">
          <option value="">Nobody (school stock)</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.employee_id})</option>)}
          {item?.assigned_teacher_id && !staff.some((s) => s.id === item.assigned_teacher_id) && <option value={item.assigned_teacher_id}>{item.assigned_to} (inactive)</option>}
        </SelectField>
        <TextField label="Reorder level" inputMode="decimal" value={f.min_quantity} onChange={set("min_quantity")} data-testid="item-min" hint="Flag as low stock at or below this (optional)." />
        <TextField label="Brand / model" value={f.brand_model} onChange={set("brand_model")} maxLength={120} placeholder="e.g. Dell OptiPlex 3000" />
        <TextField label="Serial number" value={f.serial_number} onChange={set("serial_number")} maxLength={80} />
        {editing && <>
          <TextField label="Purchase date" type="date" value={f.purchase_date} onChange={set("purchase_date")} max={todayISO()} />
          <TextField label="Cost per unit (₹)" inputMode="decimal" value={f.unit_cost} onChange={set("unit_cost")} data-testid="item-cost" />
          <TextField label="Vendor" value={f.vendor} onChange={set("vendor")} maxLength={120} />
        </>}
        <div className="sm:col-span-2"><TextArea label="Description" value={f.description} onChange={(v) => setF((x) => ({ ...x, description: v }))} /></div>
        {!editing && (
          <fieldset className="grid gap-4 rounded-md bg-paper p-4 sm:col-span-2 sm:grid-cols-3">
            <legend className="px-1 text-sm font-medium">Stock now (optional)</legend>
            <TextField label={`Quantity (${qty(2, f.unit).split(" ")[1]})`} inputMode="decimal" value={f.o_quantity} onChange={set("o_quantity")} data-testid="opening-qty" />
            <SelectField label="How it came" value={f.o_reason} onChange={set("o_reason")} data-testid="opening-reason">
              <option value="purchase">Purchased</option>
              <option value="opening">Already in stock (opening)</option>
              <option value="donation">Donated</option>
            </SelectField>
            <TextField label="Date" type="date" value={f.o_date} onChange={set("o_date")} max={todayISO()} data-testid="opening-date" />
            <TextField label="Cost per unit (₹)" inputMode="decimal" value={f.o_cost} onChange={set("o_cost")} data-testid="opening-cost" />
            <TextField label="Vendor" value={f.o_vendor} onChange={set("o_vendor")} maxLength={120} data-testid="opening-vendor" />
            <TextField label="Bill / voucher no." value={f.o_reference} onChange={set("o_reference")} maxLength={60} />
            {f.o_quantity && f.o_cost && QTY.test(f.o_quantity) && AMOUNT_PATTERN.test(f.o_cost) && (
              <p className="text-sm text-muted sm:col-span-3">Total {formatINR(String(Number(f.o_quantity) * Number(f.o_cost)))}. The purchase date, cost and vendor are kept with the item.</p>
            )}
          </fieldset>
        )}
        <div className="sm:col-span-2"><TextArea label="Notes" value={f.notes} onChange={(v) => setF((x) => ({ ...x, notes: v }))} /></div>
        {editing && <p className="text-xs text-muted sm:col-span-2">Quantity changes only through Stock in / Stock out, so every change is in the history. Changes of location, condition and assignee are recorded too.</p>}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ stock in / out
export function StockModal({ schoolId, item, kind, onClose, onDone }: {
  schoolId: string; item: Item | null; kind: "in" | "out"; onClose: () => void; onDone: (i: Item) => void;
}) {
  const [reason, setReason] = useState("");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(todayISO());
  const [cost, setCost] = useState("");
  const [vendor, setVendor] = useState("");
  const [reference, setReference] = useState("");
  const [teacher, setTeacher] = useState("");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = useStaff(schoolId, item !== null && kind === "out");
  useEffect(() => {
    if (!item) return;
    setReason(kind === "in" ? "purchase" : "issued"); setQuantity(""); setDate(todayISO()); setCost(item.unit_cost ? num(item.unit_cost) : "");
    setVendor(item.vendor ?? ""); setReference(""); setTeacher(""); setRecipient(""); setNote(""); setError(null);
  }, [item, kind]);
  if (!item) return null;
  const n = Number(quantity);
  const valid = QTY.test(quantity.trim()) && n > 0;
  const after = valid ? Number(item.quantity) + (kind === "in" ? n : -n) : null;

  async function save() {
    setError(null);
    const m = checkQty(quantity, item!.unit, "quantity"); if (m) return setError(m);
    if (n <= 0) return setError("Enter a quantity greater than zero.");
    if (kind === "out" && n > Number(item!.quantity)) return setError(`Only ${qty(item!.quantity, item!.unit)} in stock.`);
    if (!date) return setError("Enter the date.");
    if (kind === "in" && cost.trim() && !AMOUNT_PATTERN.test(cost.trim())) return setError("Enter the cost per unit in rupees, e.g. 450.");
    if (kind === "out" && reason === "issued" && !teacher && !recipient.trim()) return setError("Choose the staff member, or say which class, room or event it went to.");
    setBusy(true);
    try {
      onDone(await apiFetch<Item>(`/inventory/items/${item!.id}/stock`, { schoolId, method: "POST", body: {
        kind, reason, quantity: quantity.trim(), moved_on: date, unit_cost: kind === "in" ? cost.trim() || null : null, vendor: kind === "in" ? vendor.trim() || null : null,
        reference: reference.trim() || null, teacher_id: teacher || null, recipient: recipient.trim() || null, note: note.trim() || null } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open title={kind === "in" ? `Stock in: ${item.name}` : `Stock out: ${item.name}`} description={`${item.item_code} · ${qty(item.quantity, item.unit)} in stock`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="confirm-stock">{kind === "in" ? "Add to stock" : "Take out of stock"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormError error={error} testId="stock-error" /></div>
        <SelectField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="stock-reason">
          {(kind === "in" ? IN_REASONS : OUT_REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>
        <TextField label={`Quantity (${qty(2, item.unit).split(" ")[1]})`} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus data-testid="stock-qty"
          hint={after !== null ? (after < 0 ? "More than is in stock." : `${qty(after, item.unit)} after this.`) : undefined} />
        <TextField label="Date" type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} data-testid="stock-date" />
        <TextField label={kind === "in" ? "Bill / voucher no." : "Issue slip no."} value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} data-testid="stock-reference" />
        {kind === "in" && <>
          <TextField label="Cost per unit (₹)" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} data-testid="stock-cost"
            hint={valid && cost && AMOUNT_PATTERN.test(cost) ? `Total ${formatINR(String(n * Number(cost)))}` : reason === "purchase" ? "Updates the item's cost and purchase date." : undefined} />
          <TextField label="Vendor / from" value={vendor} maxLength={120} onChange={(e) => setVendor(e.target.value)} data-testid="stock-vendor" />
        </>}
        {kind === "out" && <>
          <SelectField label={reason === "issued" ? "Issued to (staff)" : "Staff member (optional)"} value={teacher} onChange={(e) => setTeacher(e.target.value)} data-testid="stock-teacher">
            <option value="">—</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.employee_id})</option>)}
          </SelectField>
          <TextField label={reason === "issued" ? "Or class / room / event" : "Where or who (optional)"} value={recipient} maxLength={120} onChange={(e) => setRecipient(e.target.value)}
            placeholder="e.g. Class 5-A, Annual Day" data-testid="stock-recipient" />
        </>}
        <div className="sm:col-span-2"><TextArea label="Note (optional)" value={note} onChange={setNote} maxLength={300} /></div>
        <p className="text-xs text-muted sm:col-span-2">Stock history can&apos;t be edited. If something was entered wrongly, record an adjustment.</p>
      </div>
    </Modal>
  );
}
