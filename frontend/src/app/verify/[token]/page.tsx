"use client";

import { clsx } from "clsx";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { use, useEffect, useState } from "react";
import type { VerifiedDocument } from "@/lib/documents";
import { formatDate } from "@/lib/format";
import { publicFetch } from "@/lib/public-api";

const KIND: Record<string, string> = {
  bonafide: "Bonafide certificate", character: "Character certificate", transfer: "Transfer certificate", study: "Study certificate", custom: "Certificate",
  student: "Student ID card", teacher: "Teacher ID card", staff: "Staff ID card",
};

const VERDICT: Record<VerifiedDocument["status"], { tone: "ok" | "bad" | "warn"; title: string; text: (d: VerifiedDocument) => string }> = {
  valid: { tone: "ok", title: "Genuine and valid", text: (d) => `This ${d.type === "certificate" ? "certificate was issued" : "card was issued"} by ${d.school}.` },
  revoked: { tone: "bad", title: "Revoked", text: (d) => `${d.school} has withdrawn this ${d.type === "certificate" ? "certificate" : "card"}${d.revoked_on ? ` (on ${formatDate(d.revoked_on)})` : ""}. It is no longer valid.` },
  replaced: { tone: "warn", title: "Replaced", text: (d) => `A newer card has been issued to this person by ${d.school}. This card is no longer valid.` },
  expired: { tone: "warn", title: "Expired", text: (d) => `This card was issued by ${d.school} but its validity ended on ${formatDate(d.valid_until)}.` },
};

/** Public page opened by the QR code on a certificate or ID card. No login; shows only what is needed to confirm it. */
export default function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [doc, setDoc] = useState<VerifiedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicFetch<VerifiedDocument>(`/public/verify/${encodeURIComponent(token)}`).then(setDoc).catch((e: Error) => setError(e.message));
  }, [token]);
  const v = doc ? VERDICT[doc.status] : null;
  const Icon = v?.tone === "ok" ? CircleCheck : v?.tone === "bad" ? CircleX : CircleAlert;
  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-lg">
        <p className="mb-4 text-center text-sm font-medium text-muted">Document verification</p>
        {error ? (
          <section className="rounded-lg border border-danger-600/30 bg-white p-6 text-center" role="alert" data-testid="verify-result">
            <CircleX className="mx-auto size-10 text-danger-600" aria-hidden />
            <h1 className="mt-3 text-lg font-semibold">Not found</h1>
            <p className="mt-1 text-sm text-muted">{error}</p>
          </section>
        ) : !doc || !v ? <p className="text-center text-sm text-muted">Checking…</p> : (
          <section className="overflow-hidden rounded-lg border border-line bg-white" data-testid="verify-result">
            <div className={clsx("flex items-center gap-3 px-5 py-4", v.tone === "ok" ? "bg-leaf-50" : v.tone === "bad" ? "bg-danger-50" : "bg-pencil-100")}>
              <Icon className={clsx("size-9 shrink-0", v.tone === "ok" ? "text-leaf-700" : v.tone === "bad" ? "text-danger-600" : "text-ink")} aria-hidden />
              <div>
                <h1 className="text-lg font-semibold" data-testid="verify-status">{v.title}</h1>
                <p className="text-sm">{v.text(doc)}</p>
              </div>
            </div>
            <dl className="divide-y divide-line px-5 text-sm">
              <Row label="Document" value={doc.title ?? KIND[doc.kind] ?? "Document"} />
              <Row label={doc.type === "certificate" ? "Certificate no." : "Card no."} value={doc.number} />
              <Row label="Name" value={doc.name} testId="verify-name" />
              {doc.detail && <Row label={doc.type === "certificate" || doc.kind === "student" ? "Class" : "Post"} value={doc.detail} />}
              <Row label="Issued on" value={formatDate(doc.issued_on)} />
              {doc.valid_until && <Row label="Valid until" value={formatDate(doc.valid_until)} />}
              <Row label="Issued by" value={[doc.school, doc.city].filter(Boolean).join(", ")} />
            </dl>
            <p className="border-t border-line px-5 py-3 text-xs text-muted">Check that these details match the document in front of you. For anything else, contact the school.</p>
          </section>
        )}
      </div>
    </main>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex gap-4 py-2.5">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 font-medium" data-testid={testId}>{value}</dd>
    </div>
  );
}
