import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("@mobile certificates, ID cards and the verification page work on a phone without sideways scrolling", async ({ browser }) => {
  const page = await (await browser.newContext({ ...test.info().project.use })).newPage();
  await signIn(page, "ADMIN_A");
  for (const path of ["/certificates", "/certificates?tab=Issued", "/certificates?tab=Templates", "/certificates?tab=Settings",
    "/id-cards", "/id-cards?tab=Staff", "/id-cards?tab=Issued%20cards"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no sideways scroll on ${path}`).toBeLessThanOrEqual(1);
  }
  const visitor = await (await browser.newContext({ ...test.info().project.use })).newPage();
  await visitor.goto("/verify/0123456789abcdef0123456789abcdef");
  await expect(visitor.getByTestId("verify-result")).toContainText("Not found");
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
