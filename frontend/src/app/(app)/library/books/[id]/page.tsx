"use client";

import { ArrowLeft, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { BookFormModal } from "@/components/library/catalogue";
import { CopyPill } from "@/components/library/shared";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { COPY_STATUS_LABEL, showIsbn, type BookDetail, type Copy, type CopyStatus } from "@/lib/library";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

function AddCopiesModal({ schoolId, book, open, onClose, onSaved }: { schoolId: string; book: BookDetail; open: boolean; onClose: () => void; onSaved: (b: BookDetail) => void }) {
  const [count, setCount] = useState("1");
  const [manual, setManual] = useState(false);
  const [acc, setAcc] = useState("");
  const [price, setPrice] = useState("");
  const [acquired, setAcquired] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setCount("1"); setManual(false); setAcc(""); setPrice(""); setAcquired(""); setError(null); } }, [open]);
  async function go() {
    setError(null);
    if (!manual && !/^\d{1,3}$/.test(count)) return setError("Enter how many copies (1 to 100).");
    if (price && !/^\d{1,7}(\.\d{1,2})?$/.test(price.trim())) return setError("Enter the price in rupees, e.g. 250.");
    setBusy(true);
    try {
      onSaved(await apiFetch<BookDetail>(`/library/books/${book.id}/copies`, { schoolId, method: "POST", body: {
        count: manual ? 0 : Number(count), accession_numbers: manual ? acc : null, price: price.trim() || null, acquired_on: acquired || null } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} title="Add copies" description={book.title} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} data-testid="confirm-add-copies">Add</Button></>}>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-leaf-600" checked={manual} onChange={(e) => setManual(e.target.checked)} />
          Type the accession numbers
        </label>
        {manual
          ? <TextField label="Accession numbers" value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="e.g. 1021, 1022" data-testid="copies-accessions" />
          : <TextField label="Number of copies" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} data-testid="copies-count" />}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Price per copy (₹)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <TextField label="Date acquired" type="date" value={acquired} onChange={(e) => setAcquired(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="copies-error">{error}</p>}
      </div>
    </Modal>
  );
}

