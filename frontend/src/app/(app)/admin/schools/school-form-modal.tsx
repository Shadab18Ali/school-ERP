"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { School } from "@/lib/types";

export const BOARDS = ["CBSE", "CISCE (ICSE / ISC)", "State Board", "IB", "Cambridge (IGCSE)", "NIOS", "Other"];

const EMPTY = {
  name: "", code: "", established_year: "",
  email: "", phone: "", address: "", city: "", state: "", postal_code: "", country: "India",
  affiliation_board: "", affiliation_number: "", registration_number: "", udise_code: "",
};
type FormState = typeof EMPTY;
type Errors = Partial<Record<keyof FormState, string>>;

interface Props { open: boolean; school: School | null; onClose: () => void; onSaved: (s: School, created: boolean) => void }

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
      <legend className="mb-1 text-xs font-semibold text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

function toForm(s: School): FormState {
  const v = (x: string | number | null) => (x === null ? "" : String(x));
  return {
    name: s.name, code: s.code, established_year: v(s.established_year),
    email: v(s.email), phone: v(s.phone), address: v(s.address), city: v(s.city), state: v(s.state),
    postal_code: v(s.postal_code), country: s.country,
    affiliation_board: v(s.affiliation_board), affiliation_number: v(s.affiliation_number),
    registration_number: v(s.registration_number), udise_code: v(s.udise_code),
  };
}

export function SchoolFormModal({ open, school, onClose, onSaved }: Props) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setServerError(null);
    setForm(school ? toForm(school) : EMPTY);
  }, [open, school]);

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: key === "code" ? e.target.value.toUpperCase() : e.target.value }));

  function validate(): boolean {
    const next: Errors = {};
    const year = new Date().getFullYear();
    if (form.name.trim().length < 2) next.name = "Enter the school's full name.";
    if (!/^[A-Z0-9-]{2,20}$/.test(form.code.trim())) next.code = "2–20 letters, numbers or hyphens.";
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) next.email = "Enter a valid email.";
    if (form.phone && !/^[0-9+\-\s()]{6,20}$/.test(form.phone)) next.phone = "Enter a valid phone number.";
    if (form.postal_code && !/^[A-Za-z0-9 -]{3,10}$/.test(form.postal_code.trim())) next.postal_code = "Enter a valid PIN / postal code.";
    if (form.udise_code && !/^\d{11}$/.test(form.udise_code.trim())) next.udise_code = "UDISE+ codes are 11 digits.";
    if (form.established_year && !(Number(form.established_year) >= 1800 && Number(form.established_year) <= year))
      next.established_year = `Between 1800 and ${year}.`;
    if (form.affiliation_number && !form.affiliation_board) next.affiliation_board = "Choose the board for this affiliation number.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    setServerError(null);
    const body = { ...form, established_year: form.established_year ? Number(form.established_year) : null };
    try {
      const saved = school
        ? await apiFetch<School>(`/admin/schools/${school.id}`, { method: "PATCH", body })
        : await apiFetch<School>("/admin/schools", { method: "POST", body });
      toast.success(school ? "School updated." : "School created.");
      onSaved(saved, !school);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const f = (key: keyof FormState) => ({ value: form[key], onChange: set(key), error: errors[key] });

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      size="lg"
      title={school ? "Edit school" : "Add school"}
      description={school ? undefined : "Creates a separate, isolated workspace for this school. You can add a logo next."}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="school-form" loading={saving}>{school ? "Save changes" : "Create school"}</Button>
        </>
      }
    >
      <form id="school-form" onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2" noValidate>
        {serverError && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="school-form-error">{serverError}</p>}
        <Group title="School">
          <TextField className="sm:col-span-2" label="School name" required maxLength={200} {...f("name")} />
          <TextField label="School code" required maxLength={20} hint="Short unique ID, e.g. GVPS-DEL" {...f("code")} />
          <TextField label="Established (year)" inputMode="numeric" maxLength={4} {...f("established_year")} />
        </Group>
        <Group title="Contact">
          <TextField label="Email" type="email" {...f("email")} />
          <TextField label="Phone" type="tel" maxLength={20} {...f("phone")} />
          <TextField className="sm:col-span-2" label="Address" maxLength={500} {...f("address")} />
          <TextField label="City" maxLength={100} {...f("city")} />
          <TextField label="State" maxLength={100} {...f("state")} />
          <TextField label="PIN code" maxLength={10} {...f("postal_code")} />
          <TextField label="Country" maxLength={100} {...f("country")} />
        </Group>
        <Group title="Registration">
          <div>
            <SelectField label="Board / affiliation" value={form.affiliation_board} onChange={set("affiliation_board")}>
              <option value="">Not set</option>
              {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
              {form.affiliation_board && !BOARDS.includes(form.affiliation_board) && (
                <option value={form.affiliation_board}>{form.affiliation_board}</option>
              )}
            </SelectField>
            {errors.affiliation_board && <p className="mt-1 text-xs text-danger-600">{errors.affiliation_board}</p>}
          </div>
          <TextField label="Affiliation number" maxLength={50} {...f("affiliation_number")} />
          <TextField label="Registration number" maxLength={50} hint="Society / trust / government registration" {...f("registration_number")} />
          <TextField label="UDISE+ code" inputMode="numeric" maxLength={11} hint="11 digits" {...f("udise_code")} />
        </Group>
      </form>
    </Modal>
  );
}
