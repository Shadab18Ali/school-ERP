import { expect, test } from "@playwright/test";
import { accessToken, api, png, runTag, SCHOOL_B, signIn } from "./helpers";

test.describe("super admin: schools", () => {
  test("add a school with registration details, logo and first session", async ({ page }) => {
    const tag = runTag();
    const code = `E2E-T${tag}`;
    const udise = String(Date.now()).slice(-11).padStart(11, "1");
    await signIn(page, "SUPER", "/admin/schools");

    await page.getByRole("button", { name: "Add school" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^School name/).fill(`E2E Temp School ${tag}`);
    await dialog.getByLabel(/^School code/).fill(code);
    await dialog.getByLabel(/^Established/).fill("1998");
    await dialog.getByLabel(/^Email/).fill(`office-${tag.toLowerCase()}@example.com`);
    await dialog.getByLabel(/^Phone/).fill("+91 98100 00000");
    await dialog.getByLabel(/^Address/).fill("12 Ring Road");
    await dialog.getByLabel(/^City/).fill("New Delhi");
    await dialog.getByLabel(/^PIN code/).fill("110025");
    await dialog.getByLabel("Board / affiliation").selectOption("CBSE");
    await dialog.getByLabel(/^Affiliation number/).fill(`27${tag}`);
    await dialog.getByLabel(/^Registration number/).fill(`SOC/${tag}/1998`);

    // client-side validation
    await dialog.getByLabel(/^UDISE/).fill("123");
    await dialog.getByRole("button", { name: "Create school" }).click();
    await expect(dialog.getByText("UDISE+ codes are 11 digits.")).toBeVisible();
    await dialog.getByLabel(/^UDISE/).fill(udise);
    await dialog.getByRole("button", { name: "Create school" }).click();

    // lands on the detail page
    await expect(page).toHaveURL(/\/admin\/schools\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: `E2E Temp School ${tag}` })).toBeVisible();
    const reg = page.getByTestId("registration-details");
    await expect(reg).toContainText("CBSE");
    await expect(reg).toContainText(udise);
    await expect(reg).toContainText("1998");

    // logo: a bad file is refused, a real PNG is accepted, then removed
    await page.getByTestId("logo-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("not really a png") });
    await expect(page.getByText("That file isn't a valid PNG, JPEG or WebP image.")).toBeVisible();
    await page.getByTestId("logo-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png() });
    await expect(page.getByText("Logo updated.")).toBeVisible();
    const logo = page.getByTestId("school-logo");
    await expect(logo).toHaveAttribute("src", /\/storage\/v1\/object\/public\/school-logos\/.+\.png$/);
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Logo removed.")).toBeVisible();
    await expect(page.getByTestId("school-logo")).toHaveCount(0);

    // first session of a new school becomes current automatically
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByLabel(/^Starts on/).fill("2026-04-01");
    await page.getByRole("button", { name: "Create session" }).click();
    await expect(page.getByTestId("current-session-name")).toHaveText("2026-27");

    // the list finds it by code
    await page.getByRole("link", { name: "All schools" }).click();
    await page.getByLabel("Search schools").fill(code);
    await expect(page.getByRole("link", { name: new RegExp(code) })).toBeVisible();
  });

  test("duplicate school code is refused", async ({ page }) => {
    await signIn(page, "SUPER", "/admin/schools");
    await page.getByRole("button", { name: "Add school" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^School name/).fill("Duplicate Code School");
    await dialog.getByLabel(/^School code/).fill("E2E-A");
    await dialog.getByRole("button", { name: "Create school" }).click();
    await expect(dialog.getByTestId("school-form-error")).toHaveText("Another school already uses this code.");
  });

  test("deactivating a school locks its users out; activating restores access", async ({ page, browser }) => {
    const superToken = await accessToken("SUPER");
    try {
      await signIn(page, "SUPER", `/admin/schools/${SCHOOL_B()}`);
      await page.getByTestId("toggle-status").click();
      await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
      await expect(page.getByText("This school is inactive.")).toBeVisible();
      await expect(page.getByTestId("toggle-status")).toHaveText("Activate");

      const other = await browser.newPage();
      await signIn(other, "ADMIN_B");
      await expect(other.getByText("You're not linked to a school yet")).toBeVisible();
      await other.goto("/sessions");
      await expect(other.getByTestId("access-denied")).toBeVisible();
      await other.close();

      await page.getByTestId("toggle-status").click();
      await page.getByRole("dialog").getByRole("button", { name: "Activate" }).click();
      await expect(page.getByText("This school is inactive.")).toHaveCount(0);
    } finally {
      await api(`/admin/schools/${SCHOOL_B()}`, superToken, { method: "PATCH", body: { status: "active" } });
    }
  });

  test("school admins cannot open school management or upload logos", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/admin/schools/${SCHOOL_B()}`);
    await expect(page.getByTestId("access-denied")).toBeVisible();
    const token = await accessToken("ADMIN_A");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png())], { type: "image/png" }), "logo.png");
    const res = await fetch(`${process.env.E2E_API_URL ?? process.env.NEXT_PUBLIC_API_URL}/api/v1/admin/schools/${SCHOOL_B()}/logo`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    expect(res.status).toBe(403);
  });
});
