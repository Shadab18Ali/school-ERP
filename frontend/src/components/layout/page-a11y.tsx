"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { APP_NAME } from "@/lib/pwa";

/**
 * Two things every page needs for screen readers and keyboards, done once for the whole app:
 *
 * 1. A page title that says which page this is ("Students · School ERP"), taken from the page's
 *    heading — pages are client components, so they can't set Next.js metadata themselves. Tabs,
 *    history and screen readers announce it (WCAG 2.4.2).
 * 2. Tables that scroll sideways (on a phone, most of them) can be reached and scrolled with the
 *    keyboard: a scrolling region gets tabindex=0, a region role and a name (WCAG 2.1.1).
 */
export function PageA11y() {
  const pathname = usePathname();

  useEffect(() => {
    let frame = 0;
    const apply = () => {
      frame = 0;
      const h1 = document.querySelector("main h1, h1");
      const heading = h1?.textContent?.replace(/\s+/g, " ").trim();
      const title = heading && heading !== APP_NAME ? `${heading} · ${APP_NAME}` : APP_NAME;
      if (document.title !== title) document.title = title;

      document.querySelectorAll<HTMLElement>(".overflow-x-auto, .overflow-auto").forEach((el) => {
        const scrolls = el.scrollWidth > el.clientWidth + 1;
        if (scrolls && !el.hasAttribute("data-scroll-region")) {
          el.setAttribute("data-scroll-region", "");
          el.tabIndex = 0;
          if (!el.getAttribute("role")) el.setAttribute("role", "region");
          if (!el.getAttribute("aria-label")) {
            const caption = el.querySelector("caption")?.textContent?.trim();
            const near = el.closest("section")?.querySelector("h2, h3")?.textContent?.trim();
            el.setAttribute("aria-label", caption || (near ? `${near} (scrolls sideways)` : "Table (scrolls sideways)"));
          }
        } else if (!scrolls && el.hasAttribute("data-scroll-region")) {
          el.removeAttribute("data-scroll-region");
          el.removeAttribute("tabindex");
          if (el.getAttribute("role") === "region") el.removeAttribute("role");
        }
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Next.js streams the <title> from metadata after the first paint: re-apply ours when it does
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", schedule);
    return () => { mo.disconnect(); window.removeEventListener("resize", schedule); if (frame) cancelAnimationFrame(frame); };
  }, [pathname]);

  return null;
}
