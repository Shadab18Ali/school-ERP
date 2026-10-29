"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { personalFrom, StudentForm, type StudentFormValue } from "@/components/students/student-form";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, StudentDetail } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function EditStudent({ id }: { id: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([apiFetch<StudentDetail>(`/students/${id}`, { schoolId }), apiFetch<AcademicSession[]>("/sessions", { schoolId })])
      .then(([s, ss]) => { setStudent(s); setSessions(ss); })
      .catch((e) => setError(errorMessage(e)));
  }, [id, schoolId]);

  if (error) return <ErrorState message={error} />;
  if (!student || !sessions) return <LoadingState />;

  // Edit the current session's enrollment if there is one, else the latest open one.
  const enr = student.current_enrollment ?? student.enrollments.find((e) => !e.session_is_archived) ?? null;

  async function save(v: StudentFormValue) {
    if (!student) return;
    setSaving(true);
    setServerError(null);
    const p = v.personal;
    const personal = {
      full_name: p.full_name, father_name: p.father_name || null, mother_name: p.mother_name || null,
      date_of_birth: p.date_of_birth, gender: p.gender, mobile: p.mobile,
      alternate_mobile: p.alternate_mobile || null, address: p.address || null,
    };
    try {
      await apiFetch(`/students/${student.id}`, { method: "PATCH", schoolId, body: personal });
      if (enr && v.placement) {
        const pl = v.placement;
        const body: Record<string, string> = {};
        if (pl.class_id !== enr.class_id || pl.section_id !== enr.section_id) { body.class_id = pl.class_id; body.section_id = pl.section_id; }
        if (pl.admission_number.trim() !== enr.admission_number) body.admission_number = pl.admission_number;
        if (pl.admission_date !== enr.admission_date) body.admission_date = pl.admission_date;
        if (Object.keys(body).length) await apiFetch(`/students/${student.id}/enrollments/${enr.id}`, { method: "PATCH", schoolId, body });
      }
      toast.success("Student saved.");
      router.push(`/students/${student.id}`);
    } catch (err) {
      setServerError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title={`Edit ${student.full_name}`} description={`${student.student_code}`} />
      <StudentForm
        mode="edit"
        schoolId={schoolId}
        sessions={sessions}
        initial={{
          personal: personalFrom(student),
          placement: enr ? {
            academic_session_id: enr.academic_session_id, class_id: enr.class_id, section_id: enr.section_id,
            admission_number: enr.admission_number, admission_date: enr.admission_date,
          } : null,
          photo: null,
        }}
        enrollmentLabel={enr ? `Class & admission — ${enr.session_name}` : undefined}
        submitLabel="Save changes"
        serverError={serverError}
        saving={saving}
        onSubmit={save}
        onCancel={() => router.push(`/students/${student.id}`)}
      />
    </>
  );
}

export default function EditStudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="students:manage"><EditStudent id={id} /></RequirePermission>;
}
