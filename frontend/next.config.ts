import type { NextConfig } from "next";

const origin = (url: string | undefined, fallback = "") => {
  try { return url ? new URL(url).origin : fallback; } catch { return fallback; }
};
const isProd = process.env.NODE_ENV === "production";
const api = origin(process.env.NEXT_PUBLIC_API_URL, "http://localhost:8000");
const supabase = origin(process.env.NEXT_PUBLIC_SUPABASE_URL);
const checkout = origin(process.env.NEXT_PUBLIC_RAZORPAY_CHECKOUT_URL, "https://checkout.razorpay.com");
const razorpay = ["https://checkout.razorpay.com", "https://api.razorpay.com", "https://lumberjack.razorpay.com"];

/**
 * What a page may load and talk to. A script injected into a page could still run (Next needs inline
 * scripts), but it couldn't load code from elsewhere or send anything to a server we don't use, and
 * the app can't be framed by another site.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} ${checkout}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabase}`,
  "font-src 'self' data:",
  `connect-src 'self' ${api} ${supabase} ${supabase.replace(/^http/, "ws")} ${checkout} ${razorpay.join(" ")}`,
  `frame-src 'self' blob: ${checkout} ${razorpay.join(" ")}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProd && api.startsWith("https://") ? ["upgrade-insecure-requests"] : []),
].join("; ");

// A production build that talks to the API or Supabase over plain http would leak every sign-in
// token on the network (and browsers block it as mixed content): refuse to build it.
if (isProd && process.env.NEXT_PHASE !== "phase-development-server") {
  for (const [name, url] of [["NEXT_PUBLIC_API_URL", api], ["NEXT_PUBLIC_SUPABASE_URL", supabase]] as const) {
    if (url && url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
      throw new Error(`${name} must be https:// in a production build (got ${url}).`);
    }
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // the Docker image runs the self-contained server (frontend/Dockerfile); `next start` is unchanged
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  async headers() {
    return [
      {
        // the service worker must never be served stale, or updates would not reach installed apps
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/(icons|splash|fonts)/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
