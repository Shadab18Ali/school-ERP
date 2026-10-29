import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("@mobile the notification bell and inbox work on a phone", async ({ page }) => {
  await signIn(page, "PARENT_A");
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  const box = await page.getByTestId("notification-menu").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); // fits on the screen
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByTestId("notifications-see-all").click();
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
});
