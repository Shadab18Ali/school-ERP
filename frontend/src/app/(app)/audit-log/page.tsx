"use client";

import { AuditLog } from "@/components/audit/audit-log";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { useAuth } from "@/providers/auth-provider";

function SchoolAudit() {
  const { currentSchool } = useAuth();
  return (
    <>
      <PageHeader title="Audit log"
        description="Who did what in your school, and when: sign-ins, students, receipts, attendance changes, people and roles, settings. Entries can't be changed or deleted." />
      <AuditLog base="/audit" schoolId={currentSchool!.school_id} />
    </>
  );
}

export default function AuditLogPage() {
  return <RequirePermission permission="audit:view"><SchoolAudit /></RequirePermission>;
}
