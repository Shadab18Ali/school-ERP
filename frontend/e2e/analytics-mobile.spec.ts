import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("@mobile analytics work on a phone: filters on top, charts fit, tables open, no sideways scrolling", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  for (const tab of ["students", "fees", "admissions"]) {
    await page.goto(`/analytics?tab=${tab}`);
    await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
    await expect(page.getByTestId(`analytics-${tab}`)).toBeVisible();
    await expect(page.getByTestId("filter-period")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no sideways scroll on ${tab}`).toBeLessThanOrEqual(1);
    // every chart card fits the screen
    const widest = await page.evaluate(() => Math.max(...[...document.querySelectorAll("figure")].map((f) => f.getBoundingClientRect().right)));
    expect(widest).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  }
  // a chart's table view on a phone
  await page.goto("/analytics?tab=fees");
  await page.getByTestId("chart-methods-table").click();
  await expect(page.getByTestId("chart-methods").getByRole("table")).toBeVisible();
});
