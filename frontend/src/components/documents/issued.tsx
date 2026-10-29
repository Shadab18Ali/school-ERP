"use client";

import { Ban, Download, Eye, FileBadge, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { CERTIFICATE_KINDS, KIND_LABEL, type Certificate, type CertificateKind, type CertificateList } from "@/lib/documents";
import { formatDate, formatDateTime } from "@/lib/format";
import { CertificatePaper, PdfActions, RevokeModal, StatusPill } from "./shared";

const PAGE_SIZE = 25;

export function IssuedTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [kind, setKind] = useState<CertificateKind | "">("");
  const [st, setSt] = useState<"" | "issued" | "revoked">("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CertificateList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Certificate | null>(null);
  const [revoking, setRevoking] = useState<Certificate | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const query = { kind: kind || undefined, status: st || undefined, q: term || undefined };
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<CertificateList>("/certificates", { schoolId, query: { kind: kind || undefined, status: st || undefined, q: term || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, kind, st, term, page]);
  useEffect(() => { void load(); }, [load]);
  async function csv() {
    setDownloading(true);
    try { const { blob } = await apiFetchBlob("/certificates", { schoolId, query: { ...query, format: "csv" } }); saveBlob(blob, "certificates.csv"); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDownloading(false); }
  }
  const pdf = (c: Certificate) => async () => (await apiFetchBlob(`/certificates/${c.id}/certificate.pdf`, { schoolId })).blob;

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_1fr_2fr_auto]">
        <SelectField label="Type" hideLabel value={kind} onChange={(e) => { setKind(e.target.value as CertificateKind | ""); setPage(1); }} data-testid="issued-kind">
          <option value="">All types</option>
          {CERTIFICATE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </SelectField>
        <SelectField label="Status" hideLabel value={st} onChange={(e) => { setSt(e.target.value as "" | "issued" | "revoked"); setPage(1); }}>
          <option value="">Valid and revoked</option>
          <option value="issued">Valid</option>
          <option value="revoked">Revoked</option>
        </SelectField>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="cert-search" className="sr-only">Search certificates</label>
          <input id="cert-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Student, student ID or number (TC-2026-0001)" data-testid="issued-search"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <Button variant="secondary" onClick={csv} loading={downloading} aria-label="Download CSV"><Download className="size-4" /> CSV</Button>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={FileBadge} title="No certificates" message={term || kind || st ? "Nothing matches the filters." : "Certificates you issue are listed here."} /></div>
        : (
          <>
            <ul className="divide-y divide-line" data-testid="certificate-list">
              {data.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm" data-testid={`certificate-${c.certificate_number}`}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p><span className="font-medium">{c.certificate_number}</span> <span className="text-muted">· {c.title}</span></p>
                    <p className="text-xs text-muted">
                      <Link href={`/students/${c.student_id}`} className="hover:underline">{c.student_name}</Link> ({c.student_code}){c.class_section ? ` · ${c.class_section}` : ""}
                      {c.purpose ? ` · for ${c.purpose}` : ""} · {formatDate(c.issued_on)}
                    </p>
                    {c.status === "revoked" && <p className="text-xs text-danger-600">Revoked {formatDateTime(c.revoked_at)}: {c.revoke_reason}</p>}
                  </div>
                  <StatusPill tone={c.status === "issued" ? "ok" : "bad"} testId="certificate-status">{c.status === "issued" ? "Valid" : "Revoked"}</StatusPill>
                  <span className="ml-auto inline-flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setViewing(c)} aria-label={`View ${c.certificate_number}`}><Eye className="size-4" /></Button>
                    <PdfActions label={`certificate ${c.certificate_number}`} fileName={`${c.certificate_number}.pdf`} fetchPdf={pdf(c)} />
                    {c.status === "issued" && <Button variant="ghost" size="sm" onClick={() => setRevoking(c)} aria-label={`Revoke ${c.certificate_number}`} data-testid="revoke-certificate"><Ban className="size-4 text-danger-600" /></Button>}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </>
        )}
      <Modal open={!!viewing} size="lg" onClose={() => setViewing(null)} title={viewing ? `${viewing.certificate_number} · ${viewing.student_name}` : ""}
        footer={viewing && <PdfActions size="md" label={`certificate ${viewing.certificate_number}`} fileName={`${viewing.certificate_number}.pdf`} fetchPdf={pdf(viewing)} />}>
        {viewing && (
          <div className="space-y-3">
            <CertificatePaper title={viewing.title} body={viewing.body} number={viewing.certificate_number} />
            <p className="text-xs text-muted">
              Issued {formatDate(viewing.issued_on)}{viewing.issued_by_name ? ` by ${viewing.issued_by_name}` : ""} · signed as {viewing.signatory_name ? `${viewing.signatory_name}, ` : ""}{viewing.signatory_title}.
              {" "}Verification page: <a href={viewing.verify_url} target="_blank" rel="noreferrer" className="underline">open</a>
            </p>
          </div>
        )}
      </Modal>
      <RevokeModal open={!!revoking} title={`Revoke ${revoking?.certificate_number ?? ""}`}
        message="The certificate stays on record, but scanning its QR code will show it as revoked and its PDF is marked REVOKED. This can't be undone."
        onClose={() => setRevoking(null)}
        onRevoke={async (reason) => {
          const c = await apiFetch<Certificate>(`/certificates/${revoking!.id}/revoke`, { schoolId, method: "POST", body: { reason } });
          toast.success(`${c.certificate_number} revoked.`); setRevoking(null); void load();
        }} />
    </section>
  );
}
