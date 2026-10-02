import { expect, test, type Page } from "@playwright/test";

// UI state/serialization regressions only: API and EIP-1193 are explicitly
// simulated. Separate route tests and live testnet runs verify chain outcomes.
const buyer = "0x0000000000000000000000000000000000000001";
const hash = `0x${"c".repeat(64)}`;
const firstAttempt = "a".repeat(32);
const fundingId = "f".repeat(32);
const otherId = "e".repeat(32);
type Kind = "funding" | "refund" | "approval";

async function scenario(page: Page, kind: Kind, options: { unopened?: boolean; expired?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const funding = { id: fundingId, quoteIntentId: "q", state: kind === "funding" ? "prepared" : "executed",
    contractState: kind === "funding" ? null : "funded", walletAttemptId: firstAttempt,
    walletOpenedAt: options.unopened ? null : now - 61, runtimeSha256: "a".repeat(64), abiPinned: true,
    abandonedAt: null, transactionHash: null, reportedHash: null, observedHash: null, escrowId: "10",
    termsHash: `0x${"a".repeat(64)}`, contractId: "0.0.123", contractAddress: buyer, sellerAddress: buyer,
    sellerAccountId: "0.0.456", amountTinybar: "1000000", quoteExpiresAt: now + 900,
    refundAfter: kind === "approval" ? now + 900 : now - 1, preparedAt: now - 180,
    settlementHash: null, settlementMirrorTimestamp: null, settlementRecipientAddress: null,
    settlementAmountTinybar: null, settlementVerifiedAt: null };
  const other = { ...funding, id: otherId, escrowId: "20", preparedAt: now - 300 };
  const record = { id: "d".repeat(32), fundingId, state: kind === "approval" ? "wallet-opened" : "prepared",
    walletAttemptId: firstAttempt, walletOpenedAt: now - 61, walletOpenCount: 1, acknowledgedAt: now - 61,
    transactionHash: null as string | null, reportedHash: null as string | null, observedHash: null,
    escrowId: "10", amountTinybar: "1000000", preparedAt: now - 100, requestTopic: "0.0.789",
    requestSequence: 7, transportBytes: 100, transportOpenedAt: new Date().toISOString(),
    transportClosedAt: new Date().toISOString() };
  const calls: Record<string, unknown>[] = [];
  await page.addInitScript(({ buyer }) => {
    const events = new Map<string, Set<() => void>>();
    const provider = { async request({ method }: { method: string }) {
      if (method === "eth_accounts") return [buyer];
      if (method === "eth_chainId") return "0x128";
      if (method === "eth_sendTransaction") {
        (window as unknown as { promptOpened: boolean }).promptOpened = true;
        await new Promise<void>(resolve => { (window as unknown as { rejectWallet(): void }).rejectWallet = resolve; });
        throw Object.assign(new Error("User rejected request"), { code: 4001 });
      }
      throw new Error(`Unexpected simulated provider call: ${method}`);
    }, on(event: string, callback: () => void) {
      if (!events.has(event)) events.set(event, new Set()); events.get(event)!.add(callback);
    }, removeListener(event: string, callback: () => void) { events.get(event)?.delete(callback); } };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider",
      { detail: { info: { uuid: "recovery-ui", name: "Simulated recovery wallet", rdns: "test.neuron" }, provider } })));
  }, { buyer });
  await page.route("**/api/customer-**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/customer-commerce") return route.fulfill({ status: 404, json: {} });
    if (url.pathname === "/api/customer-auth/session") return route.fulfill({ status: options.expired ? 401 : 200,
      json: options.expired ? { error: "Sign-in required" } : { ownerAddress: buyer } });
    const resource = url.pathname.split("-").at(-1)!;
    if (request.method() === "POST") {
      const body = request.postDataJSON(); calls.push(body);
      if (body.action === "attach") {
        const target = resource === "funding" ? funding : record;
        Object.assign(target, { state: "submitted", transactionHash: body.transactionHash, reportedHash: body.transactionHash });
        return route.fulfill({ json: { [resource]: target } });
      }
      if (["openWallet", "retryWallet", "wallet-opened"].includes(body.action)) {
        const target = resource === "funding" ? funding : record;
        Object.assign(target, { walletAttemptId: String(calls.filter(call => ["openWallet", "retryWallet", "wallet-opened"].includes(String(call.action))).length).padStart(32, "0"), walletOpenedAt: now - 61, acknowledgedAt: now - 61 });
        return route.fulfill({ json: { [resource]: target, warning: "Earlier attempts remain recorded",
          transaction: { from: buyer, to: buyer, value: "0x0", data: "0x", gas: "0x10000", gasPrice: "0x1", chainId: "0x128", nonce: "0x1" } } });
      }
      throw new Error(`Unexpected simulated API action: ${body.action}`);
    }
    if (resource === "funding") return route.fulfill({ json: { funding: url.searchParams.get("id") === otherId ? other : funding,
      history: { records: [funding, other], hasMore: true }, reconciliation: "current", fundingEnabled: true } });
    if (resource === "refund") return route.fulfill({ json: { refund: kind === "refund" ? record : null, reconciliation: "current" } });
    if (resource === "approval") return route.fulfill({ json: { approval: kind === "approval" ? record : null,
      approvalEnabled: true, reconciliation: "current" } });
    throw new Error(`Unexpected simulated API request: ${url.pathname}`);
  });
  await page.goto("/commerce");
  await expect(page.getByLabel("Wallet provider")).toBeVisible();
  await page.getByLabel("Wallet provider").selectOption("eip6963:recovery-ui");
  return { calls, funding, record, other };
}

