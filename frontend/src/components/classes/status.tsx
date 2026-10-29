import { clsx } from "clsx";

/** Status pill shared by classes and sections. */
export function RecordStatusBadge({ active, deleted }: { active: boolean; deleted?: boolean }) {
  const label = deleted ? "Deleted" : active ? "Active" : "Inactive";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        deleted ? "bg-danger-50 text-danger-600" : active ? "bg-leaf-50 text-leaf-700" : "bg-pencil-100 text-ink",
      )}
    >
      <span className={clsx("size-1.5 rounded-full", deleted ? "bg-danger-600" : active ? "bg-leaf-600" : "bg-pencil-400")} />
      {label}
    </span>
  );
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}
