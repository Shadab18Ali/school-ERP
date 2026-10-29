"use client";

import { clsx } from "clsx";
import { Star } from "lucide-react";
import Link from "next/link";
import type { MyClass } from "@/lib/types";

/** One card per section assigned to the signed-in teacher. */
export function MyClassesGrid({ items, today }: { items: MyClass[]; today: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((c) => {
        const done = c.students > 0 && c.marked_today >= c.students;
        return (
          <div key={c.section_id} className="flex flex-col rounded-lg border border-line bg-white p-5" data-testid={`my-class-${c.class_name}-${c.section_name}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <Link href={`/teaching/${c.section_id}`} className="text-lg font-semibold hover:underline">{c.class_name} – {c.section_name}</Link>
                <p className="text-xs text-muted">{c.subjects.length ? c.subjects.join(", ") : "All subjects"}</p>
              </div>
              {c.is_class_teacher && <span className="inline-flex items-center gap-1 rounded-full bg-pencil-100 px-2 py-0.5 text-xs"><Star className="size-3" aria-hidden /> Class teacher</span>}
            </div>
            <dl className="tabular mt-4 grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-muted">Students</dt><dd className="font-medium" data-testid="my-class-students">{c.students}</dd></div>
              <div><dt className="text-xs text-muted">Attendance</dt><dd className="font-medium">{c.attendance_percentage ? `${c.attendance_percentage}%` : "—"}</dd></div>
            </dl>
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
              <span className={clsx("text-xs", done ? "text-leaf-700" : "text-danger-600")} data-testid="my-class-today">
                {c.students === 0 ? "No students" : done ? "Today's attendance marked" : `Today: ${c.marked_today} of ${c.students} marked`}
              </span>
              {c.students > 0 && <Link href={`/attendance?section=${c.section_id}&date=${today}`} className="text-sm font-medium text-leaf-700 hover:underline">Mark attendance</Link>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
