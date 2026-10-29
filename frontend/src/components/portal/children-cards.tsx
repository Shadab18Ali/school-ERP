"use client";

import { HeartHandshake } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/states";
import { formatINR } from "@/lib/money";
import type { PortalChild } from "@/lib/types";

const REL: Record<string, string> = { father: "Father", mother: "Mother", guardian: "Guardian", other: "Family" };

export function ChildrenCards({ items, hrefFor }: { items: PortalChild[]; hrefFor?: (c: PortalChild) => string }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState icon={HeartHandshake} title="No children linked yet"
          message="Your school links your account to your child. If your child is missing, please contact the school office." />
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => (
        <Link key={c.student_id} href={hrefFor ? hrefFor(c) : `/portal/${c.student_id}`} data-testid={`child-${c.student_code}`}
          className="flex gap-4 rounded-lg border border-line bg-white p-5 transition-colors hover:border-leaf-600">
          {c.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.photo_url} alt="" className="size-14 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="grid size-14 shrink-0 place-items-center rounded-full bg-leaf-50 text-lg font-semibold text-leaf-700" aria-hidden>
              {c.full_name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold">{c.full_name}</p>
            <p className="text-xs text-muted">{c.class_section ?? "Not enrolled"}{c.session_name ? ` · ${c.session_name}` : ""}{c.relationship !== "self" && <> · you: {REL[c.relationship] ?? c.relationship}</>}</p>
            <dl className="tabular mt-2 flex gap-4 text-sm">
              <div><dt className="text-xs text-muted">Attendance</dt><dd data-testid="child-attendance">{c.attendance_percentage ? `${c.attendance_percentage}%` : "—"}</dd></div>
              <div><dt className="text-xs text-muted">Fees due</dt><dd data-testid="child-outstanding" className={Number(c.outstanding) > 0 ? "text-danger-600" : ""}>{c.outstanding ? formatINR(c.outstanding) : "—"}</dd></div>
            </dl>
          </div>
        </Link>
      ))}
    </div>
  );
}
