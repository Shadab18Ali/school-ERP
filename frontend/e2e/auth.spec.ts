import { expect, test } from "@playwright/test";
import { email, PASSWORD, signIn } from "./helpers";

test.describe("authentication", () => {
  test("signed-out visitor is sent to login and returned to the page afterwards", async ({ page }) => {
    await page.goto("/fees");
    await expect(page).toHaveURL(/\/login\?next=%2Ffees/);
    await page.getByLabel("Email").fill(email("ACCOUNTANT_A"));
    await page.getByLabel("Password").fill(PASSWORD());
    await page.getByTestId("sign-in").click();
    await expect(page).toHaveURL(/\/fees$/);
    await expect(page.getByRole("heading", { level: 1, name: "Fee structures" })).toBeVisible();
  });

  test("a deep link keeps its query string through sign-in", async ({ page }) => {
    await page.goto("/classes?tab=sections");
    await expect(page).toHaveURL(/\/login\?next=%2Fclasses%3Ftab%3Dsections/);
    await page.getByLabel("Email").fill(email("TEACHER_A"));
    await page.getByLabel("Password").fill(PASSWORD());
    await page.getByTestId("sign-in").click();
    await expect(page).toHaveURL(/\/classes\?tab=sections$/);
    await expect(page.getByRole("tab", { name: "sections" })).toHaveAttribute("aria-selected", "true");
  });

  test("every protected route redirects when signed out", async ({ page }) => {
    for (const path of ["/dashboard", "/students", "/classes", "/fees", "/attendance", "/reports", "/settings", "/profile", "/admin/schools"]) {
      await page.goto(path);
      await expect(page, `${path} should require sign-in`).toHaveURL(/\/login/);
    }
  });

  test("wrong password shows a clear error and does not sign in", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email("ADMIN_A"));
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByTestId("sign-in").click();
    await expect(page.getByTestId("form-error")).toHaveText("Email or password is incorrect.");
    await expect(page.getByLabel("Password")).toHaveValue("");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("unknown email gets the same message (no account enumeration)", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("nobody-here@example.com");
    await page.getByLabel("Password").fill("whatever-123");
    await page.getByTestId("sign-in").click();
    await expect(page.getByTestId("form-error")).toHaveText("Email or password is incorrect.");
  });

  test("sign-in button stays disabled until both fields are filled", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("sign-in")).toBeDisabled();
    await page.getByLabel("Email").fill(email("ADMIN_A"));
    await expect(page.getByTestId("sign-in")).toBeDisabled();
    await page.getByLabel("Password").fill("x");
    await expect(page.getByTestId("sign-in")).toBeEnabled();
  });

  test("signed-in user visiting /login is sent to the dashboard", async ({ page }) => {
    await signIn(page, "TEACHER_A");
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("logout ends the session", async ({ page }) => {
    await signIn(page, "ADMIN_A");
    await page.getByTestId("user-menu").click();
    await page.getByTestId("sign-out").click();
    await expect(page).toHaveURL(/\/login\?reason=signed_out/);
    await expect(page.getByTestId("form-notice")).toHaveText("You've been signed out.");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => c.name.includes("auth-token"))).toHaveLength(0);
  });

  test("Back button after logout does not show the signed-in page", async ({ page }) => {
    await signIn(page, "ADMIN_A");
    await page.goto("/classes");
    await expect(page.getByRole("heading", { level: 1, name: "Classes" })).toBeVisible();
    await page.getByTestId("user-menu").click();
    await page.getByTestId("sign-out").click();
    await expect(page).toHaveURL(/\/login/);
    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("user-menu")).toHaveCount(0);
  });

  test("losing the session cookie mid-session sends the user to login", async ({ page }) => {
    await signIn(page, "TEACHER_A");
    await page.context().clearCookies();
    await page.goto("/classes");
    await expect(page).toHaveURL(/\/login\?next=%2Fclasses$/);
  });

  test("a forged session cookie is rejected", async ({ page, context }) => {
    await signIn(page, "TEACHER_A");
    const cookies = await context.cookies();
    await context.clearCookies();
    await context.addCookies(
      cookies.filter((c) => c.name.includes("auth-token")).map((c) => ({ ...c, value: "base64-eyJhY2Nlc3NfdG9rZW4iOiJmb3JnZWQifQ" })),
    );
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("mobile navigation works and respects roles @mobile", async ({ page }) => {
    await signIn(page, "PARENT_A");
    await page.getByRole("button", { name: "Open menu" }).click();
    const nav = page.getByRole("navigation", { name: "Main" }).last();
    await expect(nav.getByRole("link", { name: "Notices" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Students" })).toHaveCount(0);
    await nav.getByRole("link", { name: "My children" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "My children" })).toBeVisible();
  });
});
