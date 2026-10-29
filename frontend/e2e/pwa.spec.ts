import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, signIn } from "./helpers";

// Phase 29: the installable app — manifest and icons, service worker, offline shell, and push
// notifications end to end. Push uses a stand-in push service (backend/tests/e2e_support/mock_push.py,
// port 9996): it plays the phone, so the test sees the decrypted message exactly as a phone would.
test.describe.configure({ mode: "serial", timeout: 120_000 });
// full Chromium, as on phones and desktops (the lightweight headless shell has no notifications)
test.use({ channel: "chromium" });
const MOCK_PUSH = process.env.E2E_MOCK_PUSH_URL ?? "http://localhost:9996";
const tag = runTag();

async function asUser(browser: Browser, who: Parameters<typeof signIn>[1]): Promise<{ page: Page; ctx: BrowserContext }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, who);
  return { page, ctx };
}

async function swReady(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // the worker takes charge of the open page by itself (clients.claim), with no reload
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("the app is installable: manifest, icons, service worker (Chrome's own check)", async ({ page, request }) => {
  await page.goto("/login");
  await swReady(page);
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  // test browsers are incognito profiles, which Chrome never offers to install from; nothing else may be wrong
  expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
  const { errors } = await cdp.send("Page.getAppManifest");
  expect(errors).toEqual([]);

  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/dashboard?source=app", scope: "/", theme_color: "#1b362b" });
  expect(manifest.icons.map((i: { purpose: string; sizes: string }) => `${i.purpose} ${i.sizes}`))
    .toEqual(["any 192x192", "any 512x512", "maskable 192x192", "maskable 512x512"]);
  for (const icon of manifest.icons) expect((await request.get(icon.src)).headers()["content-type"]).toBe("image/png");
  expect(manifest.shortcuts.map((s: { url: string }) => s.url)).toContain("/notifications?source=app");
  // iPhone / iPad: home-screen icon and launch screens
  const html = await (await request.get("/login")).text();
  expect(html).toContain('rel="apple-touch-icon"');
  expect(html).toContain('name="apple-mobile-web-app-capable"');
  const splash = [...html.matchAll(/href="(\/splash\/apple-\d+x\d+\.png)"[^>]*rel="apple-touch-startup-image"/g)].map((m) => m[1]);
  expect(splash.length).toBeGreaterThanOrEqual(15);
  for (const s of splash.slice(0, 3)) expect((await request.get(s)).status()).toBe(200);
});

test("offline: opened pages keep working as a shell, others show the offline page; data is never cached", async ({ browser }) => {
  const { page, ctx } = await asUser(browser, "TEACHER_A");
  await swReady(page);
  await page.goto("/notices");
  await expect(page.getByRole("heading", { level: 1, name: "Notices" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("offline-banner")).toBeVisible();                    // the app knows it's offline
  await expect(page.getByText(/You're offline\. Connect to the internet/).first()).toBeVisible(); // its data needs the network
  await page.goto("/teaching/timetable");                                              // never opened: the offline page
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await ctx.setOffline(false);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My timetable" })).toBeVisible();
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);

  // only page shells are kept: no API answers in the caches
  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(req.url);
    return out;
  });
  expect(cached.some((u) => u.includes("/notices"))).toBe(true);
  expect(cached.filter((u) => u.includes(":8000") || u.includes("/api/"))).toEqual([]);

  // signing out forgets the cached pages
  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("pages-")).length)).toBe(0);
  await ctx.close();
});

