"use client";

import { clsx } from "clsx";
import { CheckCircle2, FileText, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState, type ReactNode } from "react";
import { SchoolHeader } from "@/components/admissions/school-header";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { formatDate } from "@/lib/format";
import { type AdmissionForm, inr, publicFetch } from "@/lib/public-api";

const DOC_TYPES: [string, string][] = [
  ["birth_certificate", "Birth certificate"], ["transfer_certificate", "Transfer certificate"], ["previous_report_card", "Previous report card"],
  ["address_proof", "Address proof"], ["parent_id_proof", "Parent's ID proof"], ["other", "Other"],
];
const MAX = 10 * 1024 * 1024;
const EMPTY = {
  window_id: "", student_name: "", date_of_birth: "", gender: "", blood_group: "",
  father_name: "", father_phone: "", father_occupation: "", mother_name: "", mother_phone: "", mother_occupation: "",
  contact_phone: "", contact_email: "", address_line: "", city: "", state: "", postal_code: "",
  previous_school: "", previous_class: "", previous_board: "", website: "",
};
type F = typeof EMPTY;

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 sm:p-6">
      <h2 className="flex items-center gap-2 font-semibold"><span className="grid size-6 place-items-center rounded-full bg-leaf-600 text-xs text-white">{n}</span>{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function ApplyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [form, setForm] = useState<AdmissionForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [f, setF] = useState<F>(EMPTY);
  const [photo, setPhoto] = useState<File | null>(null);
  const [docs, setDocs] = useState<{ type: string; file: File | null }[]>([{ type: "birth_certificate", file: null }]);
  const [declared, setDeclared] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof F | "photo" | "docs" | "declaration", string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ number: string; phone: string } | null>(null);

  useEffect(() => {
    publicFetch<AdmissionForm>(`/public/admissions/${encodeURIComponent(code)}`).then(setForm).catch((e) => setLoadError(e.message));
  }, [code]);
  const set = (k: keyof F) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const chosen = form?.windows.find((w) => w.window_id === f.window_id);

  function validate() {
    const e: typeof errors = {};
    const phone = (v: string) => v.replace(/\D/g, "").length >= 10 && v.replace(/\D/g, "").length <= 15;
    if (!f.window_id) e.window_id = "Choose the class.";
    if (f.student_name.trim().length < 2) e.student_name = "Enter the child's full name.";
    if (!f.date_of_birth) e.date_of_birth = "Enter the date of birth.";
    if (!f.gender) e.gender = "Choose the gender.";
    if (!f.father_name.trim() && !f.mother_name.trim()) e.father_name = "Enter the father's or the mother's name.";
    if (f.father_phone && !phone(f.father_phone)) e.father_phone = "Enter a valid mobile number.";
    if (f.mother_phone && !phone(f.mother_phone)) e.mother_phone = "Enter a valid mobile number.";
    if (!phone(f.contact_phone)) e.contact_phone = "Enter a valid mobile number. You'll need it to check the status.";
    if (f.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contact_email)) e.contact_email = "Enter a valid email address.";
    if (f.address_line.trim().length < 5) e.address_line = "Enter the full address.";
    if (f.city.trim().length < 2) e.city = "Enter the city.";
    if (f.state.trim().length < 2) e.state = "Enter the state.";
    if (!/^\d{6}$/.test(f.postal_code.replace(/\s/g, ""))) e.postal_code = "Enter a 6-digit PIN code.";
    if (!photo) e.photo = "Add a recent photo of the child.";
    else if (photo.size > MAX) e.photo = "The photo must be 10 MB or smaller.";
    const big = docs.find((d) => d.file && d.file.size > MAX);
    if (big) e.docs = `${big.file!.name} is larger than 10 MB.`;
    if (!declared) e.declaration = "Please confirm that the information is correct.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    setError(null);
    if (!validate()) { setError("Please correct the highlighted fields."); return; }
    setBusy(true);
    const body = new FormData();
    const data: Record<string, unknown> = { declaration: declared };
    for (const [k, v] of Object.entries(f)) data[k] = v.trim() === "" ? null : v.trim();
    body.append("data", JSON.stringify(data));
    body.append("photo", photo!);
    for (const d of docs.filter((x) => x.file)) { body.append("documents", d.file!); body.append("document_types", d.type); }
    try {
      const r = await publicFetch<{ application_number: string }>(`/public/admissions/${encodeURIComponent(code)}`, { method: "POST", body });
      setDone({ number: r.application_number, phone: f.contact_phone });
      window.scrollTo({ top: 0 });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        {loadError ? (
          <p className="rounded-lg border border-line bg-white p-6 text-sm" role="alert">{loadError === "School not found." ? "We couldn't find this school's admission page. Check the link." : loadError}</p>
        ) : !form ? <p className="text-sm text-muted">Loading…</p> : (
          <>
            <SchoolHeader school={form.school} />
            {done ? (
              <section className="rounded-lg border border-line bg-white p-6 text-center" data-testid="application-done">
                <CheckCircle2 className="mx-auto size-12 text-leaf-600" />
                <h2 className="mt-3 text-xl font-semibold">Application submitted</h2>
                <p className="mt-1 text-sm text-muted">Your application number is</p>
                <p className="mt-1 text-3xl font-bold tracking-wide" data-testid="application-number">{done.number}</p>
                <p className="mx-auto mt-3 max-w-md text-sm">Please write this number down. With it and your mobile number you can check the status of the application at any time.</p>
                <Link href={`/apply/${code}/track?number=${encodeURIComponent(done.number)}`} className="mt-5 inline-flex rounded-md bg-leaf-600 px-4 py-2 text-sm font-medium text-white hover:bg-leaf-700">Check status</Link>
              </section>
            ) : form.windows.length === 0 ? (
              <section className="rounded-lg border border-line bg-white p-6" data-testid="admissions-closed">
                <h2 className="font-semibold">Admissions are closed</h2>
                <p className="mt-1 text-sm text-muted">The school isn&apos;t accepting online applications right now.{form.school.phone ? ` For enquiries call ${form.school.phone}.` : ""}</p>
                <Link href={`/apply/${code}/track`} className="mt-3 inline-block text-sm font-medium text-leaf-700 hover:underline">Already applied? Check your status</Link>
              </section>
            ) : (
              <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold">Admission application</h2>
                  <Link href={`/apply/${code}/track`} className="text-sm font-medium text-leaf-700 hover:underline">Already applied? Check your status</Link>
                </div>
                <Section n={1} title="Class" hint="Choose the class you are applying for.">
                  <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Class">
                    {form.windows.map((w) => (
                      <label key={w.window_id} className={clsx("cursor-pointer rounded-md border p-3 text-sm", f.window_id === w.window_id ? "border-leaf-600 bg-leaf-50/60" : "border-line")} data-testid={`window-${w.class_name}`}>
                        <span className="flex items-center gap-2 font-medium">
                          <input type="radio" name="window" className="accent-leaf-600" checked={f.window_id === w.window_id} onChange={() => setF({ ...f, window_id: w.window_id })} />
                          {w.class_name} <span className="font-normal text-muted">· {w.session_name}</span>
                        </span>
                        <span className="mt-1 block text-xs text-muted">
                          Admission fee {inr(w.admission_fee)}{w.seats_left === null ? "" : w.seats_left > 0 ? ` · ${w.seats_left} seat${w.seats_left === 1 ? "" : "s"} left` : " · all seats are filled; new applications go on the waiting list"}{w.last_date ? ` · apply by ${formatDate(w.last_date)}` : ""}
                        </span>
                      </label>
                    ))}
                  </div>
                  {errors.window_id && <p className="mt-2 text-xs text-danger-600">{errors.window_id}</p>}
                  {chosen?.instructions && <p className="mt-3 rounded-md bg-pencil-100/60 p-3 text-sm" data-testid="instructions">{chosen.instructions}</p>}
                </Section>

                <Section n={2} title="Child's details">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField label="Full name" required className="sm:col-span-2" value={f.student_name} maxLength={150} onChange={set("student_name")} error={errors.student_name} />
                    <TextField label="Date of birth" required type="date" value={f.date_of_birth} onChange={set("date_of_birth")} error={errors.date_of_birth} />
                    <div>
                      <SelectField label="Gender" value={f.gender} onChange={set("gender")}>
                        <option value="">Choose</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
                      </SelectField>
                      {errors.gender && <p className="mt-1 text-xs text-danger-600">{errors.gender}</p>}
                    </div>
                    <SelectField label="Blood group (optional)" value={f.blood_group} onChange={set("blood_group")}>
                      <option value="">Not known</option>{["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((b) => <option key={b}>{b}</option>)}
                    </SelectField>
                  </div>
                </Section>

                <Section n={3} title="Parents" hint="At least one parent's name, and a mobile number to contact you.">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <TextField label="Father's name" value={f.father_name} maxLength={150} onChange={set("father_name")} error={errors.father_name} />
                    <TextField label="Father's mobile" inputMode="tel" value={f.father_phone} onChange={set("father_phone")} error={errors.father_phone} />
                    <TextField label="Father's occupation" value={f.father_occupation} maxLength={100} onChange={set("father_occupation")} />
                    <TextField label="Mother's name" value={f.mother_name} maxLength={150} onChange={set("mother_name")} error={errors.mother_name} />
                    <TextField label="Mother's mobile" inputMode="tel" value={f.mother_phone} onChange={set("mother_phone")} error={errors.mother_phone} />
                    <TextField label="Mother's occupation" value={f.mother_occupation} maxLength={100} onChange={set("mother_occupation")} />
                    <TextField label="Contact mobile" required inputMode="tel" value={f.contact_phone} onChange={set("contact_phone")} error={errors.contact_phone}
                      hint="Used to check the status of this application" />
                    <TextField label="Email (optional)" type="email" className="sm:col-span-2" value={f.contact_email} onChange={set("contact_email")} error={errors.contact_email}
                      hint="For the parent portal login once the child is admitted" />
                  </div>
                </Section>

                <Section n={4} title="Address">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <TextField label="House, street, area" required className="sm:col-span-3" value={f.address_line} maxLength={300} onChange={set("address_line")} error={errors.address_line} />
                    <TextField label="City" required value={f.city} maxLength={80} onChange={set("city")} error={errors.city} />
                    <TextField label="State" required value={f.state} maxLength={80} onChange={set("state")} error={errors.state} />
                    <TextField label="PIN code" required inputMode="numeric" value={f.postal_code} maxLength={7} onChange={set("postal_code")} error={errors.postal_code} />
                  </div>
                </Section>

                <Section n={5} title="Previous school (optional)">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <TextField label="School name" className="sm:col-span-3" value={f.previous_school} maxLength={200} onChange={set("previous_school")} />
                    <TextField label="Class studied" value={f.previous_class} maxLength={50} onChange={set("previous_class")} />
                    <TextField label="Board" value={f.previous_board} maxLength={50} onChange={set("previous_board")} placeholder="e.g. CBSE" />
                  </div>
                </Section>

                <Section n={6} title="Photo and documents" hint="JPEG, PNG or PDF, up to 10 MB each. Photos of documents taken with a phone are fine.">
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="photo" className="block text-sm font-medium">Child&apos;s photo <span className="text-danger-600">*</span></label>
                      <input id="photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                        className="mt-1.5 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-leaf-50 file:px-3 file:py-2 file:text-sm file:font-medium" />
                      {errors.photo && <p className="mt-1 text-xs text-danger-600">{errors.photo}</p>}
                    </div>
                    <div className="space-y-2" data-testid="documents">
                      <span className="block text-sm font-medium">Documents</span>
                      {docs.map((d, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <FileText className="size-4 text-muted" aria-hidden />
                          <select aria-label={`Document ${i + 1} type`} value={d.type} onChange={(e) => setDocs(docs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                            className="h-9 rounded-md border border-line px-2 text-sm">
                            {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                          <input type="file" aria-label={`Document ${i + 1} file`} accept="application/pdf,image/jpeg,image/png,image/webp"
                            onChange={(e) => setDocs(docs.map((x, j) => (j === i ? { ...x, file: e.target.files?.[0] ?? null } : x)))} className="min-w-0 flex-1 text-sm" />
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-danger-50 hover:text-danger-600" aria-label={`Remove document ${i + 1}`}
                            onClick={() => setDocs(docs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
                        </div>
                      ))}
                      {docs.length < 8 && <Button type="button" size="sm" variant="secondary" onClick={() => setDocs([...docs, { type: "other", file: null }])}><Plus className="size-4" /> Add document</Button>}
                      {errors.docs && <p className="text-xs text-danger-600">{errors.docs}</p>}
                    </div>
                  </div>
                </Section>

                {/* left empty by people; filled by simple spam bots */}
                <div className="hidden" aria-hidden="true">
                  <label>Website <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} name="website" /></label>
                </div>

                <section className="rounded-lg border border-line bg-white p-5">
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
                    <span>I confirm that the information and documents given are correct. I understand the school will verify them and may reject an application with false information.</span>
                  </label>
                  {errors.declaration && <p className="mt-1 text-xs text-danger-600">{errors.declaration}</p>}
                  {error && <p className="mt-3 rounded-md bg-danger-50 p-3 text-sm text-danger-600" role="alert" data-testid="apply-error">{error}</p>}
                  <Button type="submit" className="mt-4 w-full sm:w-auto" loading={busy} data-testid="submit-application">Submit application</Button>
                </section>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
