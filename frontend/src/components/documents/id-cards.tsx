"use client";

import { clsx } from "clsx";
import { Ban, IdCard as IdCardIcon, Printer, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { CARD_STATUS_LABEL, type CardPeople, type CardStatus, type DocumentSettings, type HolderKind, type IdCard, type IdCardList } from "@/lib/documents";
import { formatDate, todayISO } from "@/lib/format";
import type { Paginated, Section } from "@/lib/types";
import { PdfActions, printPdf, RevokeModal, StatusPill } from "./shared";

const PAGE_SIZE = 100;
const EMPTY_HINT: Record<HolderKind, string> = {
  student: "Active students of the current session appear here.",
  teacher: "Active teaching staff appear here (Teachers page).",
  staff: "Active non-teaching staff (set as non-teaching on the Teachers page) and transport drivers and attendants appear here.",
};

/** Choose people and print their cards: a reprint reuses each valid card; "issue new cards" replaces them. */
export function PeopleTab({ schoolId, kind }: { schoolId: string; kind: HolderKind }) {
  const toast = useToast();
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [withoutCard, setWithoutCard] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CardPeople | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  useEffect(() => {
    if (kind !== "student") return;
    apiFetch<Paginated<Section>>("/sections", { schoolId, query: { page_size: 100, status: "active" } }).then((r) => setSections(r.items)).catch(() => setSections([]));
  }, [kind, schoolId]);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiFetch<CardPeople>("/id-cards/people", { schoolId, query: { kind, section_id: sectionId || undefined, q: term || undefined, without_card: withoutCard ? "true" : undefined, page, page_size: PAGE_SIZE } }));
    } catch (e) { setError(errorMessage(e)); }
  }, [schoolId, kind, sectionId, term, withoutCard, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [kind, sectionId, term, withoutCard, page]);
  const allOnPage = !!data && data.items.length > 0 && data.items.every((p) => selected.has(p.id));
  function toggle(id: string) { setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function toggleAll() { setSelected(allOnPage ? new Set() : new Set(data!.items.map((p) => p.id))); }

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className={clsx("grid gap-3 border-b border-line p-4", kind === "student" ? "sm:grid-cols-[1fr_2fr_auto]" : "sm:grid-cols-[2fr_auto]")}>
        {kind === "student" && (
          <SelectField label="Class and section" hideLabel value={sectionId} onChange={(e) => { setSectionId(e.target.value); setPage(1); }} data-testid="cards-section">
            <option value="">All classes</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.class_name} – {s.name}</option>)}
          </SelectField>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor={`people-search-${kind}`} className="sr-only">Search</label>
          <input id={`people-search-${kind}`} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === "student" ? "Name or student ID" : "Name or employee ID"} data-testid="people-search"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={withoutCard} onChange={(e) => { setWithoutCard(e.target.checked); setPage(1); }} className="size-4 accent-leaf-600" /> Without a card</label>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={IdCardIcon} title="No one here" message={term || sectionId || withoutCard ? "Nobody matches the filters." : EMPTY_HINT[kind]} /></div>
        : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-paper/60 px-4 py-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={allOnPage} onChange={toggleAll} className="size-4 accent-leaf-600" data-testid="select-all" /> Select all {data.items.length}</label>
              <span className="text-muted">{selected.size} selected</span>
              <Button size="sm" className="ml-auto" disabled={selected.size === 0} onClick={() => setPrinting(true)} data-testid="print-cards"><Printer className="size-4" /> Print cards</Button>
            </div>
            <ul className="divide-y divide-line" data-testid="people-list">
              {data.items.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm hover:bg-paper/50" data-testid={`person-${p.name}`}>
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="size-4 accent-leaf-600" aria-label={`Select ${p.name}`} />
                    <span className="min-w-0 flex-1 basis-48"><span className="font-medium">{p.name}</span> <span className="text-xs text-muted">{p.number ?? "number on first card"}{p.detail ? ` · ${p.detail}` : ""}</span></span>
                    {!p.has_photo && kind !== "staff" && <span className="text-xs text-muted">no photo</span>}
                    {p.card ? <StatusPill tone="ok" testId="person-card">Card {p.card.card_number} · until {formatDate(p.card.valid_until)}</StatusPill> : <StatusPill tone="muted" testId="person-card">No card</StatusPill>}
                  </label>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </>
        )}
      <PrintModal schoolId={schoolId} kind={kind} ids={[...selected]} withCards={data?.items.filter((p) => selected.has(p.id) && p.card).length ?? 0}
        open={printing} onClose={() => setPrinting(false)}
        onDone={(n) => { setPrinting(false); toast.success(`${n} card${n === 1 ? "" : "s"} ready to print.`); void load(); }} />
    </section>
  );
}

