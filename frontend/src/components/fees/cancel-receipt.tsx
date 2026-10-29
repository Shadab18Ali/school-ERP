"use client";

import { Undo2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

/**
 * Reverses a receipt recorded at the desk (school admins only; accountants record receipts but can't
 * make one disappear). The receipt stays on record, marked cancelled with the reason, and its dues
 * become payable again. Receipts paid online are reversed by refunding them instead.
 */
export function CancelReceipt({ paymentId, receiptNumber, amount, schoolId, mode, cancelled, onDone }: {
  paymentId: string; receiptNumber: string; amount: string; schoolId: string; mode: string; cancelled: boolean; onDone: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setReason(""); setError(null); } }, [open]);
  if (!can("fees:cancel") || cancelled || mode === "online") return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) return setError("Give the reason for cancelling (at least 5 characters).");
    setSaving(true); setError(null);
    try {
      await apiFetch(`/fee-payments/${paymentId}/cancel`, { method: "POST", schoolId, body: { reason: reason.trim() } });
      toast.success(`Receipt ${receiptNumber} cancelled. Its fees are due again.`);
      setOpen(false);
      onDone();
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label={`Cancel receipt ${receiptNumber}`} data-testid="cancel-receipt">
        <Undo2 className="size-4" />
      </Button>
      <Modal open={open} onClose={saving ? () => {} : () => setOpen(false)} size="sm" title={`Cancel receipt ${receiptNumber}?`}
        description={`${formatINR(amount)} will no longer count as paid, and the fees it paid become due again. The receipt stays on record, marked cancelled. This is recorded in the audit log.`}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Back</Button>
          <Button type="submit" form="cancel-receipt-form" variant="danger" loading={saving} data-testid="confirm-cancel-receipt">Cancel receipt</Button></>}>
        <form id="cancel-receipt-form" onSubmit={submit} className="space-y-3" noValidate>
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="cancel-receipt-error">{error}</p>}
          <label className="block text-sm font-medium">
            Reason
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} data-testid="cancel-receipt-reason"
              placeholder="e.g. Entered against the wrong student"
              className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </label>
        </form>
      </Modal>
    </>
  );
}
