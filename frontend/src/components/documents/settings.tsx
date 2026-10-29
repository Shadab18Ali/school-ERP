"use client";

import { ImageUp, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage } from "@/lib/api";
import type { DocumentSettings } from "@/lib/documents";
import { formatDate, todayISO } from "@/lib/format";

/** Shared by certificates and ID cards: signatory, signature, place, colour, card validity and the back of the card. */
export function DocumentSettingsPanel({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [s, setS] = useState<DocumentSettings | null>(null);
  const [f, setF] = useState({ principal_name: "", signatory_title: "Principal", place: "", accent_color: "#2f6b57", card_valid_until: "", card_back_note: "" });
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "sig" | null>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const apply = useCallback((x: DocumentSettings) => {
    setS(x);
    setF({ principal_name: x.principal_name ?? "", signatory_title: x.signatory_title, place: x.place ?? "", accent_color: x.accent_color,
      card_valid_until: x.card_valid_until ?? "", card_back_note: x.card_back_note ?? "" });
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try { apply(await apiFetch<DocumentSettings>("/document-settings", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId, apply]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!s?.has_signature) { setSigUrl(null); return; }
    let url: string | null = null;
    apiFetchBlob("/document-settings/signature.png", { schoolId }).then(({ blob }) => { url = URL.createObjectURL(blob); setSigUrl(url); }).catch(() => setSigUrl(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [s?.has_signature, s, schoolId]);

  async function save() {
    setBusy("save"); setFormError(null);
    try {
      apply(await apiFetch<DocumentSettings>("/document-settings", { schoolId, method: "PUT", body: {
        principal_name: f.principal_name.trim() || null, signatory_title: f.signatory_title.trim() || "Principal", place: f.place.trim() || null,
        accent_color: f.accent_color, card_valid_until: f.card_valid_until || null, card_back_note: f.card_back_note.trim() || null,
      } }));
      toast.success("Settings saved.");
    } catch (e) { setFormError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function upload(file: File) {
    if (file.size > 2 * 1024 * 1024) { toast.error("The signature image must be 2 MB or smaller."); return; }
    setBusy("sig");
    const form = new FormData(); form.append("file", file);
    try { apply(await apiFetch<DocumentSettings>("/document-settings/signature", { schoolId, method: "PUT", body: form })); toast.success("Signature uploaded."); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function removeSig() {
    setBusy("sig");
    try { apply(await apiFetch<DocumentSettings>("/document-settings/signature", { schoolId, method: "DELETE" })); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!s) return <LoadingState />;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-4 rounded-lg border border-line bg-white p-5">
        <h2 className="font-semibold">Signatory and look</h2>
        {formError && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{formError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Principal's name" maxLength={100} value={f.principal_name} onChange={(e) => setF({ ...f, principal_name: e.target.value })} hint="Printed under the signature" data-testid="settings-principal" />
          <TextField label="Signatory's title" maxLength={40} value={f.signatory_title} onChange={(e) => setF({ ...f, signatory_title: e.target.value })} />
          <TextField label="Place" maxLength={60} value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} hint="Printed on certificates; empty = the school's city" data-testid="settings-place" />
          <div>
            <label htmlFor="accent" className="mb-1.5 block text-sm font-medium">Colour</label>
            <div className="flex items-center gap-2">
              <input id="accent" type="color" value={f.accent_color} onChange={(e) => setF({ ...f, accent_color: e.target.value })} className="h-10 w-14 cursor-pointer rounded border border-line" />
              <span className="text-sm text-muted">{f.accent_color}</span>
            </div>
          </div>
        </div>
        <h2 className="pt-2 font-semibold">ID cards</h2>
        <TextField label="Cards valid until" type="date" min={todayISO()} value={f.card_valid_until} onChange={(e) => setF({ ...f, card_valid_until: e.target.value })}
          hint={f.card_valid_until ? undefined : s.default_card_valid_until ? `Empty = the end of the current session (${formatDate(s.default_card_valid_until)})` : "Empty = the end of the current session"} />
        <label className="block text-sm font-medium">Note on the back of the card
          <textarea value={f.card_back_note} maxLength={200} rows={2} onChange={(e) => setF({ ...f, card_back_note: e.target.value })} placeholder="e.g. This card is the property of the school. If found, please return it."
            className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </label>
        <Button onClick={save} loading={busy === "save"} data-testid="save-document-settings">Save</Button>
      </section>
      <section className="space-y-4 rounded-lg border border-line bg-white p-5">
        <h2 className="font-semibold">Signature</h2>
        <p className="text-sm text-muted">A scan or photo of the principal&apos;s signature (PNG, JPEG or WebP, up to 2 MB), printed on certificates and ID cards. A certificate keeps the signature it was issued with.</p>
        <div className="grid h-28 place-items-center rounded-md border border-dashed border-line bg-paper">
          {sigUrl ? <img src={sigUrl} alt="Signature" className="max-h-24 max-w-full object-contain" data-testid="signature-preview" /> : <span className="text-sm text-muted">No signature uploaded</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" id="signature-file" data-testid="signature-file"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={busy === "sig"}><ImageUp className="size-4" /> {s.has_signature ? "Replace" : "Upload"}</Button>
          {s.has_signature && <Button variant="ghost" onClick={removeSig} disabled={busy === "sig"}><Trash2 className="size-4" /> Remove</Button>}
        </div>
        <h2 className="pt-2 font-semibold">School logo</h2>
        <p className="text-sm text-muted">
          {s.has_logo ? "The school logo is printed on certificates and ID cards." : "No logo yet."} It&apos;s set in <Link href="/settings" className="underline">School settings</Link>, along with the name, address and affiliation shown on the letterhead.
        </p>
      </section>
    </div>
  );
}
