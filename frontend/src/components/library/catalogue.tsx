"use client";

import { BookPlus, Library, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { isbn13, showIsbn, type Book, type BookDetail, type Category } from "@/lib/library";
import { useAuth } from "@/providers/auth-provider";

const PAGE_SIZE = 25;

interface FormState {
  title: string; subtitle: string; isbn: string; authors: string; category_id: string; publisher: string; edition: string;
  publication_year: string; language: string; shelf_location: string; description: string;
  copies: string; accession_numbers: string; price: string; acquired_on: string;
}
const EMPTY: FormState = {
  title: "", subtitle: "", isbn: "", authors: "", category_id: "", publisher: "", edition: "", publication_year: "", language: "",
  shelf_location: "", description: "", copies: "1", accession_numbers: "", price: "", acquired_on: "",
};

/** Add a book (with its first copies), or edit one. */
export function BookFormModal({ schoolId, open, book, onClose, onSaved }: {
  schoolId: string; open: boolean; book?: BookDetail | null; onClose: () => void; onSaved: (b: BookDetail) => void;
}) {
  const [f, setF] = useState<FormState>(EMPTY);
  const [cats, setCats] = useState<Category[]>([]);
  const [newCat, setNewCat] = useState("");
  const [manualAcc, setManualAcc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = Boolean(book);

  useEffect(() => {
    if (!open) return;
    setError(null); setNewCat(""); setManualAcc(false);
    setF(book ? {
      ...EMPTY, title: book.title, subtitle: book.subtitle ?? "", isbn: book.isbn ?? "", authors: book.authors.join("; "),
      category_id: book.category_id ?? "", publisher: book.publisher ?? "", edition: book.edition ?? "",
      publication_year: book.publication_year ? String(book.publication_year) : "", language: book.language ?? "",
      shelf_location: book.shelf_location ?? "", description: book.description ?? "",
    } : EMPTY);
    apiFetch<Category[]>("/library/categories", { schoolId }).then(setCats).catch(() => setCats([]));
  }, [open, book, schoolId]);

  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.title.trim()) return setError("Enter the title.");
    if (f.isbn.trim() && !isbn13(f.isbn)) return setError("That ISBN isn't valid. Check the digits (10 or 13, as printed on the book).");
    if (f.publication_year && !/^\d{4}$/.test(f.publication_year)) return setError("Enter the year as four digits.");
    if (f.price && !/^\d{1,7}(\.\d{1,2})?$/.test(f.price.trim())) return setError("Enter the price in rupees, e.g. 250 or 250.50.");
    setBusy(true);
    try {
      let category_id = f.category_id || null;
      if (category_id === "__new") {
        if (newCat.trim().length < 2) { setBusy(false); return setError("Enter the new category's name."); }
        category_id = (await apiFetch<Category>("/library/categories", { schoolId, method: "POST", body: { name: newCat.trim() } })).id;
      }
      const body: Record<string, unknown> = {
        title: f.title, subtitle: f.subtitle || null, isbn: f.isbn || null,
        authors: f.authors.split(/[;\n]/).map((a) => a.trim()).filter(Boolean),
        category_id, publisher: f.publisher || null, edition: f.edition || null,
        publication_year: f.publication_year ? Number(f.publication_year) : null, language: f.language || null,
        shelf_location: f.shelf_location || null, description: f.description || null,
      };
      let saved: BookDetail;
      if (book) {
        saved = await apiFetch<BookDetail>(`/library/books/${book.id}`, { schoolId, method: "PUT", body: { ...body, is_active: book.is_active } });
      } else {
        saved = await apiFetch<BookDetail>("/library/books", { schoolId, method: "POST", body: {
          ...body, copies: manualAcc ? 0 : Number(f.copies || 0), accession_numbers: manualAcc ? f.accession_numbers : null,
          price: f.price.trim() || null, acquired_on: f.acquired_on || null } });
      }
      onSaved(saved);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} title={editing ? "Edit book" : "Add a book"} onClose={busy ? () => {} : onClose} size="lg"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="book-form" loading={busy} data-testid="save-book">{editing ? "Save" : "Add book"}</Button></>}>
      <form id="book-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <TextField className="sm:col-span-2" label="Title" required value={f.title} onChange={set("title")} maxLength={300} data-testid="book-title" />
        <TextField className="sm:col-span-2" label="Subtitle" value={f.subtitle} onChange={set("subtitle")} maxLength={300} />
        <TextField className="sm:col-span-2" label="Authors" value={f.authors} onChange={set("authors")} placeholder="e.g. R. K. Narayan; Another Author" hint="Separate several authors with ;" data-testid="book-authors" />
        <TextField label="ISBN" value={f.isbn} onChange={set("isbn")} placeholder="10 or 13 digits" data-testid="book-isbn"
          hint={f.isbn.trim() ? (isbn13(f.isbn) ? `ISBN-13: ${showIsbn(isbn13(f.isbn))}` : "Not a valid ISBN yet") : "Optional — on the back cover"} />
        <div>
          <SelectField label="Category" value={f.category_id} onChange={set("category_id")} data-testid="book-category">
            <option value="">No category</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="__new">+ New category…</option>
          </SelectField>
          {f.category_id === "__new" && <TextField className="mt-2" label="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} maxLength={80} data-testid="book-new-category" />}
        </div>
        <TextField label="Publisher" value={f.publisher} onChange={set("publisher")} maxLength={150} />
        <TextField label="Edition" value={f.edition} onChange={set("edition")} maxLength={50} />
        <TextField label="Year published" inputMode="numeric" value={f.publication_year} onChange={set("publication_year")} maxLength={4} />
        <TextField label="Language" value={f.language} onChange={set("language")} maxLength={40} placeholder="e.g. English, Hindi" />
        <TextField label="Shelf / rack" value={f.shelf_location} onChange={set("shelf_location")} maxLength={40} placeholder="e.g. R3-S2" />
        <div className="sm:col-span-2">
          <label htmlFor="book-desc" className="mb-1.5 block text-sm font-medium">Description</label>
          <textarea id="book-desc" value={f.description} onChange={set("description")} maxLength={2000} rows={2}
            className="block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        {!editing && (
          <fieldset className="space-y-3 rounded-md bg-paper p-4 sm:col-span-2">
            <legend className="px-1 text-sm font-medium">Copies</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-leaf-600" checked={manualAcc} onChange={(e) => setManualAcc(e.target.checked)} data-testid="manual-accession" />
              I&apos;ll type the accession numbers (they&apos;re already written in the books)
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              {manualAcc
                ? <TextField className="sm:col-span-3" label="Accession numbers" value={f.accession_numbers} onChange={set("accession_numbers")} placeholder="e.g. 1021, 1022, 1023" data-testid="book-accessions" hint="Separate with commas or spaces." />
                : <TextField label="Number of copies" inputMode="numeric" value={f.copies} onChange={set("copies")} data-testid="book-copies" hint="Numbered ACC-000001 onwards." />}
              <TextField label="Price per copy (₹)" inputMode="decimal" value={f.price} onChange={set("price")} data-testid="book-price" hint="Charged if a copy is lost." />
              <TextField label="Date acquired" type="date" value={f.acquired_on} max={new Date().toISOString().slice(0, 10)} onChange={set("acquired_on")} />
            </div>
          </fieldset>
        )}
        {error && <p className="text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="book-error">{error}</p>}
      </form>
    </Modal>
  );
}

