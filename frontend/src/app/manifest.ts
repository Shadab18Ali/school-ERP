import type { MetadataRoute } from "next";
import { APP_NAME, APP_SHORT_NAME, THEME_COLOR } from "@/lib/pwa";

/** The web app manifest (/manifest.webmanifest): what "Install app" / "Add to Home screen" uses. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: APP_NAME,
    short_name: APP_SHORT_NAME,
    description: "Your school on your phone: notices, homework, attendance, fees, results and messages.",
    lang: "en-IN",
    dir: "ltr",
    start_url: "/dashboard?source=app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: THEME_COLOR, // the splash screen Android builds from the icon and name
    theme_color: THEME_COLOR,
    categories: ["education", "productivity"],
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // long-press the app icon (Android) / right-click (desktop); each page shows what the person may see
    shortcuts: [
      { name: "Notifications", url: "/notifications?source=app", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Notices", url: "/notices?source=app", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Home", url: "/dashboard?source=app", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