function PrintModal({ schoolId, kind, ids, withCards, open, onClose, onDone }: {
  schoolId: string; kind: HolderKind; ids: string[]; withCards: number; open: boolean; onClose: () => void; onDone: (n: number) => void;
}) {
  const [validUntil, setValidUntil] = useState("");
  const [replace, setReplace] = useState(false);
  const [back, setBack] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null); setReplace(false);
    apiFetch<DocumentSettings>("/document-settings", { schoolId }).then((s) => setValidUntil(s.default_card_valid_until ?? "")).catch(() => undefined);
  }, [open, schoolId]);
  async function go(mode: "print" | "download") {
    setBusy(true); setError(null);
    try {
      const { blob } = await apiFetchBlob("/id-cards/print", { schoolId, method: "POST", body: { kind, ids, valid_until: validUntil || null, replace, back } });
      const pdf = new Blob([blob], { type: "application/pdf" });
      if (mode === "download") saveBlob(pdf, `id-cards-${kind}-${todayISO()}.pdf`); else printPdf(pdf);
      onDone(ids.length);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} title={`Print ${ids.length} ID card${ids.length === 1 ? "" : "s"}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={() => go("download")} loading={busy} data-testid="cards-download">Download PDF</Button><Button onClick={() => go("print")} loading={busy} data-testid="cards-print">Print</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-danger-600" role="alert" data-testid="print-error">{error}</p>}
        <p className="text-muted">Standard ID-card size (85.6 × 54 mm), nine to an A4 sheet with cut marks. Each card has the photo, a QR code to check it, and the signature.</p>
        <TextField label="Valid until" type="date" min={todayISO()} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} hint="Used for new cards; a reprinted card keeps its date" data-testid="cards-valid-until" />
        <label className="flex items-start gap-2"><input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} className="mt-0.5 size-4 accent-leaf-600" />
          <span>Print the back too<span className="block text-xs text-muted">The school&apos;s address and note, on a second sheet arranged for double-sided printing (flip on the long edge).</span></span></label>
        {withCards > 0 && (
          <label className="flex items-start gap-2"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="mt-0.5 size-4 accent-leaf-600" data-testid="cards-replace" />
            <span>Issue new cards ({withCards} already {withCards === 1 ? "has" : "have"} a valid card)
              <span className="block text-xs text-muted">The old cards stop being valid — scanning them shows “replaced”. Leave this off to reprint the same cards.</span></span></label>
        )}
      </div>
    </Modal>
  );
}

const STATUSES: (CardStatus | "")[] = ["", "active", "expired", "replaced", "revoked"];

export function CardsTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [kind, setKind] = useState<HolderKind | "">("");
  const [st, setSt] = useState<CardStatus | "">("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<IdCardList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<IdCard | null>(null);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<IdCardList>("/id-cards", { schoolId, query: { kind: kind || undefined, status: st || undefined, q: term || undefined, page, page_size: 25 } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, kind, st, term, page]);
  useEffect(() => { void load(); }, [load]);
  const tone = useMemo(() => ({ active: "ok", expired: "warn", replaced: "muted", revoked: "bad" }) as const, []);
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_1fr_2fr]">
        <SelectField label="Who" hideLabel value={kind} onChange={(e) => { setKind(e.target.value as HolderKind | ""); setPage(1); }}>
          <option value="">Everyone</option><option value="student">Students</option><option value="teacher">Teachers</option><option value="staff">Staff</option>
        </SelectField>
        <SelectField label="Status" hideLabel value={st} onChange={(e) => { setSt(e.target.value as CardStatus | ""); setPage(1); }} data-testid="cards-status">
          {STATUSES.map((s) => <option key={s} value={s}>{s ? CARD_STATUS_LABEL[s] : "Any status"}</option>)}
        </SelectField>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="card-search" className="sr-only">Search cards</label>
          <input id="card-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or card number"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={IdCardIcon} title="No cards" message={term || kind || st ? "Nothing matches the filters." : "Cards appear here once printed from the Students, Teachers or Staff tab."} /></div>
        : (
          <>
            <ul className="divide-y divide-line" data-testid="card-list">
              {data.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`card-${c.card_number}-${c.status}`}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p><span className="font-medium">{c.holder_name}</span> <span className="text-xs text-muted">{c.kind_label} · {c.card_number}{c.detail ? ` · ${c.detail}` : ""}</span></p>
                    <p className="text-xs text-muted">Issued {formatDate(c.issued_on)} · valid until {formatDate(c.valid_until)}{c.revoke_reason ? ` · revoked: ${c.revoke_reason}` : ""}</p>
                  </div>
                  <StatusPill tone={tone[c.status]}>{CARD_STATUS_LABEL[c.status]}</StatusPill>
                  <span className="ml-auto inline-flex gap-1">
                    <PdfActions label={`ID card of ${c.holder_name}`} fileName={`id-card-${c.card_number}.pdf`}
                      fetchPdf={async () => (await apiFetchBlob(`/id-cards/${c.id}/card.pdf`, { schoolId, query: { back: "true" } })).blob} />
                    {(c.status === "active" || c.status === "expired") && (
                      <Button variant="ghost" size="sm" onClick={() => setRevoking(c)} aria-label={`Revoke card of ${c.holder_name}`} data-testid="revoke-card"><Ban className="size-4 text-danger-600" /></Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={25} total={data.total} onChange={setPage} />
          </>
        )}
      <RevokeModal open={!!revoking} title={`Revoke the card of ${revoking?.holder_name ?? ""}`}
        message="Scanning this card will show it as revoked (e.g. lost or stolen). Print a new card from the Students, Teachers or Staff tab."
        onClose={() => setRevoking(null)}
        onRevoke={async (reason) => {
          await apiFetch(`/id-cards/${revoking!.id}/revoke`, { schoolId, method: "POST", body: { reason } });
          toast.success("Card revoked."); setRevoking(null); void load();
        }} />
    </section>
  );
}
