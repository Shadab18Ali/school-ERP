import { expect, test } from "@playwright/test";
import { accessToken, API_URL, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

// UI hides what you can't use; these tests call the API directly to prove the
// server refuses it too.
test.describe("school isolation (API)", () => {
  let adminA = "";
  let adminB = "";
  let teacherA = "";

  test.beforeAll(async () => {
    [adminA, adminB, teacherA] = await Promise.all([accessToken("ADMIN_A"), accessToken("ADMIN_B"), accessToken("TEACHER_A")]);
  });

  const get = (path: string, token?: string, school?: string) =>
    fetch(`${API_URL()}/api/v1${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(school ? { "X-School-Id": school } : {}) },
    });

  test("admin of School A can open School A", async () => {
    const res = await get("/school", adminA, SCHOOL_A());
    expect(res.status).toBe(200);
    expect((await res.json()).school.id).toBe(SCHOOL_A());
  });

  test("admin of School A is refused School B", async () => {
    expect((await get("/school", adminA, SCHOOL_B())).status).toBe(403);
  });

  test("admin of School B is refused School A", async () => {
    expect((await get("/school", adminB, SCHOOL_A())).status).toBe(403);
  });

  test("teacher of School A is refused School B", async () => {
    expect((await get("/school", teacherA, SCHOOL_B())).status).toBe(403);
  });

  test("/me lists only the caller's own school", async () => {
    const me = await (await get("/me", adminA)).json();
    expect(me.memberships.map((m: { school_id: string }) => m.school_id)).toEqual([SCHOOL_A()]);
  });

  test("school admins cannot use platform endpoints", async () => {
    expect((await get("/admin/schools", adminA)).status).toBe(403);
    const patch = await fetch(`${API_URL()}/api/v1/admin/schools/${SCHOOL_B()}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(patch.status).toBe(403);
  });

  test("requests without a valid token are refused", async () => {
    expect((await get("/me")).status).toBe(401);
    expect((await get("/me", "not-a-real-token")).status).toBe(401);
    expect((await get("/school", adminA.slice(0, -4) + "AAAA", SCHOOL_A())).status).toBe(401);
  });

  test("users cannot promote themselves", async () => {
    const res = await fetch(`${API_URL()}/api/v1/me`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ is_super_admin: true }),
    });
    expect(res.status).toBe(422);
  });
});

test("dashboard shows only the user's own school", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await expect(page.getByTestId("current-school")).toHaveText("E2E Test School A");
  await expect(page.getByText("E2E Test School B")).toHaveCount(0);
});
