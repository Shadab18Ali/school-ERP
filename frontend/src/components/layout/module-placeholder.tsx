import type { LucideIcon } from "lucide-react";
import { PageHeader } from "./app-shell";

interface Props {
  title: string;
  description: string;
  icon: LucideIcon;
  /** What this module will let people do, in plain words. */
  plannedFor: string[];
}

/** Honest placeholder for modules that are not built yet. Shows no sample data. */
export function ModulePlaceholder({ title, description, icon: Icon, plannedFor }: Props) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <section className="rounded-lg border border-line bg-white">
        <div className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:p-8">
          <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-leaf-50 text-leaf-700">
            <Icon className="size-6" aria-hidden />
          </div>
          <div className="max-w-xl">
            <h2 className="font-semibold">This module isn&apos;t set up yet</h2>
            <p className="mt-1 text-sm text-muted">It&apos;s scheduled for an upcoming phase. When it&apos;s ready you&apos;ll be able to:</p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {plannedFor.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-pencil-400" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
