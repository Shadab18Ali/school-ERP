"use client";

import { use } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { StudentHomeworkView } from "@/components/homework/student-homework";

export default function MyHomeworkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <RequirePermission permission="self:view">
      <StudentHomeworkView base="/my" homeworkId={id} backLabel="My school record"
        backHref={(kind) => `/my?tab=${kind === "assignment" ? "Assignments" : "Homework"}`} />
    </RequirePermission>
  );
}
