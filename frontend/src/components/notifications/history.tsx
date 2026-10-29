"use client";

import { clsx } from "clsx";
import { History, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import {
  CHANNEL_LABEL, DELIVERY_LABEL, DELIVERY_TONE, EVENT_STATUS_LABEL, countsByChannel, timeAgo,
  type Delivery, type EventInfo, type HistoryDetail, type HistoryItem,
} from "@/lib/notifications";
import type { ClassList } from "@/lib/types";

const PAGE_SIZE = 25;

export function DeliveryPill({ status }: { status: Delivery["status"] }) {
  return <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", DELIVERY_TONE[status])}>{DELIVERY_LABEL[status]}</span>;
}

/** Staff (admins, accountants): queue today's reminders for students with overdue fees. */
export function FeeRemindersButton({ schoolId, onSent, variant = "secondary" }: { schoolId: string; onSent?: () => void; variant?: "primary" | "secondary" }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [classes, setClasses] = useState<{ id: string; name: string }[] | null>(null);
  const [classId, setClassId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || classes) return;
    apiFetch<ClassList>("/classes", { schoolId })
      .then((d) => setClasses(d.items.map((c) => ({ id: c.id, name: c.name })))).catch(() => setClasses([]));
  }, [open, classes, schoolId]);

  async function send() {
    setBusy(true); setError(null);
    try {
      const r = await apiFetch<{ students: number }>("/notifications/fee-reminders", { schoolId, method: "POST", body: { class_id: classId || null } });
      setOpen(false);
      toast.success(r.students === 0
        ? "No reminders to send: nobody has overdue fees, or they were already reminded today."
        : `Reminders queued for ${r.students} student${r.students === 1 ? "" : "s"}.`);
      onSent?.();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <Button variant={variant} onClick={() => { setOpen(true); setError(null); }} data-testid="send-fee-reminders"><Send className="size-4" /> Send fee reminders</Button>
      <Modal open={open} title="Send fee reminders" onClose={() => setOpen(false)}
        description="Parents of students with overdue fees get a reminder, through the channels switched on for “Fee reminder”. Each student is reminded at most once a day."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={send} loading={busy} data-testid="confirm-fee-reminders">Send reminders</Button></>}>
        <SelectField label="Students" value={classId} onChange={(e) => setClassId(e.target.value)} data-testid="reminder-class">
          <option value="">Every class</option>
          {classes?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        {error && <p className="mt-3 text-sm text-danger-600" role="alert">{error}</p>}
      </Modal>
    </>
  );
}

