"use client";

import { use } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { StudentHomeworkView } from "@/components/homework/student-homework";

export default function ChildHomeworkPage({ params }: { params: Promise<{ studentId: string; homeworkId: string }> }) {
  const { studentId, homeworkId } = use(params);
  return (
    <RequirePermission permission="portal:view">
      <StudentHomeworkView base={`/portal/children/${studentId}`} homeworkId={homeworkId} backLabel="Back to child"
        backHref={() => `/portal/${studentId}?tab=Homework`} />
    </RequirePermission>
  );
}
