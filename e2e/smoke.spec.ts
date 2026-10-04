import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectHcsMessage, type HcsExpectation } from "./hcs-assertions";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/hcs.json"), "utf8"),
) as HcsExpectation & {
  outageTopic: string;
  emptyTopic: string;
  incompleteTopic: string;
  tamperedTopic: string;
};
const multichunk = JSON.parse(
  readFileSync(join(__dirname, "fixtures/hcs-multichunk.json"), "utf8"),
) as HcsExpectation;

test.describe("read-only template", () => {
  test("home page introduces the starter and every section is reachable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /build your next data-service app/i,
    );
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

  test("services page honestly shows the deterministic empty directory", async ({ page }) => {
    await page.goto("/services");
    await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible();
    await expect(page.locator("main").getByRole("status")).toContainText("no service records");
  });

  test("evidence page verifies exact HCS bytes and payer key (server fixture)", async ({
    page,
  }) => {
    await page.goto("/evidence");
    await page.getByLabel("Topic ID").fill(fixture.topic);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page).toHaveURL(new RegExp(`topic=${fixture.topic.replaceAll(".", "\\.")}`));
    await expectHcsMessage(page, fixture);
    await expect(page.getByText(/Its recovered key also matches the HCS payer/)).toBeVisible();
  });

  test("Mirror outage renders an error without evidence (server fixture)", async ({ page }) => {
    await page.goto(`/evidence?topic=${fixture.outageTopic}`);
    await expect(page.locator("main").getByRole("alert")).toContainText("could not be checked");
    await expect(page.locator("dl.details")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View topic on HashScan" })).toHaveCount(0);
  });

  test("paginated and interleaved HCS chunks produce exact signed bytes (server fixture)", async ({
    page,
  }) => {
    await page.goto(`/evidence?topic=${multichunk.topic}`);
    await expectHcsMessage(page, multichunk);
    await expect(page.getByText(/Its recovered key also matches the HCS payer/)).toBeVisible();
  });

  test("empty topic is distinct from a successfully read message (server fixture)", async ({
    page,
  }) => {
    await page.goto(`/evidence?topic=${fixture.emptyTopic}`);
    await expect(page.locator("main").getByRole("status")).toContainText("returned no messages");
    await expect(page.locator("dl.details")).toHaveCount(0);
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  });

  test("incomplete chunks cannot claim success (server fixture)", async ({ page }) => {
    await page.goto(`/evidence?topic=${fixture.incompleteTopic}`);
    await expect(page.locator("main").getByRole("alert")).toContainText("could not be checked");
    await expect(page.locator("dl.details")).toHaveCount(0);
  });

  test("tampered signature is rejected even when Mirror bytes exist (server fixture)", async ({
    page,
  }) => {
    await page.goto(`/evidence?topic=${fixture.tamperedTopic}`);
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "envelope was detected but rejected",
    );
    await expect(page.locator("dl.details")).toHaveCount(1);
    await expect(page.getByText(/Its recovered key also matches the HCS payer/)).toHaveCount(0);
  });

  test("evidence page rejects a malformed topic without calling the network", async ({ page }) => {
    await page.goto("/evidence?topic=not-a-topic");
    await expect(page.locator("main").getByRole("alert")).toContainText("valid Hedera topic");
  });

  test("pages fit a small screen without horizontal scrolling", async ({ page, isMobile }) => {
    test.skip(!isMobile, "layout overflow is checked on the mobile project");
    for (const path of ["/", "/services", "/evidence"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
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
