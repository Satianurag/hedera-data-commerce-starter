import { expect, type Page } from "@playwright/test";

export type HcsExpectation = {
  topic: string;
  payer: string;
  sequence: number;
  byteLength: number;
  sha256: string;
};

export async function expectHcsMessage(page: Page, expected: HcsExpectation) {
  const main = page.locator("main");
  await expect(main.getByRole("alert")).toHaveCount(0);
  const details = main.locator("dl.details").first();
  await expect(details).toBeVisible();
  for (const [label, value] of Object.entries({
    Topic: expected.topic,
    Payer: expected.payer,
    Sequence: expected.sequence,
    "Payload bytes": expected.byteLength,
    "SHA-256": expected.sha256,
  })) {
    await expect(
      details
        .locator("div")
        .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) })
        .locator("dd"),
    ).toHaveText(String(value));
  }
  await expect(page.getByRole("link", { name: "View topic on HashScan" })).toHaveAttribute(
    "href",
    `https://hashscan.io/testnet/topic/${expected.topic}`,
  );
}