export function Catalogue({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [category, setCategory] = useState("");
  const [availability, setAvailability] = useState<"all" | "available" | "out">("all");
  const [withdrawn, setWithdrawn] = useState(false);
  const [page, setPage] = useState(1);
  const [cats, setCats] = useState<Category[]>([]);
  const [data, setData] = useState<{ items: Book[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  useEffect(() => { apiFetch<Category[]>("/library/categories", { schoolId }).then(setCats).catch(() => setCats([])); }, [schoolId]);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiFetch("/library/books", { schoolId, query: { q: term || undefined, category_id: category || undefined, availability,
        include_withdrawn: withdrawn ? "true" : undefined, page, page_size: PAGE_SIZE } }));
    } catch (e) { setError(errorMessage(e)); }
  }, [schoolId, term, category, availability, withdrawn, page]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="grid gap-3 border-b border-line p-4 md:grid-cols-[1fr_12rem_10rem_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="book-search" className="sr-only">Search books</label>
          <input id="book-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, author, ISBN or accession no." data-testid="book-search"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <SelectField label="Category" hideLabel value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <SelectField label="Availability" hideLabel value={availability} onChange={(e) => { setAvailability(e.target.value as typeof availability); setPage(1); }} data-testid="book-availability">
          <option value="all">All books</option>
          <option value="available">On the shelf</option>
          <option value="out">All copies out</option>
        </SelectField>
        {can("library:manage") && <Button onClick={() => setAdding(true)} data-testid="add-book"><BookPlus className="size-4" /> Add book</Button>}
      </div>
      {can("library:manage") && (
        <label className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted">
          <input type="checkbox" className="size-3.5 accent-leaf-600" checked={withdrawn} onChange={(e) => { setWithdrawn(e.target.checked); setPage(1); }} />
          Include withdrawn titles
        </label>
      )}
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? (
          <div className="p-4"><EmptyState icon={Library} title={term || category || availability !== "all" ? "No books match" : "The catalogue is empty"}
            message={term || category || availability !== "all" ? "Try another search or filter." : can("library:manage") ? "Add the library's books with Add book." : "The library hasn't added its books yet."} /></div>
        ) : (
          <>
            <ul className="divide-y divide-line" data-testid="book-list">
              {data.items.map((b) => (
                <li key={b.id}>
                  <Link href={`/library/books/${b.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-paper" data-testid="book-row">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{b.title}</span>{!b.is_active && <span className="ml-2 rounded-full bg-ink/5 px-2 py-0.5 text-xs text-muted">Withdrawn</span>}
                      <span className="block text-xs text-muted">
                        {[b.authors.join(", "), b.category, b.isbn ? `ISBN ${showIsbn(b.isbn)}` : null, b.shelf_location ? `Shelf ${b.shelf_location}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="text-right text-sm" data-testid="book-availability-count">
                      <span className={b.available > 0 ? "font-medium text-leaf-700" : "font-medium text-muted"}>{b.available} of {b.copies}</span>
                      <span className="block text-xs text-muted">on the shelf</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-4 py-3"><Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} /></div>
          </>
        )}
      <BookFormModal schoolId={schoolId} open={adding} onClose={() => setAdding(false)}
        onSaved={(b) => { setAdding(false); toast.success(`“${b.title}” added with ${b.copies} cop${b.copies === 1 ? "y" : "ies"}.`); router.push(`/library/books/${b.id}`); }} />
    </section>
  );
}
