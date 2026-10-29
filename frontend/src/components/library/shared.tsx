"use client";

import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import {
  CONDITION_LABEL, COPY_STATUS_LABEL, COPY_STATUS_TONE, FINE_STATUS_LABEL, MODE_LABEL,
  type CopyStatus, type FineStatus, type Loan, type PaymentMode, type ReturnCondition,
} from "@/lib/library";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

export function CopyPill({ status }: { status: CopyStatus }) {
  return <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", COPY_STATUS_TONE[status])} data-testid="copy-status">{COPY_STATUS_LABEL[status]}</span>;
}

export function FinePill({ status }: { status: FineStatus }) {
  if (status === "none") return null;
  const tone = status === "unpaid" ? "bg-danger-50 text-danger-600" : status === "paid" ? "bg-leaf-50 text-leaf-700" : "bg-ink/5 text-muted";
  return <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", tone)} data-testid="fine-status">Fine {FINE_STATUS_LABEL[status].toLowerCase()}</span>;
}

/** "Due 12 Oct 2026" / "3 days overdue" / "Returned 10 Oct 2026". */
export function DueText({ l }: { l: Loan }) {
  if (!l.is_open) {
    return <span>Returned {formatDate(l.returned_on)}{l.return_condition && l.return_condition !== "good" ? ` · ${CONDITION_LABEL[l.return_condition].toLowerCase()}` : ""}{l.days_overdue > 0 ? ` · ${l.days_overdue} day${l.days_overdue === 1 ? "" : "s"} late` : ""}</span>;
  }
  if (l.is_overdue) return <span className="font-medium text-danger-600" data-testid="overdue">{l.days_overdue} day{l.days_overdue === 1 ? "" : "s"} overdue (due {formatDate(l.due_date)})</span>;
  return <span>Due {formatDate(l.due_date)}</span>;
}

