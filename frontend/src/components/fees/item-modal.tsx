"use client";

import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import { AMOUNT_PATTERN, MONTH_NAMES } from "@/lib/money";
import { FREQUENCY_LABELS, type FeeFrequency, type FeeHead, type FeeItem, type FeeStructureDetail } from "@/lib/types";

interface Props {
  open: boolean;
  schoolId: string;
  structureId: string;
  item: FeeItem | null; // null = add
  heads: FeeHead[];
  usedHeadIds: string[];
  months: number[]; // calendar months of the session, in order
  onClose: () => void;
  onSaved: (d: FeeStructureDetail) => void;
  onNewHead: (name: string) => Promise<FeeHead>;
}

export function FeeItemModal({ open, schoolId, structureId, item, heads, usedHeadIds, months, onClose, onSaved, onNewHead }: Props) {
  const [headId, setHeadId] = useState("");
  const [newHead, setNewHead] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<FeeFrequency>("monthly");
  const [optional, setOptional] = useState(false);
  const [billing, setBilling] = useState<number[]>([]);
  const [dueMonth, setDueMonth] = useState<number>(months[0] ?? 4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = heads.filter((h) => h.is_active && (!usedHeadIds.includes(h.id) || h.id === item?.fee_head_id));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewHead("");
    setHeadId(item?.fee_head_id ?? available[0]?.id ?? "__new");
    setAmount(item ? String(Number(item.amount)) : "");
    setFrequency(item?.frequency ?? "monthly");
    setOptional(item?.is_optional ?? false);
    setBilling(item?.billing_months ?? months);
    setDueMonth(item?.due_month ?? months[0] ?? 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);

  async function save() {
    if (!AMOUNT_PATTERN.test(amount.trim()) || Number(amount) <= 0) return setError("Enter an amount in rupees, e.g. 1500 or 1500.50.");
    if (frequency === "monthly" && billing.length === 0) return setError("Choose at least one month.");
    if (headId === "__new" && newHead.trim().length < 2) return setError("Enter a name for the new fee head.");
    setBusy(true);
    setError(null);
    try {
      const head = headId === "__new" ? (await onNewHead(newHead.trim())).id : headId;
      const allMonths = billing.length === months.length;
      const body = {
        fee_head_id: head,
        amount: amount.trim(),
        frequency,
        is_optional: optional,
        billing_months: frequency === "monthly" && !allMonths ? billing : null,
        due_month: frequency === "monthly" ? null : dueMonth,
      };
      const d = item
        ? await apiFetch<FeeStructureDetail>(`/fee-structures/${structureId}/items/${item.id}`, { method: "PATCH", schoolId, body })
        : await apiFetch<FeeStructureDetail>(`/fee-structures/${structureId}/items`, { method: "POST", schoolId, body });
      onSaved(d);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={item ? `Edit ${item.fee_head_name}` : "Add fee item"}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={save} loading={busy} data-testid="save-fee-item">{item ? "Save" : "Add item"}</Button>
      </>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="item-error">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Fee head" value={headId} onChange={(e) => setHeadId(e.target.value)}>
            {available.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            <option value="__new">+ New fee head…</option>
          </SelectField>
          {headId === "__new" ? (
            <TextField label="New fee head name" maxLength={60} value={newHead} onChange={(e) => setNewHead(e.target.value)} />
          ) : <div className="hidden sm:block" />}
          <TextField label="Amount (₹)" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <SelectField label="Frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as FeeFrequency)}>
            {(Object.keys(FREQUENCY_LABELS) as FeeFrequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
          </SelectField>
        </div>

        {frequency === "monthly" ? (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Billed in</legend>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Billed months">
              {months.map((m) => {
                const on = billing.includes(m);
                return (
                  <button key={m} type="button" aria-pressed={on}
                    onClick={() => setBilling((b) => (on ? b.filter((x) => x !== m) : [...b, m]))}
                    className={clsx("h-8 w-12 rounded-md border text-xs font-medium",
                      on ? "border-leaf-600 bg-leaf-600 text-white" : "border-line bg-white text-muted hover:bg-paper")}>
                    {MONTH_NAMES[m - 1]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted">Untick months with no charge, e.g. summer vacation for transport.</p>
          </fieldset>
        ) : (
          <SelectField label={frequency === "quarterly" || frequency === "half_yearly" ? "First due in" : "Due in"}
            value={String(dueMonth)} onChange={(e) => setDueMonth(Number(e.target.value))} className="sm:max-w-xs">
            {months.map((m) => <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>)}
          </SelectField>
        )}

        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-leaf-600)]" checked={optional} onChange={(e) => setOptional(e.target.checked)} />
          <span>Optional fee<span className="block text-xs text-muted">Charged only to students who opt in (e.g. transport). Shown separately from compulsory totals.</span></span>
        </label>
      </div>
    </Modal>
  );
}
