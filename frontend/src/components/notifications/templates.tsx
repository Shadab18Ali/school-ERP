"use client";

import { clsx } from "clsx";
import { Eye, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { CHANNEL_LABEL, smsParts, type Channel, type ChannelTemplate, type EventInfo } from "@/lib/notifications";

const ORDER: Channel[] = ["in_app", "email", "sms", "whatsapp"];
const HINT: Record<Channel, string> = {
  in_app: "Shown in the bell at the top of the page, for people with an account.",
  email: "Sent from the school's name. Free.",
  sms: "Through the school's Twilio account (charged per message part). Not sent to student logins.",
  whatsapp: "Through the school's WhatsApp Business account. WhatsApp only allows templates approved by Meta, so the wording is set in Meta; here you choose the template and its values.",
};

interface Preview { subject: string | null; body: string; sms: { characters: number; parts: number; unicode: boolean } | null; note: string }

function ChannelEditor({ schoolId, ev, channel, t, onSaved }: {
  schoolId: string; ev: EventInfo; channel: Channel; t: ChannelTemplate; onSaved: (events: EventInfo[]) => void;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(t.enabled);
  const [subject, setSubject] = useState(t.subject ?? "");
  const [body, setBody] = useState(t.body);
  const [waTemplate, setWaTemplate] = useState(t.wa_template ?? "");
  const [waLanguage, setWaLanguage] = useState(t.wa_language ?? "en");
  const [waParams, setWaParams] = useState<string[]>(t.wa_params ?? []);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | "preview" | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const isWa = channel === "whatsapp";
  const hasSubject = channel === "email" || channel === "in_app";

  useEffect(() => {
    setEnabled(t.enabled); setSubject(t.subject ?? ""); setBody(t.body); setWaTemplate(t.wa_template ?? "");
    setWaLanguage(t.wa_language ?? "en"); setWaParams(t.wa_params ?? []); setPreview(null); setError(null);
  }, [t]);

  const dirty = enabled !== t.enabled || subject !== (t.subject ?? "") || body !== t.body || (isWa && (
    waTemplate !== (t.wa_template ?? "") || waLanguage !== (t.wa_language ?? "en") || waParams.join(",") !== (t.wa_params ?? []).join(",")));

  function insert(name: string) {
    const el = bodyRef.current; const tag = `{{${name}}}`;
    if (!el) return setBody((b) => b + tag);
    const [a, b] = [el.selectionStart ?? body.length, el.selectionEnd ?? body.length];
    setBody(body.slice(0, a) + tag + body.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  }

  async function save() {
    setError(null);
    if (isWa && enabled && !waTemplate.trim()) return setError("Enter the name of the WhatsApp template approved by Meta.");
    setBusy("save");
    try {
      onSaved(await apiFetch<EventInfo[]>(`/notifications/admin/templates/${ev.key}/${channel}`, { schoolId, method: "PUT", body: {
        is_enabled: enabled,
        subject: hasSubject ? subject : null,
        body: isWa ? null : body,
        wa_template: isWa ? waTemplate.trim() || null : null,
        wa_language: isWa ? waLanguage.trim() || null : null,
        wa_params: isWa ? waParams : null,
      } }));
      toast.success(`${ev.label}: ${CHANNEL_LABEL[channel]} saved.`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function reset() {
    setBusy("reset");
    try { onSaved(await apiFetch<EventInfo[]>(`/notifications/admin/templates/${ev.key}/${channel}`, { schoolId, method: "DELETE" })); toast.success("Back to the standard wording."); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function showPreview() {
    setError(null); setBusy("preview");
    try { setPreview(await apiFetch<Preview>("/notifications/admin/preview", { schoolId, method: "POST", body: { event_key: ev.key, channel, subject: hasSubject ? subject : null, body } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  // placeholders are counted without their values (they're added when sending)
  const sms = channel === "sms" ? smsParts(body.replace(/\{\{\s*\w+\s*\}\}/g, "").replace(/₹/g, "Rs ")) : null;
  const vars = Object.entries(ev.variables);
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={`template-${channel}`}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{CHANNEL_LABEL[channel]}{t.customised && <span className="ml-2 rounded-full bg-pencil-100 px-2 py-0.5 text-xs font-medium">Changed</span>}</h3>
          <p className="text-xs text-muted">{HINT[channel]}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-leaf-600" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid={`template-enabled-${channel}`} />
          Send
        </label>
      </div>
      <div className="space-y-3 p-4">
        {isWa ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <TextField label="Template name in Meta" value={waTemplate} onChange={(e) => setWaTemplate(e.target.value.toLowerCase())} placeholder="e.g. fee_payment_received"
                data-testid="wa-template" hint="Lower-case letters, digits and _ — exactly as approved in WhatsApp Manager." />
              <TextField label="Language" value={waLanguage} onChange={(e) => setWaLanguage(e.target.value)} placeholder="en" data-testid="wa-language" />
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium">Values for the template&apos;s {"{{1}}, {{2}}…"}, in order</p>
              <ol className="mb-2 space-y-1">
                {waParams.map((p, i) => (
                  <li key={`${p}-${i}`} className="flex items-center gap-2 text-sm">
                    <span className="w-10 text-xs text-muted">{`{{${i + 1}}}`}</span>
                    <span className="rounded bg-paper px-2 py-0.5">{ev.variables[p] ?? p}</span>
                    <button className="text-xs text-danger-600 hover:underline" onClick={() => setWaParams(waParams.filter((_, j) => j !== i))}>Remove</button>
                  </li>
                ))}
              </ol>
              <select className="h-9 rounded-md border border-line bg-white px-2 text-sm" value="" aria-label="Add a value"
                onChange={(e) => e.target.value && setWaParams([...waParams, e.target.value])} data-testid="wa-add-param">
                <option value="">Add a value…</option>
                {vars.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </div>
            <p className="rounded-md bg-paper px-3 py-2 text-xs text-muted">Suggested wording for the template you submit to Meta: “{t.body}”</p>
          </>
        ) : (
          <>
            {hasSubject && <TextField label={channel === "email" ? "Subject" : "Title"} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} data-testid="template-subject" />}
            <div>
              <label className="mb-1.5 block text-sm font-medium" htmlFor={`body-${ev.key}-${channel}`}>Message</label>
              <textarea ref={bodyRef} id={`body-${ev.key}-${channel}`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={channel === "sms" ? 640 : 2000}
                rows={channel === "email" ? 8 : 3} data-testid="template-body"
                className="block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
              {sms && (
                <p className={clsx("mt-1 text-xs", sms.parts > 2 ? "text-danger-600" : "text-muted")} data-testid="sms-count">
                  {sms.characters} characters plus the values · about {sms.parts} SMS part{sms.parts === 1 ? "" : "s"} per message{sms.unicode ? " (special characters make each part shorter)" : ""}. Use Preview for the full length.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1" aria-label="Insert a value">
              {vars.map(([k, label]) => (
                <button key={k} type="button" onClick={() => insert(k)} title={label} className="rounded-full border border-line px-2 py-0.5 text-xs hover:border-leaf-600 hover:text-leaf-700">
                  {`{{${k}}}`}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="template-error">{error}</p>}
        {preview && !isWa && (
          <div className="rounded-md border border-dashed border-line bg-paper p-3 text-sm" data-testid="template-preview">
            <p className="mb-1 text-xs text-muted">{preview.note}</p>
            {preview.subject && <p className="font-medium">{preview.subject}</p>}
            <p className="whitespace-pre-line">{preview.body}</p>
            {preview.sms && <p className="mt-1 text-xs text-muted">{preview.sms.characters} characters · {preview.sms.parts} part{preview.sms.parts === 1 ? "" : "s"}</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} loading={busy === "save"} disabled={!dirty} data-testid="template-save">Save</Button>
          {!isWa && <Button variant="secondary" onClick={showPreview} loading={busy === "preview"} data-testid="template-preview-btn"><Eye className="size-4" /> Preview</Button>}
          {t.customised && <Button variant="ghost" onClick={reset} loading={busy === "reset"} data-testid="template-reset"><RotateCcw className="size-4" /> Use standard wording</Button>}
        </div>
      </div>
    </section>
  );
}

export function TemplatesTab({ schoolId, events, onChange }: { schoolId: string; events: EventInfo[]; onChange: (e: EventInfo[]) => void }) {
  const [key, setKey] = useState(events[0]?.key ?? "");
  const ev = events.find((e) => e.key === key) ?? events[0];
  if (!ev) return null;
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Messages" className="rounded-lg border border-line bg-white p-2">
        <ul className="space-y-0.5">
          {events.map((e) => {
            const on = ORDER.filter((c) => e.channels[c]?.enabled);
            return (
              <li key={e.key}>
                <button onClick={() => setKey(e.key)} aria-current={e.key === ev.key ? "true" : undefined} data-testid={`template-event-${e.key}`}
                  className={clsx("w-full rounded-md px-3 py-2 text-left", e.key === ev.key ? "bg-leaf-50" : "hover:bg-paper")}>
                  <span className={clsx("block text-sm", e.key === ev.key && "font-semibold text-leaf-700")}>{e.label}</span>
                  <span className="block text-xs text-muted">{on.length ? on.map((c) => CHANNEL_LABEL[c]).join(" · ") : "Off"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{ev.label}</h2>
          <p className="text-sm text-muted">{ev.description} <span className="whitespace-nowrap">Goes to: {ev.audience}.</span></p>
        </div>
        {ORDER.filter((c) => ev.channels[c]).map((c) => (
          <ChannelEditor key={`${ev.key}-${c}`} schoolId={schoolId} ev={ev} channel={c} t={ev.channels[c]!} onSaved={onChange} />
        ))}
      </div>
    </div>
  );
}
