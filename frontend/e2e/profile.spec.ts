import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("profile", () => {
  test("user can update their phone number and it persists", async ({ page }) => {
    await signIn(page, "TEACHER_A");
    await page.goto("/profile");
    const phone = page.getByLabel("Phone", { exact: true });
    const original = await phone.inputValue();
    const next = original === "+91 98765 43210" ? "+91 91234 56789" : "+91 98765 43210";

    await phone.fill(next);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(next);

    await page.getByLabel("Phone", { exact: true }).fill(original);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile saved.")).toBeVisible();
  });

  test("profile shows the user's role and school", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A");
    await page.goto("/profile");
    await expect(page.getByTestId("memberships")).toContainText("E2E Test School A");
    await expect(page.getByTestId("memberships")).toContainText("Accountant");
  });

  test("password change requires the correct current password", async ({ page }) => {
    await signIn(page, "STUDENT_A");
    await page.goto("/profile");
    await page.getByLabel("Current password").fill("not-my-password");
    await page.getByLabel(/^New password/).fill("Another-pass-123");
    await page.getByLabel("Confirm new password").fill("Another-pass-123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByTestId("password-error")).toHaveText("Your current password is incorrect.");
  });

  test("email cannot be edited by the user", async ({ page }) => {
    await signIn(page, "PARENT_A");
    await page.goto("/profile");
    await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();
  });
});
