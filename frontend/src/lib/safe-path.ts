/**
 * Where to go after signing in (or after an email link): only a path on this site.
 * `//evil.com`, `/\evil.com`, `/\t/evil.com` and full URLs all leave the site in a browser,
 * so the path is resolved the way the browser would and must stay on this origin.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value || !value.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const base = "https://this.site";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
