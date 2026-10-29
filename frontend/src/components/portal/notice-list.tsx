"use client";

import { Megaphone, Pin } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Notice } from "@/lib/types";

/** Notices the signed-in user may see (the database decides which). */
export function NoticeList({ schoolId, limit }: { schoolId: string; limit?: number }) {
  const [items, setItems] = useState<Notice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<Notice[]>("/notices", { schoolId }).then(setItems).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!items) return <LoadingState />;
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) return <div className="rounded-lg border border-line bg-white"><EmptyState icon={Megaphone} title="No notices right now" message="School notices will appear here." /></div>;
  return (
    <ul className="space-y-3" data-testid="notice-list">
      {shown.map((n) => (
        <li key={n.id} className="rounded-lg border border-line bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold">{n.is_pinned && <Pin className="mr-1 inline size-4 text-pencil-600" aria-label="Pinned" />}{n.title}</h3>
            <span className="whitespace-nowrap text-xs text-muted">{formatDate(n.publish_at.slice(0, 10))}</span>
          </div>
          {n.class_names.length > 0 && <p className="mt-0.5 text-xs text-muted">For {n.class_names.join(", ")}</p>}
          <p className="mt-2 whitespace-pre-line text-sm">{n.body}</p>
        </li>
      ))}
    </ul>
  );
}