test("push: a teacher turns on notifications; a school notice reaches the phone, encrypted end to end", async ({ browser }) => {
  const tt = await accessToken("TEACHER_A");    // start clean (an earlier interrupted run may have left a device)
  for (const d of await (await api("/push/subscriptions", tt)).json()) await api(`/push/subscriptions/${d.id}`, tt, { method: "DELETE" });
  // a "phone" from the stand-in push service: real P-256 keys, its own address
  const device = await (await fetch(`${MOCK_PUSH}/new-subscription`, { method: "POST" })).json();
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["notifications"], { origin: "http://localhost:3000" });
  // the browser's push service is the stand-in (headless Chromium can't reach Google's)
  await ctx.addInitScript((dev) => {
    const KEY = "e2e.fake-push";
    const make = (key: ArrayBuffer | null) => ({
      endpoint: dev.endpoint, expirationTime: null, options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint: dev.endpoint, expirationTime: null, keys: dev.keys }),
      unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
    });
    PushManager.prototype.subscribe = async function (opts?: PushSubscriptionOptionsInit) {
      localStorage.setItem(KEY, "1");
      const k = opts?.applicationServerKey;
      return make(k instanceof ArrayBuffer ? k : k ? (k as Uint8Array).buffer as ArrayBuffer : null) as unknown as PushSubscription;
    };
    PushManager.prototype.getSubscription = async function () {
      return (localStorage.getItem(KEY) ? make(null) : null) as unknown as PushSubscription;
    };
  }, device);
  const page = await ctx.newPage();
  await signIn(page, "TEACHER_A");
  await swReady(page);

  await page.goto("/profile");
  await expect(page.getByTestId("push-state")).toHaveAttribute("data-state", "off");
  await page.getByTestId("push-on").click();
  await expect(page.getByTestId("push-state")).toHaveAttribute("data-state", "on");

  const t = await accessToken("TEACHER_A");
  const mine = await (await api("/push/subscriptions", t)).json();
  expect(mine).toHaveLength(1);
  expect(mine[0].device_label).toMatch(/Chrome/);
  expect(JSON.stringify(mine)).not.toContain(device.endpoint);                      // the address never comes back

  // a test notification from the profile page
  await page.getByTestId("push-test").click();
  await expect(page.getByText("Test sent.")).toBeVisible();

  // a real one: the admin publishes a notice for staff
  const title = `Staff meeting ${tag}`;
  const ta = await accessToken("ADMIN_A");
  expect((await api("/notices", ta, { method: "POST", school: SCHOOL_A(), body: { title, body: "In the library at 3 pm.", audience: "staff" } })).status).toBe(201);
  let got: { payload: { title: string; body: string; url: string; tag: string; school: string } | null; vapid_ok: boolean; encoding: string }[] = [];
  await expect.poll(async () => {
    got = await (await fetch(`${MOCK_PUSH}/received/${device.id}`)).json();
    return got.map((g) => g.payload?.title);
  }, { timeout: 30_000 }).toContain(title);
  const msg = got.find((g) => g.payload?.title === title)!;
  expect(msg.vapid_ok).toBe(true);
  expect(msg.encoding).toBe("aes128gcm");
  expect(msg.payload).toMatchObject({ body: "In the library at 3 pm.", url: "/notices", school: "E2E Test School A" });

  // deliver it to the app's service worker, as the phone's push service would: a notification appears
  const cdp = await ctx.newCDPSession(page);
  const regId = new Promise<string>((resolve) => cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
    const r = e.registrations.find((x) => x.scopeURL.startsWith("http://localhost:3000/"));
    if (r) resolve(r.registrationId);
  }));
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: "http://localhost:3000", registrationId: await regId, data: JSON.stringify(msg.payload) });
  await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}|${n.body}`)))
    .toContain(`${title}|In the library at 3 pm.`);

  // a shared phone: hiding details puts only the school's name on the lock screen
  await expect(page.getByText("Test sent.")).toBeHidden();   // the toast sits over the bottom of the page for a few seconds
  await page.getByTestId("push-hide-details").check();
  const title2 = `Pay revision ${tag}`;
  await api("/notices", ta, { method: "POST", school: SCHOOL_A(), body: { title: title2, body: "Confidential", audience: "staff" } });
  await expect.poll(async () => {
    got = await (await fetch(`${MOCK_PUSH}/received/${device.id}`)).json();
    return got.at(-1)?.payload;
  }, { timeout: 30_000 }).toMatchObject({ title: "E2E Test School A", body: "You have a new notification. Open the app to read it." });
  expect(JSON.stringify(got.at(-1))).not.toContain("Confidential");

  // signing out stops this phone getting the teacher's notifications
  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login/);
  expect(await (await api("/push/subscriptions", await accessToken("TEACHER_A"))).json()).toEqual([]);
  await ctx.close();
});

test("push devices are private to each person", async () => {
  const device = await (await fetch(`${MOCK_PUSH}/new-subscription`, { method: "POST" })).json();
  const tp = await accessToken("PARENT_A");
  const r = await api("/push/subscriptions", tp, { method: "POST", body: { endpoint: device.endpoint, keys: device.keys, device_label: "Parent phone" } });
  expect(r.status).toBe(201);
  const id = (await r.json()).id;
  const tt = await accessToken("TEACHER_A");
  expect(await (await api("/push/subscriptions", tt)).json()).toEqual([]);
  expect((await api(`/push/subscriptions/${id}`, tt, { method: "DELETE" })).status).toBe(404);
  // only real browser push services are accepted
  const bad = await api("/push/subscriptions", tp, { method: "POST", body: { endpoint: "https://attacker.example/x", keys: device.keys } });
  expect(bad.status).toBe(422);
  expect((await api(`/push/subscriptions/${id}`, tp, { method: "DELETE" })).status).toBe(204);
});
