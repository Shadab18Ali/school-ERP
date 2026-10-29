import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("@mobile the library works on a phone without sideways scrolling", async ({ page }) => {
  await signIn(page, "LIBRARIAN_A");
  for (const tab of ["", "?tab=Issue%20%26%20return", "?tab=Catalogue", "?tab=Loans", "?tab=Settings"]) {
    await page.goto(`/library${tab}`);
    await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no sideways scroll on /library${tab}`).toBeLessThanOrEqual(1);
  }
});
