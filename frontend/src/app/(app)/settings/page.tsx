"use client";

import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { GatewaySettingsCard } from "@/components/payments/gateway-settings";
import { PlanAndBillingCard, StaffAccountsCard } from "@/components/platform/school-account";
import { useAuth } from "@/providers/auth-provider";

function SchoolSettings() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  return (
    <>
      <PageHeader title="Settings" description="School-level settings." />
      <PlanAndBillingCard schoolId={schoolId} />
      {can("staff_accounts:manage") && <StaffAccountsCard schoolId={schoolId} />}
      <GatewaySettingsCard schoolId={schoolId} />
    </>
  );
}

export default function SettingsPage() {
  return <RequirePermission permission="settings:manage"><SchoolSettings /></RequirePermission>;
}
