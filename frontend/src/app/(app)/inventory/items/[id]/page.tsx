"use client";

import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { MovementRow } from "@/components/inventory/history";
import { ConditionPill, ItemFormModal, Section, StockFlags, StockModal } from "@/components/inventory/shared";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Pagination } from "@/components/ui/pagination";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CATEGORY_LABEL, qty, type Item, type MovementList } from "@/lib/inventory";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

const PAGE_SIZE = 50;

function ItemView({ id }: { id: string }) {
  const { can, currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const manage = can("inventory:manage");
  const [item, setItem] = useState<Item | null>(null);
  const [history, setHistory] = useState<MovementList | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [stock, setStock] = useState<"in" | "out" | null>(null);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [i, h] = await Promise.all([
        apiFetch<Item>(`/inventory/items/${id}`, { schoolId }),
        apiFetch<MovementList>(`/inventory/items/${id}/history`, { schoolId, query: { page, page_size: PAGE_SIZE } }),
      ]);
      setItem(i); setHistory(h);
    } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId, page]);
  useEffect(() => { void load(); }, [load]);

  async function setActive(active: boolean) {
    if (!item) return;
    setBusy(true);
    const keys = ["name", "category", "unit", "brand_model", "serial_number", "description", "min_quantity", "unit_cost", "purchase_date", "vendor", "location", "condition", "assigned_teacher_id", "notes"] as const;
    const body = { ...Object.fromEntries(keys.map((k) => [k, item[k]])), is_active: active };
    try { await apiFetch(`/inventory/items/${id}`, { schoolId, method: "PUT", body }); toast.success(active ? "Restored." : "Archived."); setConfirm(null); await load(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await apiFetch(`/inventory/items/${id}`, { schoolId, method: "DELETE" }); toast.success("Item deleted."); router.push("/inventory?tab=Items"); }
    catch (e) { toast.error(errorMessage(e)); setConfirm(null); } finally { setBusy(false); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!item || !history) return <LoadingState />;
  const row = (label: string, value: React.ReactNode, testId?: string) => <div><dt className="text-muted">{label}</dt><dd className="font-medium" data-testid={testId}>{value || "—"}</dd></div>;

  return (
    <div className="space-y-6">
      <Link href="/inventory?tab=Items" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Items</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="item-heading">{item.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {item.item_code} · {CATEGORY_LABEL[item.category]}
            <ConditionPill condition={item.condition} /><StockFlags i={item} />
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {item.is_active && <Button size="sm" onClick={() => setStock("in")} data-testid="stock-in"><ArrowDownLeft className="size-4" /> Stock in</Button>}
            {item.is_active && <Button size="sm" variant="secondary" onClick={() => setStock("out")} disabled={Number(item.quantity) === 0} data-testid="stock-out"><ArrowUpRight className="size-4" /> Stock out</Button>}
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="edit-item"><Pencil className="size-4" /> Edit</Button>
            <ActionMenu label="More item actions" actions={[
              item.is_active ? { label: "Archive…", onSelect: () => setConfirm("archive") } : { label: "Restore", onSelect: () => void setActive(true) },
              { label: "Delete…", onSelect: () => setConfirm("delete"), tone: "danger" },
            ]} />
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-6">
          <div className="rounded-lg border border-line bg-white p-5">
            <p className="text-sm text-muted">In stock</p>
            <p className="tabular mt-1 text-3xl font-semibold tracking-tight" data-testid="item-quantity">{qty(item.quantity, item.unit)}</p>
            <p className="mt-1 text-sm text-muted">{item.value ? `Worth ${formatINR(item.value)} at ${formatINR(item.unit_cost)} each` : "No cost recorded"}{item.min_quantity ? ` · reorder at ${qty(item.min_quantity)}` : ""}</p>
          </div>
          <dl className="space-y-3 rounded-lg border border-line bg-white p-5 text-sm">
            {row("Location", item.location, "item-location-value")}
            {row("Assigned to", item.assigned_to ? `${item.assigned_to} (${item.assigned_employee_id})` : "Nobody (school stock)", "item-assignee-value")}
            {row("Purchase date", item.purchase_date ? formatDate(item.purchase_date) : null)}
            {row("Cost per unit", item.unit_cost ? formatINR(item.unit_cost) : null)}
            {row("Vendor", item.vendor)}
            {row("Brand / model", item.brand_model)}
            {row("Serial number", item.serial_number)}
            {item.description && row("Description", item.description)}
            {item.notes && row("Notes", item.notes)}
          </dl>
        </div>
        <Section title={`History (${history.total})`} testId="item-history">
          {history.items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No stock recorded yet.{manage ? " Use Stock in to add what the school has." : ""}</p> : (
            <>
              <ul className="divide-y divide-line">{history.items.map((m) => <MovementRow key={m.id} m={m} showItem={false} />)}</ul>
              <Pagination page={page} pageSize={PAGE_SIZE} total={history.total} onChange={setPage} />
            </>
          )}
        </Section>
      </div>

      <ItemFormModal schoolId={schoolId} open={editing} item={item} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); toast.success("Saved."); void load(); }} />
      <StockModal schoolId={schoolId} item={stock ? item : null} kind={stock ?? "in"} onClose={() => setStock(null)}
        onDone={(i) => { const k = stock; setStock(null); toast.success(`${k === "in" ? "Added" : "Taken out"}. ${qty(i.quantity, i.unit)} in stock now.`); void load(); }} />
      <ConfirmDialog open={confirm === "archive"} tone="primary" title={`Archive ${item.name}?`}
        message="Archived items are hidden from the lists and can't take stock in or out. The history stays, and you can restore it." confirmLabel="Archive"
        loading={busy} onConfirm={() => setActive(false)} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === "delete"} title={`Delete ${item.name}?`}
        message="Only an item entered by mistake (nothing recorded beyond its first stock) can be deleted. Anything with stock history is kept; archive it instead."
        confirmLabel="Delete item" loading={busy} onConfirm={remove} onCancel={() => setConfirm(null)} />
    </div>
  );
}

export default function InventoryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="inventory:view"><ItemView id={id} /></RequirePermission>;
}
