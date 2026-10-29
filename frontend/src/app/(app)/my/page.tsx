"use client";

import { Suspense } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { LoadingState } from "@/components/ui/states";
import { STUDENT_TABS, StudentView } from "@/components/portal/student-view";

// No student id anywhere: the API always answers for the student linked to this login.
export default function MyPage() {
  return (
    <RequirePermission permission="self:view"><Suspense fallback={<LoadingState />}>
      <StudentView base="/my" tabs={STUDENT_TABS} title="My school record"
        notFound="No student record is linked to your account yet. Please contact the school office." />
    </Suspense></RequirePermission>
  );
}
