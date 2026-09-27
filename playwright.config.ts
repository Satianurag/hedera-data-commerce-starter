import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3210);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: "node packages/nextjs/scripts/start.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { PORT: String(port), HEDERA_NETWORK: process.env.HEDERA_NETWORK ?? "testnet", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
