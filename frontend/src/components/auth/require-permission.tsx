"use client";

import { Lock, PackageX, School } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/states";
import { isSchoolPermission } from "@/lib/permissions";
import { ROLE_LABELS, type Permission, type PlanFeatureKey } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

/**
 * Shows children only when the signed-in user holds the permission in the active
 * school. This is a UX layer: the API enforces the same rules on every request.
 */
export function RequirePermission({ permission, feature, children }: { permission: Permission; feature?: PlanFeatureKey; children: ReactNode }) {
  const { loading, me, can, currentSchool, hasFeature } = useAuth();

  if (loading && !me) return <LoadingState />;
  if (can(permission) && feature && !hasFeature(feature)) {
    return (
      <Notice
        icon={PackageX}
        title={`${FEATURE_TITLE[feature]} aren't part of your school's plan`}
        message={can("settings:manage")
          ? "See what your plan includes under School settings → Plan and billing, or ask the platform for a larger plan."
          : "Ask your school administrator if you need them."}
        action={can("settings:manage") ? <Link href="/settings"><Button variant="secondary">Plan and billing</Button></Link> : undefined}
        testId="feature-not-in-plan"
      />
    );
  }
  if (can(permission)) return <>{children}</>;

  if (isSchoolPermission(permission) && !currentSchool) {
    return (
      <Notice
        icon={School}
        title="No school selected"
        message={
          me?.is_super_admin
            ? "School pages open inside a school. Platform administrators manage schools from the Schools page."
            : "Your account isn't linked to an active school yet. Ask your school administrator to add you."
        }
        action={me?.is_super_admin ? <Link href="/admin/schools"><Button variant="secondary">Go to Schools</Button></Link> : undefined}
      />
    );
  }

  const roles = currentSchool?.roles.map((r) => ROLE_LABELS[r]).join(", ");
  return (
    <Notice
      icon={Lock}
      title="You don't have access to this page"
      message={`${roles ? `Your role (${roles}) doesn't include this area. ` : ""}If you need it, ask your school administrator.`}
      action={<Link href="/dashboard"><Button variant="secondary">Back to dashboard</Button></Link>}
    />
  );
}

const FEATURE_TITLE: Record<PlanFeatureKey, string> = {
  reports: "Reports", analytics: "Analytics", whatsapp: "WhatsApp notifications", ai_assistant: "AI assistant features", website_builder: "Website tools",
};

function Notice({ icon: Icon, title, message, action, testId = "access-denied" }: { icon: typeof Lock; title: string; message: string; action?: ReactNode; testId?: string }) {
  return (
    <section className="mx-auto mt-8 max-w-lg rounded-lg border border-line bg-white px-6 py-12 text-center" role="alert" data-testid={testId}>
      <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-paper text-muted"><Icon className="size-6" aria-hidden /></div>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}
