"use client";

import { useEffect, useState } from "react";
import { AuditLog } from "@/components/audit/audit-log";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { apiFetch } from "@/lib/api";

function PlatformAudit() {
  const [schools, setSchools] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    apiFetch<{ items: { id: string; name: string }[] }>("/admin/schools?page_size=100").then((r) => setSchools(r.items)).catch(() => {});
  }, []);
  return (
    <>
      <PageHeader title="Platform audit log"
        description="Every school's log and the platform's own events. Payroll entries are kept for each school's own administrators and aren't shown here." />
      <AuditLog base="/admin/audit" platform schools={schools} />
    </>
  );
}

export default function PlatformAuditPage() {
  return <RequirePermission permission="platform:schools.manage"><PlatformAudit /></RequirePermission>;
}
