import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, message, action }: { icon: LucideIcon; title: string; message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-3 rounded-full bg-leaf-50 p-3 text-leaf-600"><Icon className="size-6" aria-hidden /></div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center" role="alert">
      <div className="mb-3 rounded-full bg-danger-50 p-3 text-danger-600"><AlertTriangle className="size-6" aria-hidden /></div>
      <h3 className="font-semibold">This couldn&apos;t be loaded</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry && <Button variant="secondary" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function StatusBadge({ status }: { status: "active" | "suspended" }) {
  return status === "active" ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-leaf-50 px-2 py-0.5 text-xs font-medium text-leaf-700">
      <span className="size-1.5 rounded-full bg-leaf-600" /> Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-pencil-100 px-2 py-0.5 text-xs font-medium text-ink">
      <span className="size-1.5 rounded-full bg-pencil-400" /> Inactive
    </span>
  );
}
