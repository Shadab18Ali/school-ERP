"use client";

import { clsx } from "clsx";
import { Download, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { errorMessage, saveBlob } from "@/lib/api";

/** Opens a PDF in the browser's print dialog (hidden frame), falling back to a new tab. */
export function printPdf(blob: Blob) {
  const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
  const frame = document.createElement("iframe");
  Object.assign(frame.style, { position: "fixed", width: "0", height: "0", border: "0" });
  frame.src = url;
  frame.onload = () => {
    try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { window.open(url, "_blank"); }
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
  };
  document.body.appendChild(frame);
}

/** Download / Print buttons for a PDF the API builds on request. */
export function PdfActions({ fetchPdf, fileName, label, size = "sm" }: {
  fetchPdf: () => Promise<Blob>; fileName: string; label: string; size?: "sm" | "md";
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"download" | "print" | null>(null);
  async function run(kind: "download" | "print") {
    setBusy(kind);
    try {
      const blob = new Blob([await fetchPdf()], { type: "application/pdf" });
      if (kind === "download") saveBlob(blob, fileName); else printPdf(blob);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  return (
    <span className="inline-flex gap-1">
      <Button variant="secondary" size={size} onClick={() => run("download")} loading={busy === "download"} aria-label={`Download ${label}`} data-testid="pdf-download">
        <Download className="size-4" />{size === "md" && " Download PDF"}
      </Button>
      <Button variant="secondary" size={size} onClick={() => run("print")} loading={busy === "print"} aria-label={`Print ${label}`}>
        <Printer className="size-4" />{size === "md" && " Print"}
      </Button>
    </span>
  );
}

export function StatusPill({ tone, children, testId }: { tone: "ok" | "bad" | "muted" | "warn"; children: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
      tone === "ok" ? "bg-leaf-50 text-leaf-700" : tone === "bad" ? "bg-danger-50 text-danger-600" : tone === "warn" ? "bg-pencil-100 text-ink" : "bg-paper text-muted")}>
      {children}
    </span>
  );
}

/** Asks for the reason, then calls `onRevoke`. */
export function RevokeModal({ open, title, message, onClose, onRevoke }: {
  open: boolean; title: string; message: string; onClose: () => void; onRevoke: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(""); setError(null); } }, [open]);
  async function go() {
    if (reason.trim().length < 3) { setError("Give the reason (at least 3 characters)."); return; }
    setBusy(true); setError(null);
    try { await onRevoke(reason.trim()); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} title={title} onClose={busy ? () => {} : onClose} size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={go} loading={busy} data-testid="confirm-revoke">Revoke</Button></>}>
      <p className="text-sm text-muted">{message}</p>
      <label className="mt-3 block text-sm font-medium">Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} data-testid="revoke-reason"
          className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
      </label>
      {error && <p className="mt-2 text-sm text-danger-600" role="alert">{error}</p>}
    </Modal>
  );
}

/** The certificate's title and wording as they will be printed (a quick on-screen look; the PDF is the real thing). */
export function CertificatePaper({ title, body, number, testId }: { title: string; body: string; number?: string; testId?: string }) {
  return (
    <div className="rounded-md border-4 border-double border-leaf-600/60 bg-white px-5 py-6 sm:px-8" data-testid={testId}>
      {number && <p className="text-xs text-muted">No.: <span className="font-medium text-ink">{number}</span></p>}
      <p className="mt-2 text-center text-lg font-bold uppercase tracking-wide underline decoration-leaf-600 underline-offset-4">{title}</p>
      <div className="mt-4 space-y-3 text-sm leading-7 text-ink">
        {body.split(/\n\s*\n/).map((p, i) => <p key={i} className="whitespace-pre-line text-justify">{p}</p>)}
      </div>
    </div>
  );
}
