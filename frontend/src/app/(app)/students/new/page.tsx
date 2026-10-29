"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { personalFrom, StudentForm, type StudentFormValue } from "@/components/students/student-form";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { todayISO } from "@/lib/format";
import type { AcademicSession, StudentDetail } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function NewStudent() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<AcademicSession[]>("/sessions", { schoolId }).then(setSessions).catch((e) => setError(errorMessage(e)));
  }, [schoolId]);

  if (error) return <ErrorState message={error} />;
  if (!sessions) return <LoadingState />;
  const current = sessions.find((s) => s.is_current && !s.is_archived) ?? sessions.find((s) => !s.is_archived);
  if (!current) return <ErrorState message="There's no open academic session to admit students into. Create one first." />;

  async function save(v: StudentFormValue) {
    setSaving(true);
    setServerError(null);
    const p = v.personal;
    try {
      const created = await apiFetch<StudentDetail>("/students", {
        method: "POST", schoolId,
        body: {
          full_name: p.full_name, father_name: p.father_name || null, mother_name: p.mother_name || null,
          date_of_birth: p.date_of_birth, gender: p.gender, mobile: p.mobile,
          alternate_mobile: p.alternate_mobile || null, address: p.address || null,
          enrollment: v.placement,
        },
      });
      if (v.photo) {
        const form = new FormData();
        form.append("file", v.photo);
        try {
          await apiFetch(`/students/${created.id}/photo`, { method: "POST", schoolId, body: form });
        } catch (err) {
          toast.error(`Student saved, but the photo wasn't: ${errorMessage(err)}`);
        }
      }
      toast.success(`${created.full_name} added as ${created.student_code}.`);
      router.push(`/students/${created.id}`);
    } catch (err) {
      setServerError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Add student" description={`Admission into ${current.name}`} />
      <StudentForm
        mode="create"
        schoolId={schoolId}
        sessions={sessions}
        initial={{
          personal: personalFrom(null),
          placement: { academic_session_id: current.id, class_id: "", section_id: "", admission_number: "", admission_date: todayISO() },
          photo: null,
        }}
        submitLabel="Add student"
        serverError={serverError}
        saving={saving}
        onSubmit={save}
        onCancel={() => router.push("/students")}
      />
    </>
  );
}

export default function NewStudentPage() {
  return <RequirePermission permission="students:manage"><NewStudent /></RequirePermission>;
}
