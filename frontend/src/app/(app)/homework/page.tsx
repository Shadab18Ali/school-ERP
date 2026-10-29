"use client";

import { RequirePermission } from "@/components/auth/require-permission";
import { StaffHomeworkList } from "@/components/homework/staff-homework-list";
import { PageHeader } from "@/components/layout/app-shell";
import { useAuth } from "@/providers/auth-provider";

function Homework() {
  const { currentSchool, can } = useAuth();
  return (
    <>
      <PageHeader title="Homework" description={can("teaching:view")
        ? "Homework and assignments for your classes. You can change and review the ones you set."
        : "Homework and assignments set across the school."} />
      <StaffHomeworkList schoolId={currentSchool!.school_id} />
    </>
  );
}

export default function HomeworkPage() {
  return <RequirePermission permission="homework:view"><Homework /></RequirePermission>;
}
