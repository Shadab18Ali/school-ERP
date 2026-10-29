/** App identity for the installed app (name under the icon, colours of the title bar and splash screen). */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "School ERP";
export const APP_SHORT_NAME = process.env.NEXT_PUBLIC_APP_SHORT_NAME || APP_NAME.split(" ")[0].slice(0, 12) || "School";
export const THEME_COLOR = "#1b362b"; // --color-board-900

/** iOS launch screens (public/splash, made by scripts/generate-pwa-assets.py): css size × pixel ratio. */
export const APPLE_SPLASH: [number, number, number][] = [
  [320, 568, 2], [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2], [414, 896, 3], [360, 780, 3],
  [390, 844, 3], [428, 926, 3], [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3],
  [768, 1024, 2], [810, 1080, 2], [820, 1180, 2], [834, 1194, 2], [834, 1112, 2], [1024, 1366, 2],
];

/** True inside the installed app (home-screen icon), on every platform. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** A short description of this device for the "your devices" list, e.g. "Android · Chrome". */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : isIos() ? (/iPad/.test(ua) || navigator.maxTouchPoints > 1 && /Mac/.test(ua) ? "iPad" : "iPhone")
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}${isStandalone() ? " (app)" : ""}`;
}