function DetailModal({ schoolId, id, onClose, onChanged }: { schoolId: string; id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Delivery | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setD(await apiFetch<HistoryDetail>(`/notifications/admin/history/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  // keep it fresh while messages are still going out
  useEffect(() => {
    if (!d || !d.deliveries.some((x) => x.status === "queued" || x.status === "sending" || x.status === "sent")) return;
    const t = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(t);
  }, [d, load]);

  async function retry(x: Delivery) {
    setRetrying(x.id);
    try {
      await apiFetch(`/notifications/admin/deliveries/${x.id}/retry`, { schoolId, method: "POST" });
      toast.success("It will be sent again in a few seconds.");
      await load(); onChanged();
    } catch (e) { toast.error(errorMessage(e)); } finally { setRetrying(null); }
  }

  return (
    <Modal open title="Message details" onClose={onClose} size="lg">
      {error ? <ErrorState message={error} /> : !d ? <LoadingState /> : (
        <div className="space-y-4 text-sm" data-testid="history-detail">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted">
            <span>{formatDateTime(d.created_at)}</span>
            <span>{d.recipients} {d.recipients === 1 ? "person" : "people"}</span>
            <span data-testid="detail-in-app">In the app: {d.in_app.sent} sent, {d.in_app.read} read</span>
          </div>
          {d.error && <p className="rounded-md bg-paper px-3 py-2">{d.error}</p>}
          {d.deliveries.length === 0 ? <p className="text-muted">No email, SMS or WhatsApp messages for this one.</p> : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted"><tr><th className="py-2 pr-3 font-medium">Channel</th><th className="py-2 pr-3 font-medium">To</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 font-medium" /></tr></thead>
                <tbody className="divide-y divide-line">
                  {d.deliveries.map((x) => (
                    <tr key={x.id} data-testid="delivery-row" className="align-top">
                      <td className="py-2 pr-3">{CHANNEL_LABEL[x.channel]}</td>
                      <td className="py-2 pr-3"><span className="block">{x.recipient_name ?? "—"}</span><span className="block text-xs text-muted">{x.address}</span></td>
                      <td className="py-2 pr-3">
                        <span data-testid="delivery-status"><DeliveryPill status={x.status} /></span>
                        {x.error && <span className="mt-0.5 block max-w-xs text-xs text-muted" data-testid="delivery-error">{x.error}</span>}
                        {x.status === "queued" && x.attempts > 0 && <span className="block text-xs text-muted">Next try {formatDateTime(x.next_attempt_at)}</span>}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setShown(x)}>View</Button>
                        {(x.status === "failed" || x.status === "skipped") && (
                          <Button size="sm" variant="secondary" loading={retrying === x.id} onClick={() => void retry(x)} data-testid="delivery-retry">Send again</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shown && (
            <div className="rounded-md border border-line bg-paper p-3" data-testid="delivery-body">
              <p className="mb-1 text-xs text-muted">{CHANNEL_LABEL[shown.channel]} to {shown.address}{shown.attempts ? ` · ${shown.attempts} attempt${shown.attempts === 1 ? "" : "s"}` : ""}</p>
              {shown.subject && <p className="font-medium">{shown.subject}</p>}
              {shown.wa_template && <p className="text-xs text-muted">WhatsApp template: {shown.wa_template}</p>}
              <p className="whitespace-pre-line">{shown.body}</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function HistoryTab({ schoolId, events }: { schoolId: string; events: EventInfo[] }) {
  const [eventKey, setEventKey] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: HistoryItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch("/notifications/admin/history", { schoolId, query: { event_key: eventKey || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, eventKey, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { // while anything is being prepared or sent, refresh
    if (!data?.items.some((i) => i.status === "pending" || i.status === "processing" || Object.keys(i.counts).some((k) => /:(queued|sending)$/.test(k)))) return;
    const t = window.setTimeout(() => void load(), 4000);
    return () => window.clearTimeout(t);
  }, [data, load]);

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
        <SelectField label="Message" value={eventKey} onChange={(e) => { setEventKey(e.target.value); setPage(1); }} className="w-56" data-testid="history-filter">
          <option value="">All messages</option>
          {events.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
          <option value="test">Test message</option>
        </SelectField>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load()} aria-label="Refresh"><RefreshCw className="size-4" /></Button>
          <FeeRemindersButton schoolId={schoolId} onSent={() => window.setTimeout(() => void load(), 1500)} />
        </div>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={History} title="Nothing sent yet" message="Payments, absences, homework, exams, admissions and notices will show up here as messages go out." /></div>
        : (
          <>
            <ul className="divide-y divide-line" data-testid="history-list">
              {data.items.map((i) => (
                <li key={i.id}>
                  <button onClick={() => setOpenId(i.id)} className="grid w-full gap-1 px-4 py-3 text-left hover:bg-paper sm:grid-cols-[10rem_1fr_auto] sm:items-center sm:gap-4" data-testid="history-row">
                    <span className="text-xs text-muted" title={formatDateTime(i.created_at)}>{timeAgo(i.created_at)}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium" data-testid="history-label">{i.label}</span>
                      <span className="block text-xs text-muted">
                        {i.status === "done" ? `${i.recipients} ${i.recipients === 1 ? "person" : "people"}` : EVENT_STATUS_LABEL[i.status]}
                        {i.triggered_by ? ` · by ${i.triggered_by}` : ""}
                        {i.error && i.status !== "done" ? ` · ${i.error}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1 sm:justify-end" data-testid="history-counts">
                      {i.in_app > 0 && <span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs">In app · {i.in_app}</span>}
                      {countsByChannel(i.counts).map((c) => (
                        <span key={`${c.channel}:${c.status}`} className={clsx("rounded-full px-2 py-0.5 text-xs", DELIVERY_TONE[c.status])}>
                          {CHANNEL_LABEL[c.channel]} · {DELIVERY_LABEL[c.status]}{c.n > 1 ? ` ${c.n}` : ""}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-4 py-3"><Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} /></div>
          </>
        )}
      {openId && <DetailModal schoolId={schoolId} id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </section>
  );
}
