"use client";

import { Download, Printer } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";

/** Download or print a receipt PDF. The PDF comes through the API with the user's token. */
export function ReceiptActions({ paymentId, receiptNumber, schoolId, size = "md", path }: {
  paymentId: string; receiptNumber: string; schoolId: string; size?: "sm" | "md";
  path?: string; // parents download through the portal endpoint
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"download" | "print" | null>(null);
  const fileName = `receipt-${receiptNumber.replaceAll("/", "-")}.pdf`;

  async function fetchPdf() {
    const { blob } = await apiFetchBlob(path ?? `/fee-payments/${paymentId}/receipt.pdf`, { schoolId });
    return new Blob([blob], { type: "application/pdf" });
  }

  async function download() {
    setBusy("download");
    try { saveBlob(await fetchPdf(), fileName); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }

  async function print() {
    setBusy("print");
    try {
      const url = URL.createObjectURL(await fetchPdf());
      const frame = document.createElement("iframe");
      frame.style.position = "fixed";
      frame.style.width = "0";
      frame.style.height = "0";
      frame.style.border = "0";
      frame.src = url;
      frame.onload = () => {
        try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { window.open(url, "_blank"); }
        setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
      };
      document.body.appendChild(frame);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="inline-flex gap-1">
      <Button variant="secondary" size={size} onClick={download} loading={busy === "download"} aria-label={`Download receipt ${receiptNumber}`}>
        <Download className="size-4" />{size === "md" && " Download PDF"}
      </Button>
      <Button variant="secondary" size={size} onClick={print} loading={busy === "print"} aria-label={`Print receipt ${receiptNumber}`}>
        <Printer className="size-4" />{size === "md" && " Print"}
      </Button>
    </span>
  );
}