function CopyStatusModal({ schoolId, copy, onClose, onSaved }: { schoolId: string; copy: Copy | null; onClose: () => void; onSaved: (b: BookDetail) => void }) {
  const [status, setStatus] = useState<CopyStatus>("available");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (copy) { setStatus(copy.status === "available" ? "damaged" : "available"); setNote(""); setError(null); } }, [copy]);
  if (!copy) return null;
  async function go() {
    setBusy(true); setError(null);
    try { onSaved(await apiFetch<BookDetail>(`/library/copies/${copy!.id}/status`, { schoolId, method: "POST", body: { status, note: note.trim() || null } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`Copy ${copy.accession_number}`} description={`Now: ${COPY_STATUS_LABEL[copy.status]}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} data-testid="confirm-copy-status">Save</Button></>}>
      <div className="space-y-3">
        <SelectField label="Mark as" value={status} onChange={(e) => setStatus(e.target.value as CopyStatus)} data-testid="copy-status-select">
          {(["available", "damaged", "lost", "withdrawn"] as CopyStatus[]).map((s) => <option key={s} value={s}>{COPY_STATUS_LABEL[s]}</option>)}
        </SelectField>
        <TextField label="Note (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Torn cover, sent for binding" />
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="copy-status-error">{error}</p>}
      </div>
    </Modal>
  );
}

function BookPage({ id }: { id: string }) {
  const toast = useToast();
  const router = useRouter();
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [b, setB] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusOf, setStatusOf] = useState<Copy | null>(null);
  const [confirm, setConfirm] = useState<"withdraw" | "restore" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setB(await apiFetch<BookDetail>(`/library/books/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} />;
  if (!b) return <LoadingState />;

  async function deleteCopy(c: Copy) {
    try { setB(await apiFetch<BookDetail>(`/library/copies/${c.id}`, { schoolId, method: "DELETE" })); toast.success(`Copy ${c.accession_number} deleted.`); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  async function confirmAction() {
    if (!b || !confirm) return;
    setBusy(true);
    try {
      if (confirm === "delete") {
        await apiFetch(`/library/books/${b.id}`, { schoolId, method: "DELETE" });
        toast.success("Book deleted."); router.push("/library?tab=Catalogue"); return;
      }
      setB(await apiFetch<BookDetail>(`/library/books/${b.id}`, { schoolId, method: "PUT", body: {
        title: b.title, subtitle: b.subtitle, isbn: b.isbn, authors: b.authors, category_id: b.category_id, publisher: b.publisher, edition: b.edition,
        publication_year: b.publication_year, language: b.language, shelf_location: b.shelf_location, description: b.description, is_active: confirm === "restore" } }));
      toast.success(confirm === "restore" ? "Back in the catalogue." : "Withdrawn from the catalogue.");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); setConfirm(null); }
  }

  const details: [string, string | number | null][] = [
    ["Authors", b.authors.join(", ") || null], ["ISBN", b.isbn ? showIsbn(b.isbn) : null], ["Category", b.category], ["Publisher", b.publisher],
    ["Edition", b.edition], ["Year", b.publication_year], ["Language", b.language], ["Shelf", b.shelf_location],
  ];
  return (
    <>
      <Link href="/library?tab=Catalogue" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Catalogue</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="book-heading">{b.title}</h1>
          {b.subtitle && <p className="text-muted">{b.subtitle}</p>}
          <p className="mt-1 text-sm" data-testid="book-summary">
            <span className={b.available ? "font-medium text-leaf-700" : "font-medium text-muted"}>{b.available} of {b.copies} on the shelf</span>
            {!b.is_active && <span className="ml-2 rounded-full bg-ink/5 px-2 py-0.5 text-xs text-muted">Withdrawn</span>}
          </p>
        </div>
        {b.can_manage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)} data-testid="edit-book"><Pencil className="size-4" /> Edit</Button>
            <ActionMenu label="More" actions={[
              b.is_active ? { label: "Withdraw from catalogue", onSelect: () => setConfirm("withdraw") } : { label: "Return to catalogue", onSelect: () => setConfirm("restore") },
              { label: "Delete book", onSelect: () => setConfirm("delete"), tone: "danger" },
            ]} />
          </div>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <section className="rounded-lg border border-line bg-white p-5">
          <dl className="space-y-2 text-sm">
            {details.filter(([, v]) => v !== null && v !== "").map(([k, v]) => (
              <div key={k} className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          {b.description && <p className="mt-4 whitespace-pre-line border-t border-line pt-4 text-sm">{b.description}</p>}
        </section>
        <section className="rounded-lg border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-semibold">Copies</h2>
            {b.can_manage && b.is_active && <Button size="sm" onClick={() => setAdding(true)} data-testid="add-copies"><Plus className="size-4" /> Add copies</Button>}
          </div>
          {b.copy_list.length === 0 ? <p className="p-4 text-sm text-muted">No copies yet.</p> : (
            <ul className="divide-y divide-line" data-testid="copy-list">
              {b.copy_list.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid="copy-row">
                  <span className="w-28 font-mono">{c.accession_number}</span>
                  <CopyPill status={c.status} />
                  <span className="min-w-0 flex-1 text-xs text-muted">
                    {c.loan ? <>with {c.loan.borrower_name}{c.loan.borrower_class ? ` (${c.loan.borrower_class})` : ""}, due {formatDate(c.loan.due_date)}</> : c.note}
                    {c.price ? ` · ${formatINR(c.price)}` : ""}{c.times_issued ? ` · issued ${c.times_issued}×` : ""}
                  </span>
                  {b.can_manage && c.status !== "issued" && (
                    <ActionMenu label={`Copy ${c.accession_number}`} actions={[
                      { label: "Change status…", onSelect: () => setStatusOf(c) },
                      ...(c.times_issued === 0 ? [{ label: "Delete copy", onSelect: () => void deleteCopy(c), tone: "danger" as const }] : []),
                    ]} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {b.can_manage && (
        <>
          <BookFormModal schoolId={schoolId} open={editing} book={b} onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); setB(x); toast.success("Saved."); }} />
          <AddCopiesModal schoolId={schoolId} book={b} open={adding} onClose={() => setAdding(false)} onSaved={(x) => { setAdding(false); setB(x); toast.success("Copies added."); }} />
          <CopyStatusModal schoolId={schoolId} copy={statusOf} onClose={() => setStatusOf(null)} onSaved={(x) => { setStatusOf(null); setB(x); toast.success("Copy updated."); }} />
          <ConfirmDialog open={confirm !== null} loading={busy} onCancel={() => setConfirm(null)} onConfirm={confirmAction}
            tone={confirm === "restore" ? "primary" : "danger"}
            title={confirm === "delete" ? "Delete this book?" : confirm === "restore" ? "Return to the catalogue?" : "Withdraw from the catalogue?"}
            message={confirm === "delete" ? "Only a book with no copies can be deleted. A book with copies is kept for the borrowing history: withdraw it instead."
              : confirm === "restore" ? "It will show in the catalogue again and its available copies can be issued."
              : "It won't show in the catalogue or be issued. Copies on loan can still be returned, and the history is kept."}
            confirmLabel={confirm === "delete" ? "Delete" : confirm === "restore" ? "Return to catalogue" : "Withdraw"} />
        </>
      )}
    </>
  );
}

export default function LibraryBookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="library:view"><BookPage id={id} /></RequirePermission>;
}
