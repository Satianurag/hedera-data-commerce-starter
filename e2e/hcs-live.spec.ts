import { expect, test } from "@playwright/test";
import { expectHcsMessage } from "./hcs-assertions";

// Opt-in read-only live integration: no fixture preload, no browser routes.
// The viewer displays latest, so use a dedicated topic with no later submissions.
test("live Mirror HCS has exactly the independently recorded evidence", async ({ page }) => {
  const required = (name: string): string => {
    const value = process.env[`E2E_HCS_${name}`];
    if (!value) throw new Error(`E2E_HCS_${name} is required; a live test must not silently skip its fixture`);
    return value;
  };
  const topic = required("TOPIC_ID");
  const payer = required("PAYER_ACCOUNT_ID");
  const sequence = Number(required("FINAL_SEQUENCE"));
  const byteLength = Number(required("BYTE_LENGTH"));
  const sha256 = required("SHA256");
  expect(topic).toMatch(/^\d+\.\d+\.\d+$/);
  expect(payer).toMatch(/^\d+\.\d+\.\d+$/);
  expect(Number.isSafeInteger(sequence) && sequence > 0).toBe(true);
  expect(Number.isSafeInteger(byteLength) && byteLength > 0).toBe(true);
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  await page.goto(`/evidence?topic=${topic}`);
  await expectHcsMessage(page, { topic, payer, sequence, byteLength, sha256 });
  if (process.env.E2E_HCS_REQUIRE_SIGNED === "1") {
    await expect(page.getByText(/Its recovered key also matches the HCS payer/)).toBeVisible();
  }
});
