"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { CATEGORY_LABEL, qty, type MyItem } from "@/lib/inventory";
import { ConditionPill } from "./shared";

/** Items the school has assigned to the signed-in staff member. Shows nothing if there are none. */
export function MyItemsCard({ schoolId }: { schoolId: string }) {
  const [items, setItems] = useState<MyItem[] | null>(null);
  useEffect(() => { apiFetch<MyItem[]>("/inventory/mine", { schoolId }).then(setItems).catch(() => setItems([])); }, [schoolId]);
  if (!items || items.length === 0) return null;
  return (
    <section className="rounded-lg border border-line bg-white" data-testid="my-items">
      <div className="border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">School items in your care</h2>
        <p className="text-sm text-muted">Assigned to you in the school inventory. Tell the office if anything is missing or damaged.</p>
      </div>
      <ul className="divide-y divide-line text-sm">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <div className="min-w-0 flex-1 basis-48">
              <p className="font-medium">{i.name} <span className="text-xs font-normal text-muted">{i.item_code}</span></p>
              <p className="text-xs text-muted">{CATEGORY_LABEL[i.category]} · {i.location}{i.brand_model ? ` · ${i.brand_model}` : ""}{i.serial_number ? ` · S/N ${i.serial_number}` : ""}</p>
            </div>
            <ConditionPill condition={i.condition} />
            <span className="tabular">{qty(i.quantity, i.unit)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
