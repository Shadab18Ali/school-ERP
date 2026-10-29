/**
 * Central place for public (browser-safe) configuration.
 * Only NEXT_PUBLIC_* values may appear here. Server secrets never belong in the frontend.
 */
export const config = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, ""),
  apiPrefix: "/api/v1",
  // Razorpay Checkout (overridable only for local testing)
  razorpayCheckoutUrl: process.env.NEXT_PUBLIC_RAZORPAY_CHECKOUT_URL || "https://checkout.razorpay.com/v1/checkout.js",
} as const;
