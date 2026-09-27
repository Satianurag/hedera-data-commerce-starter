import { expect, test } from "@playwright/test";

const evidenceTopic = "0.0.10725147";

test.describe("read-only template", () => {
  test("home page introduces the starter and every section is reachable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/customer app starts here/i);
    await expect(page.getByText(/testnet/i).first()).toBeVisible();

    for (const path of ["/services", "/evidence", "/sessions", "/reference", "/commerce"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("skip link moves focus to the main content", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard navigation is checked on desktop");
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await skip.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("services page shows live directory records or an honest unavailable state", async ({ page }) => {
    await page.goto("/services");
    const listed = page.getByRole("heading", { level: 1, name: "Services" });
    const unavailable = page.getByRole("heading", { level: 1, name: /could not check/i });
    await expect(listed.or(unavailable)).toBeVisible();
    if (await listed.isVisible()) {
      await expect(page.locator("main").getByRole("status")).toContainText(/directory records|no service records/);
    }
  });

  test("evidence page reads a real HCS message from the Mirror Node", async ({ page }) => {
    await page.goto("/evidence");
    await page.getByLabel("Topic ID").fill(evidenceTopic);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page).toHaveURL(new RegExp(`topic=${evidenceTopic.replaceAll(".", "\\.")}`));
    const details = page.locator("dl.details").first();
    const failure = page.locator("main").getByRole("alert");
    await expect(details.or(failure)).toBeVisible();
    if (await details.isVisible()) {
      await expect(details).toContainText(evidenceTopic);
      await expect(details).toContainText(/[0-9a-f]{64}/);
      await expect(page.getByRole("link", { name: "View topic on HashScan" }))
        .toHaveAttribute("href", `https://hashscan.io/testnet/topic/${evidenceTopic}`);
    }
  });

  test("evidence page rejects a malformed topic without calling the network", async ({ page }) => {
    await page.goto("/evidence?topic=not-a-topic");
    await expect(page.locator("main").getByRole("alert")).toContainText("valid Hedera topic");
  });

  test("pages fit a small screen without horizontal scrolling", async ({ page, isMobile }) => {
    test.skip(!isMobile, "layout overflow is checked on the mobile project");
    for (const path of ["/", "/services", "/evidence"]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("write paths are disabled by default", () => {
  for (const path of [
    "/api/customer-auth/session",
    "/api/customer-funding",
    "/api/customer-refund",
    "/api/customer-request",
    "/api/reference",
  ]) {
    test(`${path} is not exposed`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
    });
  }
});
