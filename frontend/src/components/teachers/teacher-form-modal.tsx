"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import { todayISO } from "@/lib/format";
import type { TeacherDetail } from "@/lib/types";

const EMPTY = { employee_id: "", full_name: "", phone: "", email: "", qualification: "", subject: "", joining_date: "", address: "", staff_type: "teaching", designation: "" };
type Form = typeof EMPTY;

/** Add or edit a teacher. Server-side rules (unique Employee ID / email, valid phone, date) are re-checked by the API. */
export function TeacherFormModal({ open, schoolId, teacher, onClose, onSaved }: {
  open: boolean; schoolId: string; teacher: TeacherDetail | null; onClose: () => void; onSaved: (t: TeacherDetail) => void;
}) {
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrors({}); setError(null);
    setF(teacher ? {
      employee_id: teacher.employee_id, full_name: teacher.full_name, phone: teacher.phone, email: teacher.email,
      qualification: teacher.qualification ?? "", subject: teacher.subject ?? "", joining_date: teacher.joining_date, address: teacher.address ?? "",
      staff_type: teacher.staff_type, designation: teacher.designation ?? "",
    } : EMPTY);
  }, [open, teacher]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  function validate(): boolean {
    const e: Partial<Record<keyof Form, string>> = {};
    if (f.full_name.trim().length < 2) e.full_name = "Enter the teacher's name.";
    if (!/^\+?[0-9]{10,15}$/.test(f.phone.replace(/[\s\-().]/g, ""))) e.phone = "Enter a valid mobile number.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = "Enter a valid email address.";
    if (!f.joining_date) e.joining_date = "Enter the joining date.";
    else if (f.joining_date > todayISO()) e.joining_date = "The joining date can't be in the future.";
    if (f.employee_id.trim() && !/^[A-Za-z0-9/_-]{1,30}$/.test(f.employee_id.trim())) e.employee_id = "Letters, numbers, - / and _ only.";
    if (f.designation.trim() && f.designation.trim().length < 2) e.designation = "At least 2 characters.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setBusy(true); setError(null);
    const body: Record<string, string | null> = {
      full_name: f.full_name.trim(), phone: f.phone.trim(), email: f.email.trim(), joining_date: f.joining_date,
      qualification: f.qualification.trim() || null, subject: f.subject.trim() || null, address: f.address.trim() || null,
      staff_type: f.staff_type, designation: f.designation.trim() || null,
    };
    if (teacher) { if (f.employee_id.trim()) body.employee_id = f.employee_id.trim(); }
    else body.employee_id = f.employee_id.trim() || null;
    try {
      const t = await apiFetch<TeacherDetail>(teacher ? `/teachers/${teacher.id}` : "/teachers", { method: teacher ? "PATCH" : "POST", schoolId, body });
      onSaved(t);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title={teacher ? `Edit ${teacher.full_name}` : "Add teacher"}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-teacher">{teacher ? "Save" : "Add teacher"}</Button></>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="teacher-form-error">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Full name" required maxLength={150} value={f.full_name} onChange={set("full_name")} error={errors.full_name} />
          <TextField label="Employee ID" maxLength={30} value={f.employee_id} onChange={set("employee_id")} error={errors.employee_id}
            hint={teacher ? undefined : "Leave empty to number automatically (EMP0001 …)"} />
          <TextField label="Phone" required inputMode="tel" value={f.phone} onChange={set("phone")} error={errors.phone} />
          <TextField label="Email" required type="email" maxLength={254} value={f.email} onChange={set("email")} error={errors.email}
            hint="Also used for the teacher's login" />
          <TextField label="Qualification" maxLength={150} value={f.qualification} onChange={set("qualification")} hint="e.g. M.Sc, B.Ed" />
          <TextField label="Subject" maxLength={100} value={f.subject} onChange={set("subject")} hint="Main subject, e.g. Mathematics" />
          <SelectField label="Staff type" value={f.staff_type} onChange={set("staff_type")} data-testid="teacher-staff-type">
            <option value="teaching">Teaching staff (Teacher ID card)</option>
            <option value="non_teaching">Non-teaching staff (Staff ID card)</option>
          </SelectField>
          <TextField label="Designation" maxLength={60} value={f.designation} onChange={set("designation")} error={errors.designation}
            hint="Printed on the ID card, e.g. PGT Physics, Office Assistant" data-testid="teacher-designation" />
          <TextField label="Joining date" required type="date" max={todayISO()} value={f.joining_date} onChange={set("joining_date")} error={errors.joining_date} />
        </div>
        <label className="block text-sm font-medium">Address
          <textarea value={f.address} maxLength={500} rows={2} onChange={set("address")}
            className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </label>
      </div>
    </Modal>
  );
}
