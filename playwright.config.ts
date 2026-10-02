import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3210);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const live = process.env.E2E_LIVE === "1";
const authPort = port + 1;
const authURL = `http://127.0.0.1:${authPort}`;
if (process.env.E2E_BASE_URL && !live) throw new Error("E2E_BASE_URL is only supported with E2E_LIVE=1; deterministic tests own their fixture server");

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
    { name: "desktop", testMatch: live ? "hcs-live.spec.ts" : "smoke.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", testMatch: live ? "hcs-live.spec.ts" : "smoke.spec.ts", use: { ...devices["Pixel 7"] } },
    ...(!live ? [{ name: "wallet-simulation", testMatch: ["wallet.spec.ts", "recovery-ui.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: authURL } }] : []),
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : [{
    command: `node e2e/fixtures/start-server.mjs${live ? " --live" : ""}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(port) },
  }, ...(!live ? [{ command: "node e2e/fixtures/start-server.mjs --auth", url: authURL,
    reuseExistingServer: false, timeout: 60_000, env: { PORT: String(authPort) } }] : [])],
});
