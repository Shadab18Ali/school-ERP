"use client";

import { Suspense, use } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { LoadingState } from "@/components/ui/states";
import { PARENT_TABS, StudentView } from "@/components/portal/student-view";

export default function ChildPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  return (
    <RequirePermission permission="portal:view"><Suspense fallback={<LoadingState />}>
      <StudentView base={`/portal/children/${studentId}`} tabs={PARENT_TABS} backHref="/portal" backLabel="My children"
        notFound="We couldn't find this child on your account." />
    </Suspense></RequirePermission>
  );
}
