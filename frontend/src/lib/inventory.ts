export type Category = "computer" | "furniture" | "laboratory" | "sports" | "stationery" | "electronics" | "other";
export type Unit = "piece" | "set" | "pair" | "box" | "pack" | "ream" | "dozen" | "kg" | "litre" | "metre" | "roll" | "bottle";
export type Condition = "new" | "good" | "fair" | "needs_repair" | "damaged" | "unusable";
export type ItemState = "active" | "low" | "attention" | "assigned" | "archived" | "all";
export type InReason = "opening" | "purchase" | "donation" | "returned" | "found" | "adjustment";
export type OutReason = "issued" | "consumed" | "damaged" | "lost" | "disposed" | "returned_to_vendor" | "adjustment";

export const CATEGORIES: Category[] = ["computer", "furniture", "laboratory", "sports", "stationery", "electronics", "other"];
export const CATEGORY_LABEL: Record<Category, string> = {
  computer: "Computer", furniture: "Furniture", laboratory: "Laboratory", sports: "Sports",
  stationery: "Stationery", electronics: "Electronics", other: "Other",
};
export const UNITS: Unit[] = ["piece", "set", "pair", "box", "pack", "ream", "dozen", "kg", "litre", "metre", "roll", "bottle"];
export const MEASURED: Unit[] = ["kg", "litre", "metre"];
export const CONDITIONS: Condition[] = ["new", "good", "fair", "needs_repair", "damaged", "unusable"];
export const CONDITION_LABEL: Record<Condition, string> = {
  new: "New", good: "Good", fair: "Fair", needs_repair: "Needs repair", damaged: "Damaged", unusable: "Unusable",
};
export const IN_REASONS: [InReason, string][] = [
  ["purchase", "Purchase"], ["donation", "Donation"], ["returned", "Returned"], ["found", "Found"],
  ["opening", "Opening stock"], ["adjustment", "Adjustment (recount)"],
];
export const OUT_REASONS: [OutReason, string][] = [
  ["issued", "Issued"], ["consumed", "Used up"], ["damaged", "Damaged"], ["lost", "Lost"],
  ["disposed", "Disposed of"], ["returned_to_vendor", "Returned to vendor"], ["adjustment", "Adjustment (recount)"],
];
export const REASON_LABEL: Record<string, string> = {
  ...Object.fromEntries(IN_REASONS), ...Object.fromEntries(OUT_REASONS),
  opening: "Opening stock", adjustment: "Adjustment", details: "Details changed",
};

export interface Item {
  id: string; item_code: string; name: string; category: Category; unit: Unit; brand_model: string | null; serial_number: string | null;
  description: string | null; quantity: string; min_quantity: string | null; unit_cost: string | null; purchase_date: string | null;
  vendor: string | null; location: string; condition: Condition; assigned_teacher_id: string | null; assigned_to: string | null;
  assigned_employee_id: string | null; is_active: boolean; notes: string | null; created_at: string; updated_at: string;
  value: string | null; is_low: boolean;
}
export interface ItemList { items: Item[]; total: number; page: number; page_size: number }

export interface Movement {
  id: string; item_id: string; item_code: string; item_name: string; category: Category; unit: Unit;
  kind: "in" | "out" | "change"; reason: string; quantity: string; balance_after: string; moved_on: string;
  unit_cost: string | null; total_cost: string | null; vendor: string | null; reference: string | null;
  teacher_id: string | null; teacher_name: string | null; recipient: string | null; note: string | null;
  changes: Record<string, { from: string | boolean | null; to: string | boolean | null }> | null;
  created_at: string; recorded_by: string | null;
}
export interface MovementList { items: Movement[]; total: number; page: number; page_size: number }

export interface InventoryDashboard {
  items: number; archived: number; value: string; items_without_cost: number; low_stock: number; out_of_stock: number;
  needs_attention: number; assigned: number; month_in: number; month_out: number; month_spent: string; year_spent: string;
  by_category: { category: Category; items: number; quantity: string; value: string }[];
  low_stock_items: { id: string; item_code: string; name: string; category: Category; unit: Unit; quantity: string; min_quantity: string; location: string }[];
  attention_items: { id: string; item_code: string; name: string; category: Category; condition: Condition; quantity: string; unit: Unit; location: string }[];
  recent: Movement[];
}

export interface StaffOption { id: string; full_name: string; employee_id: string }
export interface MyItem {
  id: string; item_code: string; name: string; category: Category; unit: Unit; quantity: string;
  brand_model: string | null; serial_number: string | null; location: string; condition: Condition;
}

const PLURAL: Partial<Record<Unit, string>> = { box: "boxes", dozen: "dozen", kg: "kg" };

/** "20.00", "ream" -> "20 reams"; "2.50", "kg" -> "2.5 kg"; "1.00", "piece" -> "1 piece". */
export function qty(amount: string | number | null, unit?: Unit): string {
  if (amount === null) return "—";
  const n = Number(amount);
  const s = n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (!unit) return s;
  return `${s} ${n === 1 ? unit : PLURAL[unit] ?? `${unit}s`}`;
}

export const isMeasured = (u: Unit) => MEASURED.includes(u);
