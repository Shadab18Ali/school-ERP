"use client";

import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { SessionsManager } from "@/components/sessions/sessions-manager";
import { useAuth } from "@/providers/auth-provider";

function Sessions() {
  const { currentSchool, can, refresh } = useAuth();
  if (!currentSchool) return null;
  const canManage = can("sessions:manage");
  return (
    <>
      <PageHeader
        title="Academic sessions"
        description={canManage
          ? "Choose the school's current year, prepare the next one, and archive finished years."
          : "School years for this school. Only administrators can change them."}
      />
      <SessionsManager schoolId={currentSchool.school_id} canManage={canManage} onCurrentChanged={refresh} />
    </>
  );
}

export default function SessionsPage() {
  return (
    <RequirePermission permission="sessions:view">
      <Sessions />
    </RequirePermission>
  );
}
