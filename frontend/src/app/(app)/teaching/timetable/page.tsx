"use client";

import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { TimetablePanel } from "@/components/timetable/timetable-grid";
import { useAuth } from "@/providers/auth-provider";

function MyTimetable() {
  const { currentSchool } = useAuth();
  return (
    <>
      <PageHeader title="My timetable" description="Your lessons across all your classes this session." />
      <TimetablePanel path="/teaching/timetable" schoolId={currentSchool!.school_id}
        emptyMessage="Your login isn't linked to a teacher record yet. Please ask the school office." />
    </>
  );
}

export default function TeachingTimetablePage() {
  return <RequirePermission permission="teaching:view"><MyTimetable /></RequirePermission>;
}
