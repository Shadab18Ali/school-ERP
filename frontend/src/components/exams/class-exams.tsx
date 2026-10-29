"use client";

import { FileCheck2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { ExamDetail } from "@/lib/types";
import { DateSheet, ExamStatusBadge } from "./shared";

/** A teacher's class page: the class's date sheets ("schedule") or its marks entry links ("marks"). */
export function ClassExams({ schoolId, sectionId, mode }: { schoolId: string; sectionId: string; mode: "schedule" | "marks" }) {
  const [items, setItems] = useState<ExamDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<ExamDetail[]>(`/exams/class-schedule/${sectionId}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId, sectionId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  if (items.length === 0) return (
    <div className="rounded-lg border border-line bg-white" data-testid="class-exams-empty">
      <EmptyState icon={FileCheck2} title="No exams for this class yet" message="Exams appear here once the school adds this class to a date sheet." />
    </div>
  );
  return (
    <div className="space-y-4" data-testid={`class-exams-${mode}`}>
      {items.map((x) => (
        <section key={x.id} className="rounded-lg border border-line bg-white" data-testid={`class-exam-${x.name}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{x.name}</h2><ExamStatusBadge status={x.status} /></div>
            <Link href={`/exams/${x.id}?tab=results&section=${sectionId}`} className="text-sm font-medium text-leaf-700 hover:underline">Results</Link>
          </div>
          {mode === "schedule" ? <DateSheet papers={x.papers} showClass={false} /> : (
            <ul className="divide-y divide-line">
              {x.papers.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm" data-testid={`marks-link-${p.subject_name}`}>
                  <span><span className="font-medium">{p.subject_name}</span> <span className="text-muted">· out of {p.max_marks}</span></span>
                  <Link href={`/exams/${x.id}?tab=marks&section=${sectionId}&paper=${p.id}`} className="font-medium text-leaf-700 hover:underline">
                    {x.status === "published" ? "View marks" : "Enter marks"}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