/** The money side of a loan: fine so far (open), or the settled/unsettled amounts. */
export function MoneyText({ l }: { l: Loan }) {
  const due = Number(l.amount_due);
  if (l.is_open) return due > 0 ? <span className="text-danger-600" data-testid="fine-so-far">Fine so far {formatINR(l.amount_due)}</span> : null;
  const total = Number(l.fine_amount) + Number(l.book_charge);
  if (total === 0) return null;
  const parts = [Number(l.fine_amount) > 0 ? `fine ${formatINR(l.fine_amount)}` : null, Number(l.book_charge) > 0 ? `book ${formatINR(l.book_charge)}` : null].filter(Boolean).join(" + ");
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={l.fine_status === "unpaid" ? "font-medium text-danger-600" : "text-muted"}>{formatINR(String(total))} ({parts})</span>
      <FinePill status={l.fine_status} />
      {l.fine_receipt_number && <span className="text-xs text-muted">{l.fine_receipt_number}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ actions on a loan
export function ReturnModal({ schoolId, loan, onClose, onDone }: { schoolId: string; loan: Loan | null; onClose: () => void; onDone: (l: Loan) => void }) {
  const [condition, setCondition] = useState<ReturnCondition>("good");
  const [charge, setCharge] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCondition("good"); setCharge(""); setNote(""); setError(null); }, [loan]);
  if (!loan) return null;
  async function go() {
    setError(null);
    if (charge && !/^\d{1,7}(\.\d{1,2})?$/.test(charge.trim())) return setError("Enter the charge in rupees, e.g. 250 or 250.50.");
    setBusy(true);
    try {
      onDone(await apiFetch<Loan>(`/library/loans/${loan!.id}/return`, { schoolId, method: "POST",
        body: { condition, charge: condition === "good" ? null : charge.trim() || null, note: note.trim() || null } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`Return “${loan.title}”`} description={`${loan.accession_number} · ${loan.borrower_name}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} data-testid="confirm-return">Return book</Button></>}>
      <div className="space-y-4 text-sm">
        <p><DueText l={loan} />{Number(loan.amount_due) > 0 && <> · <b data-testid="return-fine">fine {formatINR(loan.amount_due)}</b></>}</p>
        <fieldset>
          <legend className="mb-1.5 font-medium">Condition</legend>
          <div className="flex gap-4">
            {(["good", "damaged", "lost"] as ReturnCondition[]).map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input type="radio" name="condition" className="accent-leaf-600" checked={condition === c} onChange={() => setCondition(c)} data-testid={`condition-${c}`} />
                {CONDITION_LABEL[c]}
              </label>
            ))}
          </div>
        </fieldset>
        {condition !== "good" && (
          <TextField label={condition === "lost" ? "Charge for the lost book (₹)" : "Charge for the damage (₹, optional)"} inputMode="decimal" value={charge}
            onChange={(e) => setCharge(e.target.value)} data-testid="return-charge"
            hint={condition === "lost" ? "Leave empty to charge the copy's recorded price." : "Leave empty for no charge. The copy is marked damaged."} />
        )}
        <TextField label="Note (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="text-danger-600" role="alert" data-testid="return-error">{error}</p>}
      </div>
    </Modal>
  );
}

export function CollectModal({ schoolId, loan, onClose, onDone }: { schoolId: string; loan: Loan | null; onClose: () => void; onDone: (l: Loan) => void }) {
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMode("cash"); setReference(""); setError(null); }, [loan]);
  if (!loan) return null;
  async function go() {
    setError(null);
    if (mode !== "cash" && !reference.trim()) return setError("Enter the transaction or cheque reference.");
    setBusy(true);
    try { onDone(await apiFetch<Loan>(`/library/loans/${loan!.id}/collect`, { schoolId, method: "POST", body: { mode, reference: reference.trim() || null } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`Collect ${formatINR(loan.amount_due)}`} description={`${loan.borrower_name} · “${loan.title}”`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} data-testid="confirm-collect">Record payment</Button></>}>
      <div className="space-y-4 text-sm">
        <p><MoneyText l={loan} /></p>
        <SelectField label="Paid by" value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)} data-testid="collect-mode">
          {(Object.keys(MODE_LABEL) as PaymentMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </SelectField>
        {mode !== "cash" && <TextField label="Reference" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} placeholder="UPI / transaction / cheque no." data-testid="collect-reference" />}
        {error && <p className="text-danger-600" role="alert" data-testid="collect-error">{error}</p>}
      </div>
    </Modal>
  );
}

export function WaiveModal({ schoolId, loan, onClose, onDone }: { schoolId: string; loan: Loan | null; onClose: () => void; onDone: (l: Loan) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); setError(null); }, [loan]);
  if (!loan) return null;
  async function go() {
    if (reason.trim().length < 3) return setError("Give the reason for waiving the fine.");
    setBusy(true); setError(null);
    try { onDone(await apiFetch<Loan>(`/library/loans/${loan!.id}/waive`, { schoolId, method: "POST", body: { reason: reason.trim() } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`Waive ${formatINR(loan.amount_due)}?`} description={`${loan.borrower_name} · “${loan.title}”`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={go} loading={busy} data-testid="confirm-waive">Waive</Button></>}>
      <div className="space-y-3 text-sm">
        <p>Nothing will be collected. The reason is kept with the loan.</p>
        <TextField label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="waive-reason" />
        {error && <p className="text-danger-600" role="alert" data-testid="waive-error">{error}</p>}
      </div>
    </Modal>
  );
}

/** Return / Renew / Collect / Waive buttons for one loan, depending on what the user may do. */
export function LoanActions({ schoolId, loan, onChange, size = "sm" }: { schoolId: string; loan: Loan; onChange: (l: Loan) => void; size?: "sm" | "md" }) {
  const { can } = useAuth();
  const toast = useToast();
  const [modal, setModal] = useState<"return" | "collect" | "waive" | null>(null);
  const [busy, setBusy] = useState(false);
  async function renew() {
    setBusy(true);
    try { const l = await apiFetch<Loan>(`/library/loans/${loan.id}/renew`, { schoolId, method: "POST" }); onChange(l); toast.success(`Renewed: now due ${formatDate(l.due_date)}.`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const manage = can("library:manage");
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {loan.is_open && manage && <Button size={size} onClick={() => setModal("return")} data-testid="loan-return">Return</Button>}
      {loan.is_open && manage && !loan.is_overdue && <Button size={size} variant="secondary" loading={busy} onClick={renew} data-testid="loan-renew">Renew</Button>}
      {!loan.is_open && loan.fine_status === "unpaid" && can("library:fines") && (
        <Button size={size} onClick={() => setModal("collect")} data-testid="loan-collect">Collect {formatINR(loan.amount_due)}</Button>
      )}
      {!loan.is_open && loan.fine_status === "unpaid" && can("settings:manage") && (
        <Button size={size} variant="ghost" onClick={() => setModal("waive")} data-testid="loan-waive">Waive</Button>
      )}
      <ReturnModal schoolId={schoolId} loan={modal === "return" ? loan : null} onClose={() => setModal(null)}
        onDone={(l) => { setModal(null); onChange(l); toast.success(l.fine_status === "unpaid" ? `Returned. ${formatINR(l.amount_due)} to pay.` : "Returned."); }} />
      <CollectModal schoolId={schoolId} loan={modal === "collect" ? loan : null} onClose={() => setModal(null)}
        onDone={(l) => { setModal(null); onChange(l); toast.success(`Payment recorded: receipt ${l.fine_receipt_number}.`); }} />
      <WaiveModal schoolId={schoolId} loan={modal === "waive" ? loan : null} onClose={() => setModal(null)}
        onDone={(l) => { setModal(null); onChange(l); toast.success("Fine waived."); }} />
    </span>
  );
}
