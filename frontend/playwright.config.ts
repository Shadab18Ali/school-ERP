import { defineConfig, devices } from "@playwright/test";

// Supabase URL/key come from .env.local; test accounts from .env.e2e
// (created by backend/scripts/create_test_accounts.py).
for (const file of [".env.local", ".env.e2e"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* optional */
  }
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // shared test accounts; also keeps us under Supabase auth rate limits
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
