"use client";

import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { todayISO } from "@/lib/format";
import { GENDER_LABELS, type AcademicSession, type Gender, type StudentDetail } from "@/lib/types";
import { PlacementFields, validatePlacement, type Placement } from "./placement-fields";

export interface PersonalForm {
  full_name: string;
  father_name: string;
  mother_name: string;
  date_of_birth: string;
  gender: Gender | "";
  mobile: string;
  alternate_mobile: string;
  address: string;
}

export interface StudentFormValue {
  personal: PersonalForm;
  placement: Placement | null; // null when the student has no enrollment to edit
  photo: File | null;
}

const PHONE = /^\+?[0-9]{10,15}$/;
const normPhone = (p: string) => p.replace(/[\s\-().]/g, "");
/** Same subscriber number, with or without the country code (+91 98765 43210 = 98765 43210). */
const samePhone = (a: string, b: string) => normPhone(a).slice(-10) === normPhone(b).slice(-10);

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      <div className="grid gap-4 p-5 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function personalFrom(s: StudentDetail | null): PersonalForm {
  return {
    full_name: s?.full_name ?? "",
    father_name: s?.father_name ?? "",
    mother_name: s?.mother_name ?? "",
    date_of_birth: s?.date_of_birth ?? "",
    gender: s?.gender ?? "",
    mobile: s?.mobile ?? "",
    alternate_mobile: s?.alternate_mobile ?? "",
    address: s?.address ?? "",
  };
}

interface Props {
  mode: "create" | "edit";
  schoolId: string;
  sessions: AcademicSession[];
  initial: StudentFormValue;
  enrollmentLabel?: string;
  submitLabel: string;
  serverError: string | null;
  saving: boolean;
  onSubmit: (v: StudentFormValue) => void;
  onCancel: () => void;
}

export function StudentForm({ mode, schoolId, sessions, initial, enrollmentLabel, submitLabel, serverError, saving, onSubmit, onCancel }: Props) {
  const [personal, setPersonal] = useState(initial.personal);
  const [placement, setPlacement] = useState(initial.placement);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!photo) return setPreview(null);
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => { if (serverError) errorRef.current?.scrollIntoView({ block: "center" }); }, [serverError]);

  const set = (k: keyof PersonalForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setPersonal((p) => ({ ...p, [k]: e.target.value }));

  function validate(): boolean {
    const e: Record<string, string> = {};
    const p = personal;
    if (p.full_name.trim().length < 2) e.full_name = "Enter the student's full name.";
    if (!p.father_name.trim() && !p.mother_name.trim()) e.father_name = "Enter the father's or the mother's name.";
    if (!p.date_of_birth) e.date_of_birth = "Enter the date of birth.";
    else if (p.date_of_birth > todayISO()) e.date_of_birth = "Date of birth can't be in the future.";
    if (!p.gender) e.gender = "Choose the gender.";
    if (!PHONE.test(normPhone(p.mobile))) e.mobile = "Enter a valid mobile number (10–15 digits).";
    if (p.alternate_mobile.trim()) {
      if (!PHONE.test(normPhone(p.alternate_mobile))) e.alternate_mobile = "Enter a valid number, or leave it empty.";
      else if (samePhone(p.alternate_mobile, p.mobile)) e.alternate_mobile = "Same as the mobile number.";
    }
    if (placement) Object.assign(e, validatePlacement(placement));
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
      return;
    }
    onSubmit({ personal, placement, photo });
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {serverError && (
        <p ref={errorRef} className="rounded-md bg-danger-50 px-4 py-3 text-sm text-danger-600" role="alert" data-testid="student-form-error">
          {serverError}
        </p>
      )}

      <Section title="Student">
        {mode === "create" && (
          <div className="flex items-center gap-4 sm:col-span-2">
            <button type="button" onClick={() => fileRef.current?.click()}
              className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-full border border-dashed border-line bg-paper text-muted hover:border-leaf-600"
              aria-label={photo ? "Change photo" : "Add photo"}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {preview ? <img src={preview} alt="Selected photo" className="size-full object-cover" /> : <ImagePlus className="size-6" aria-hidden />}
            </button>
            <div className="text-sm">
              <p className="font-medium">Photo <span className="font-normal text-muted">(optional)</span></p>
              <p className="text-muted">PNG, JPEG or WebP, up to 2 MB.</p>
              {photo && (
                <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-danger-600" onClick={() => setPhoto(null)}>
                  <X className="size-3" /> Remove
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="photo-input" aria-label="Student photo"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (f.size > 2 * 1024 * 1024) return setErrors((x) => ({ ...x, photo: "The photo must be 2 MB or smaller." }));
                setErrors((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "photo")));
                setPhoto(f);
              }} />
            {errors.photo && <p className="text-xs text-danger-600">{errors.photo}</p>}
          </div>
        )}
        <TextField className="sm:col-span-2" label="Full name" required maxLength={150} value={personal.full_name} onChange={set("full_name")} error={errors.full_name} />
        <TextField label="Date of birth" type="date" required max={todayISO()} value={personal.date_of_birth} onChange={set("date_of_birth")} error={errors.date_of_birth} />
        <div>
          <SelectField label="Gender" value={personal.gender} onChange={set("gender")} aria-invalid={errors.gender ? true : undefined}>
            <option value="">Choose</option>
            {(Object.keys(GENDER_LABELS) as Gender[]).map((g) => <option key={g} value={g}>{GENDER_LABELS[g]}</option>)}
          </SelectField>
          {errors.gender && <p className="mt-1 text-xs text-danger-600">{errors.gender}</p>}
        </div>
      </Section>

      <Section title="Parents & contact" description="At least one parent's name is required.">
        <TextField label="Father's name" maxLength={150} value={personal.father_name} onChange={set("father_name")} error={errors.father_name} />
        <TextField label="Mother's name" maxLength={150} value={personal.mother_name} onChange={set("mother_name")} />
        <TextField label="Mobile" type="tel" required maxLength={20} value={personal.mobile} onChange={set("mobile")} error={errors.mobile} hint="Used for school messages" />
        <TextField label="Alternate mobile" type="tel" maxLength={20} value={personal.alternate_mobile} onChange={set("alternate_mobile")} error={errors.alternate_mobile} />
        <div className="sm:col-span-2">
          <label htmlFor="address" className="mb-1.5 block text-sm font-medium">Address</label>
          <textarea id="address" rows={2} maxLength={500} value={personal.address} onChange={set("address")}
            className="block w-full rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
      </Section>

      {placement && (
        <Section title={enrollmentLabel ?? "Admission"} description={mode === "edit" ? "Changes apply to this session only." : undefined}>
          <PlacementFields schoolId={schoolId} sessions={sessions} value={placement} onChange={setPlacement}
            errors={errors} lockSession={mode === "edit"} suggestNumber={mode === "create"} />
        </Section>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" loading={saving} data-testid="save-student">{submitLabel}</Button>
      </div>
    </form>
  );
}
