import type { Metadata, Viewport } from "next";
import { PageA11y } from "@/components/layout/page-a11y";
import { ToastProvider } from "@/components/ui/toast";
import { APP_NAME, APPLE_SPLASH, THEME_COLOR } from "@/lib/pwa";
import { PwaProvider } from "@/providers/pwa-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  applicationName: APP_NAME,
  description: "School management: notices, homework, attendance, fees, results and messages.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icons/favicon-32.png", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // iPhone / iPad: full-screen app with its own name and launch screen once added to the Home Screen
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    statusBarStyle: "default", // dark text on a light bar, matching the app's white top bar
    startupImage: APPLE_SPLASH.map(([w, h, r]) => ({
      url: `/splash/apple-${w * r}x${h * r}.png`,
      media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`,
    })),
  },
  formatDetection: { telephone: false },
  // Next.js writes only the standard "mobile-web-app-capable"; iOS still needs its own tag for launch screens
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // draw under the notch / home indicator; the layout pads with safe-area insets
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PwaProvider>
          <ToastProvider>{children}</ToastProvider>
          <PageA11y />
        </PwaProvider>
      </body>
    </html>
  );
}
