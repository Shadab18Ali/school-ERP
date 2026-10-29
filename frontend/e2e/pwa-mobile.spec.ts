import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { signIn } from "./helpers";

// Phase 29 on a phone: each kind of user gets their own bottom tabs, the full menu under "More",
// install prompts in their own terms (Android's install dialog; Safari's Add-to-Home-Screen steps),
// and no sideways scrolling anywhere.
test.describe.configure({ mode: "serial", timeout: 120_000 });

async function phone(browser: Browser, who: Parameters<typeof signIn>[1], opts: Parameters<Browser["newContext"]>[0] = {}): Promise<Page> {
  const page = await (await browser.newContext({ ...test.info().project.use, ...opts })).newPage();
  await signIn(page, who);
  return page;
}

async function noSidewaysScroll(page: Page, where: string) {
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `no sideways scroll on ${where}`).toBeLessThanOrEqual(1);
}

const tabsOf = (page: Page) => page.getByTestId("bottom-nav").getByRole("link");

test("@mobile parents, teachers, students and admins each get their own bottom tabs", async ({ browser }) => {
  const expected = {
    PARENT_A: ["parent", ["Home", "Children", "Notices", "Alerts"]],
    TEACHER_A: ["teacher", ["Home", "My classes", "Timetable", "Homework"]],
    STUDENT_A: ["student", ["Home", "Homework", "Timetable", "Results"]],
    ADMIN_A: ["admin", ["Home", "Students", "Collect", "Attendance"]],
    ACCOUNTANT_A: ["accountant", ["Home", "Collect", "Payments", "Students"]],
  } as const;
  for (const [who, [persona, labels]] of Object.entries(expected) as [keyof typeof expected, (typeof expected)[keyof typeof expected]][]) {
    const page = await phone(browser, who);
    await expect(page.getByTestId("bottom-nav")).toHaveAttribute("data-persona", persona);
    await expect(tabsOf(page)).toHaveText([...labels]);
    await expect(page.getByTestId("tab-home")).toHaveAttribute("aria-current", "page");
    await noSidewaysScroll(page, `${who} dashboard`);
    await page.context().close();
  }
});

test("@mobile a teacher's tabs open their pages; More opens the full menu", async ({ browser }) => {
  const page = await phone(browser, "TEACHER_A");
  await page.getByTestId("tab-timetable").click();
  await expect(page.getByRole("heading", { level: 1, name: "My timetable" })).toBeVisible();
  await expect(page.getByTestId("tab-timetable")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("tab-my-classes")).not.toHaveAttribute("aria-current", "page");   // the more specific match wins
  await noSidewaysScroll(page, "teacher timetable");
  await page.getByTestId("tab-more").click();
  const drawer = page.getByTestId("menu-drawer");
  await expect(drawer.getByRole("link", { name: "My profile" })).toBeVisible();
  await drawer.getByRole("link", { name: "Notices" }).click();
  await expect(page.getByTestId("menu-drawer")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Notices" })).toBeVisible();
  // the page's last item can be scrolled clear of the tab bar
  const pad = await page.locator("main").evaluate((m) => parseFloat(getComputedStyle(m).paddingBottom));
  const bar = await page.getByTestId("bottom-nav").evaluate((n) => n.getBoundingClientRect().height);
  expect(pad).toBeGreaterThanOrEqual(bar);
  await page.context().close();
});

test("@mobile a student's tabs go straight to homework, timetable and results", async ({ browser }) => {
  const page = await phone(browser, "STUDENT_A");
  for (const [tab, name] of [["tab-homework", "Homework"], ["tab-timetable", "Timetable"], ["tab-results", "Results"]] as const) {
    await page.getByTestId(tab).click();
    await expect(page).toHaveURL(new RegExp(`/my\\?tab=${name}$`));
    await expect(page.getByTestId(tab)).toHaveAttribute("aria-current", "page");
    // when the login is linked to a record (other suites link it), the record opens on that tab
    const record = page.getByRole("tablist", { name: "Child information" });
    if (await record.count()) await expect(record.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  await page.context().close();
});

test("@mobile Android: the install card offers the browser's install dialog, in a parent's terms", async ({ browser }) => {
  const page = await phone(browser, "PARENT_A");
  await page.evaluate(() => localStorage.removeItem("erp.dismiss.install"));
  // what Chrome on Android fires when the app can be installed
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt") as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    e.prompt = async () => { (window as unknown as { __prompted: boolean }).__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  const card = page.getByTestId("install-card");
  await expect(card).toContainText("Your child's attendance, fees, homework and school notices");
  await card.getByTestId("install-app").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
  await expect(page.getByText("Installed. Find it on your home screen.")).toBeVisible();
  await expect(page.getByTestId("install-card")).toHaveCount(0);
  await page.context().close();
});

test("@mobile iPhone: Safari users get the Add-to-Home-Screen steps; 'not now' is remembered", async ({ browser }) => {
  const iphone = devices["iPhone 13"];
  const page = await phone(browser, "TEACHER_A", { userAgent: iphone.userAgent, viewport: iphone.viewport });
  const card = page.getByTestId("install-card");
  await expect(card).toContainText("Your classes, attendance, timetable and homework from your phone");
  await card.getByTestId("ios-how").click();
  await expect(page.getByTestId("ios-steps")).toContainText("Add to Home Screen");
  await noSidewaysScroll(page, "iPhone dashboard");
  await page.getByTestId("install-card-dismiss").click();
  await expect(page.getByTestId("install-card")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("bottom-nav")).toBeVisible();
  await expect(page.getByTestId("install-card")).toHaveCount(0);          // not asked again for 30 days
  // on iPhone, notifications need the installed app: the profile says how
  await page.goto("/profile");
  await expect(page.getByTestId("push-state")).toHaveAttribute("data-state", "ios-needs-install");
  await expect(page.getByTestId("push-state")).toContainText("Add to Home Screen");
  await noSidewaysScroll(page, "iPhone profile");
  await page.context().close();
});

test("@mobile the offline page fits a phone", async ({ browser }) => {
  const ctx = await browser.newContext({ ...test.info().project.use });
  const page = await ctx.newPage();
  await page.goto("/offline.html");
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  const tryAgain = page.getByRole("button", { name: "Try again" });
  expect((await tryAgain.boundingBox())!.height).toBeGreaterThanOrEqual(44);   // a comfortable tap target
  await noSidewaysScroll(page, "offline page");
  await ctx.close();
});
