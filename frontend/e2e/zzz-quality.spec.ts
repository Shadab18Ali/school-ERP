import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, SCHOOL_A, signIn, type Account } from "./helpers";

/**
 * Production-quality sweep (Phase 34), run last on the data the other suites created: every page each
 * role can open (from its own menu) plus the main detail pages, on a desktop and on a 390 px phone:
 *
 * - no serious or critical accessibility problems (axe, WCAG 2.1 A/AA);
 * - nothing pushes the page sideways on a phone;
 * - no script errors and no server errors (5xx) from the API;
 * - the page has its own title, and has finished loading.
 *
 * Each page is checked once, by the first role that reaches it (dashboards for every role).
 */

const ROLES: Account[] = ["ADMIN_A", "ACCOUNTANT_A", "TEACHER_A", "LIBRARIAN_A", "PARENT_A", "STUDENT_A", "SUPER"];
const seen = new Set<string>();

async function detailPages(): Promise<string[]> {
  const t = await accessToken("ADMIN_A");
  const first = async (path: string): Promise<string | null> => {
    const r = await api(path, t, { school: SCHOOL_A() });
    if (!r.ok) return null;
    const j = await r.json();
    const items = Array.isArray(j) ? j : j.items;
    return items?.[0]?.id ?? null;
  };
  const [student, teacher, exam, homework, structure] = await Promise.all([
    first("/students?page_size=1"), first("/teachers?page_size=1"), first("/exams"), first("/homework?page_size=1"), first("/fee-structures"),
  ]);
  return [
    student && `/students/${student}`, student && `/students/${student}/edit`, student && `/fees/collect/${student}`,
    teacher && `/teachers/${teacher}`, exam && `/exams/${exam}`, homework && `/homework/${homework}`,
    structure && `/fees/structures/${structure}`,
  ].filter((u): u is string => Boolean(u));
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await expect(page.locator('[role="status"]', { hasText: /Loading/ })).toHaveCount(0, { timeout: 15_000 });
}

async function check(page: Page, url: string, problems: string[]) {
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(`script error: ${e.message.slice(0, 160)}`);
  const onResponse = (r: import("@playwright/test").Response) => {
    if (r.status() >= 500) errors.push(`${r.status()} from ${r.request().method()} ${new URL(r.url()).pathname}`);
  };
  page.on("pageerror", onError);
  page.on("response", onResponse);
  for (const [vp, size] of [["desktop", { width: 1366, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.goto(url);
    await settle(page);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const v of axe.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
      problems.push(`${url} [${vp}] ${v.id}: ${v.help} — ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
    }
    const sideways = await page.evaluate(() => document.scrollingElement!.scrollWidth - document.documentElement.clientWidth);
    if (vp === "phone" && sideways > 1) problems.push(`${url} [phone] the page scrolls sideways by ${sideways}px`);
    const title = await page.title();
    if (!/ · /.test(title)) problems.push(`${url} [${vp}] page title is only "${title}"`);
  }
  page.off("pageerror", onError);
  page.off("response", onResponse);
  problems.push(...errors.map((e) => `${url}: ${e}`));
}

test.describe.configure({ mode: "serial" });

for (const role of ROLES) {
  test(`quality sweep: ${role}'s pages`, async ({ page }) => {
    test.setTimeout(600_000);
    await signIn(page, role);
    await settle(page);
    const menu = await page.locator("nav a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
    const extra = role === "ADMIN_A" ? await detailPages() : [];
    const urls = [...new Set([...menu, ...extra])].filter((u) => u === "/dashboard" || !seen.has(u));
    urls.forEach((u) => seen.add(u));
    const problems: string[] = [];
    for (const u of urls) await check(page, u, problems);
    expect(problems, `${role}: ${urls.length} pages checked`).toEqual([]);
  });
}

test("quality sweep: public pages", async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  for (const u of ["/login", "/verify/not-a-real-code"]) await check(page, u, problems);
  expect(problems).toEqual([]);
});