for (const kind of ["funding", "refund", "approval"] as const) {
  test(`${kind}: manual lost-hash recovery binds the durable opening without another wallet send (simulated)`, async ({ page }) => {
    const { calls } = await scenario(page, kind);
    const title = `${kind[0].toUpperCase()}${kind.slice(1)}`;
    await page.getByLabel(`${title} hash from wallet history`).fill(hash);
    await page.getByRole("button", { name: `Recover ${kind} hash`, exact: true }).click();
    await expect.poll(() => calls.find(call => call.action === "attach")).toMatchObject({ transactionHash: hash,
      walletAttemptId: firstAttempt });
    expect(await page.evaluate(() => Boolean((window as unknown as { promptOpened: boolean }).promptOpened))).toBe(false);
    await expect(page.getByLabel(`${title} hash from wallet history`)).toHaveCount(0);
  });
}

for (const kind of ["refund", "approval"] as const) {
  test(`${kind}: guarded repeated rejection persists each opening and locks history while prompting (simulated)`, async ({ page }) => {
    const { record } = await scenario(page, kind);
    const button = page.getByRole("button", { name: kind === "refund" ? "Reconcile and retry refund in wallet" :
      "Recheck and approve seller withdrawal in wallet", exact: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("checkbox").check();
      await button.click();
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { promptOpened: boolean }).promptOpened))).toBe(true);
      expect(await page.evaluate(({ kind, id }) => sessionStorage.getItem(`neuron-${kind}-attempt:${id}`),
        { kind, id: record.id })).toBe(record.walletAttemptId);
      await expect(page.getByRole("button", { name: /escrow 20$/ })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Older attempts", exact: true })).toBeDisabled();
      await page.evaluate(() => { (window as unknown as { rejectWallet(): void; promptOpened: boolean }).rejectWallet();
        (window as unknown as { promptOpened: boolean }).promptOpened = false; });
      await expect(page.getByRole("checkbox")).not.toBeChecked();
      await expect(page.getByRole("button", { name: /escrow 20$/ })).toBeEnabled();
    }
  });
}

test("expired browser authentication refuses to open another refund prompt (simulated)", async ({ page }) => {
  const { calls } = await scenario(page, "refund", { expired: true });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Reconcile and retry refund in wallet" }).click();
  await expect(page.getByText("Sign in again with the original buyer wallet", { exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});

test("a slow earlier funding response cannot replace the newly selected escrow (simulated)", async ({ page }) => {
  const { funding, other } = await scenario(page, "funding");
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  let completed = false;
  await page.route("**/api/customer-funding?*", async route => {
    if (intercepted) return route.fallback();
    intercepted = true;
    await delayed;
    await route.fulfill({ json: { funding, history: { records: [funding, other], hasMore: true },
      fundingEnabled: true, reconciliation: "current" } });
    completed = true;
  });
  await page.getByRole("button", { name: "Check chain outcome", exact: true }).click();
  await expect.poll(() => intercepted).toBe(true);
  await page.getByRole("button", { name: /escrow 20$/ }).click();
  const escrow = page.getByRole("region", { name: "Escrow funding" }).locator("dl div")
    .filter({ has: page.locator("dt", { hasText: /^Escrow ID$/ }) }).locator("dd");
  await expect(escrow).toHaveText("20");
  release();
  await expect.poll(() => completed).toBe(true);
  // Flush the response through the client before checking the selected view.
  await page.waitForLoadState("networkidle");
  await expect(escrow).toHaveText("20");
});

test("expired funding recovery explains the new authenticated session requirement (simulated)", async ({ page }) => {
  const { funding } = await scenario(page, "funding");
  Object.assign(funding, { state: "abandoned", abandonedAt: Math.floor(Date.now() / 1000) });
  await page.reload();
  await expect(page.getByText(/For another purchase, sign out and sign in again/)).toBeVisible();
  await expect(page.getByText(/A quote for the previous session cannot be reused/)).toBeVisible();
});
