import { config } from "@/lib/config";

export type OnlineStatus = "created" | "paid" | "failed" | "cancelled" | "needs_review" | "refund_pending" | "refunded" | "refund_failed";

export const ONLINE_STATUS_LABEL: Record<OnlineStatus, string> = {
  created: "Not completed", paid: "Paid", failed: "Failed", cancelled: "Cancelled", needs_review: "Needs review",
  refund_pending: "Refund in progress", refunded: "Refunded", refund_failed: "Refund failed",
};
/** What a parent reads for each status. */
export const PARENT_STATUS_HINT: Partial<Record<OnlineStatus, string>> = {
  created: "Not completed. If money left your account, use “Check status”.",
  failed: "The payment did not go through. No money was taken, or it will be returned by your bank.",
  needs_review: "Received; the school office will confirm it with you.",
  refund_pending: "A refund has been started. It reaches your account in 5–7 working days.",
  refunded: "Refunded to your account.",
};

export interface OnlineRefund { gateway_refund_id: string; amount: string; status: "pending" | "processed" | "failed"; reason: string; failure_reason: string | null; created_at: string; processed_at: string | null }
export interface OnlinePayment {
  id: string; student_id: string; student_name: string; class_section: string; amount: string; description: string; status: OnlineStatus;
  method: string | null; method_detail: string | null; failure_reason: string | null; gateway_order_id: string | null; gateway_payment_id: string | null;
  fee_payment_id: string | null; receipt_number: string | null; verified_via: string | null; refunded_amount: string; created_at: string; paid_at: string | null;
  refunds: OnlineRefund[]; events?: { event_type: string; outcome: string | null; received_at: string }[];
}
export interface OrderOut {
  online_payment_id: string; key_id: string; order_id: string; amount: string; amount_paise: number; currency: "INR";
  name: string; description: string; prefill: { name: string; email: string; contact: string };
}
export interface CheckoutSuccess { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }
export interface CheckoutFailure { error: { code?: string; description?: string; reason?: string; metadata?: { payment_id?: string; order_id?: string } } }

interface RazorpayInstance { open(): void; on(event: "payment.failed", cb: (r: CheckoutFailure) => void): void }
declare global {
  interface Window { Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance }
}

let loading: Promise<void> | null = null;
/** Loads Razorpay Checkout once. */
export function loadCheckout(): Promise<void> {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = config.razorpayCheckoutUrl;
    s.async = true;
    s.onload = () => (window.Razorpay ? resolve() : reject(new Error("Couldn't load the payment window.")));
    s.onerror = () => { loading = null; reject(new Error("Couldn't load the payment window. Check your internet connection.")); };
    document.body.appendChild(s);
  });
  return loading;
}

/**
 * Opens Checkout for a server-created order. Resolves with what Checkout reports;
 * the caller must still have the server verify it — Checkout's word alone counts for nothing.
 */
export function openCheckout(order: OrderOut): Promise<{ kind: "success"; data: CheckoutSuccess } | { kind: "failed"; data: CheckoutFailure } | { kind: "dismissed" }> {
  return new Promise((resolve) => {
    let settled = false;
    let lastFailure: CheckoutFailure | null = null; // Checkout stays open after a failure so the parent can retry
    const done = (v: Parameters<typeof resolve>[0]) => { if (!settled) { settled = true; resolve(v); } };
    const rzp = new window.Razorpay!({
      key: order.key_id,
      order_id: order.order_id,
      amount: order.amount_paise,
      currency: order.currency,
      name: order.name,
      description: order.description,
      prefill: order.prefill,
      // UPI, cards and net banking only
      method: { upi: true, card: true, netbanking: true, wallet: false, emi: false, paylater: false },
      theme: { color: "#2f6b57" },
      retry: { enabled: true },
      handler: (data: CheckoutSuccess) => done({ kind: "success", data }),
      modal: { ondismiss: () => done(lastFailure ? { kind: "failed", data: lastFailure } : { kind: "dismissed" }) },
    });
    rzp.on("payment.failed", (data) => { lastFailure = data; });
    rzp.open();
  });
}
