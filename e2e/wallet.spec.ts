import { expect, test, type Page } from "@playwright/test";
import { Wallet } from "ethers";

// Simulated EIP-1193/EIP-6963 provider; actual random EVM signatures, browser
// fetch, Next.js authentication and disposable SQLite. No chain transactions.
type Mode =
  | "normal"
  | "wrong-chain"
  | "reject"
  | "accounts-during-sign"
  | "chain-during-sign"
  | "disconnect-during-sign";
async function installWallet(page: Page, mode: Mode = "normal") {
  const wallet = Wallet.createRandom();
  await page.exposeFunction("testSignMessage", (message: string) => wallet.signMessage(message));
  await page.addInitScript(
    ({ address, mode }) => {
      type TestWindow = Window & {
        testSignMessage(message: string): Promise<string>;
        walletTest: {
          emit(event: string): void;
          announceSecond(collision: boolean): void;
          methods: string[];
        };
      };
      const w = window as unknown as TestWindow;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const methods: string[] = [];
      let chain = mode === "wrong-chain" ? "0x1" : "0x128";
      let accounts = [address];
      function emit(event: string) {
        if (event === "accountsChanged") accounts = ["0x0000000000000000000000000000000000000001"];
        if (event === "chainChanged") chain = "0x1";
        for (const listener of listeners.get(event) ?? [])
          listener(event === "accountsChanged" ? accounts : chain);
      }
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          methods.push(method);
          if (method === "eth_requestAccounts" || method === "eth_accounts") return accounts;
          if (method === "eth_chainId") return chain;
          if (method === "personal_sign") {
            if (mode === "reject")
              throw Object.assign(new Error("User rejected request"), { code: 4001 });
            if (mode.endsWith("-during-sign"))
              emit(
                mode.startsWith("accounts")
                  ? "accountsChanged"
                  : mode.startsWith("chain")
                    ? "chainChanged"
                    : "disconnect",
              );
            return w.testSignMessage(String(params?.[0]));
          }
          throw new Error(`Unexpected wallet request: ${method}`);
        },
        on(event: string, listener: (...args: unknown[]) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
        },
      };
      function announce(
        uuid = "test-wallet",
        candidate = provider,
        name = "Audit simulated wallet",
      ) {
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: {
              info: { uuid, name, rdns: "test.neuron.wallet" },
              provider: candidate,
            },
          }),
        );
      }
      window.addEventListener("eip6963:requestProvider", () => announce());
      w.walletTest = {
        methods,
        emit,
        announceSecond(collision) {
          announce(
            collision ? "test-wallet" : "second-wallet",
            { ...provider },
            "Second simulated wallet",
          );
        },
      };
    },
    { address: wallet.address, mode },
  );
  await page.goto("/sessions");
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
  await expect(page.getByLabel("Wallet provider")).toBeVisible();
  return wallet;
}

async function chooseAndSign(page: Page) {
  await page.getByLabel("Wallet provider").selectOption("eip6963:test-wallet");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
}

async function emit(page: Page, event: string) {
  await page.evaluate(
    (event) =>
      (window as unknown as { walletTest: { emit(event: string): void } }).walletTest.emit(event),
    event,
  );
}

test.describe("wallet/origin binding (simulated provider, real auth server)", () => {
  test("requires explicit provider choice before requesting any signature", async ({ page }) => {
    await installWallet(page);
    await page.getByRole("button", { name: "Sign in with wallet" }).click();
    await expect(page.getByText("A selected EVM wallet is required.")).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { walletTest: { methods: string[] } }).walletTest.methods,
      ),
    ).toEqual([]);
  });

  test("real signed challenge creates a cookie session and logout revokes it", async ({
    page,
    request,
  }) => {
    const wallet = await installWallet(page);
    await chooseAndSign(page);
    await expect(page.getByText(`Signed in as ${wallet.address}.`)).toBeVisible();
    const response = await page.request.get("/api/customer-auth/session");
    expect(response.status()).toBe(200);
    expect((await response.json()).ownerAddress).toBe(wallet.address);
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.httpOnly);
    expect(sessionCookie?.sameSite).toBe("Strict");
    expect((await request.get("/api/customer-auth/session")).status()).toBe(401);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
    expect((await page.request.get("/api/customer-auth/session")).status()).toBe(401);
  });

  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
    test(`${event} revokes the signed-in browser session`, async ({ page }) => {
      const wallet = await installWallet(page);
      await chooseAndSign(page);
      await expect(page.getByText(`Signed in as ${wallet.address}.`)).toBeVisible();
      await emit(page, event);
      await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
      expect((await page.request.get("/api/customer-auth/session")).status()).toBe(401);
    });
  }

  for (const mode of [
    "wrong-chain",
    "reject",
    "accounts-during-sign",
    "chain-during-sign",
    "disconnect-during-sign",
  ] as const) {
    test(`${mode} never creates an authenticated session`, async ({ page }) => {
      await installWallet(page, mode);
      await chooseAndSign(page);
      await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeEnabled();
      await expect(page.getByText(/^Signed in as /)).toHaveCount(0);
      expect((await page.request.get("/api/customer-auth/session")).status()).toBe(401);
      const methods = await page.evaluate(
        () => (window as unknown as { walletTest: { methods: string[] } }).walletTest.methods,
      );
      expect(methods.includes("personal_sign")).toBe(mode !== "wrong-chain");
    });
  }

  for (const collision of [false, true]) {
    test(`${collision ? "conflicting UUID" : "provider selection change"} revokes the original session`, async ({
      page,
    }) => {
      const wallet = await installWallet(page);
      await chooseAndSign(page);
      await expect(page.getByText(`Signed in as ${wallet.address}.`)).toBeVisible();
      await page.evaluate(
        (collision) =>
          (
            window as unknown as { walletTest: { announceSecond(value: boolean): void } }
          ).walletTest.announceSecond(collision),
        collision,
      );
      if (!collision)
        await page.getByLabel("Wallet provider").selectOption("eip6963:second-wallet");
      else
        await expect(page.locator("main").getByRole("alert")).toContainText(
          "conflicting identities",
        );
      await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
      expect((await page.request.get("/api/customer-auth/session")).status()).toBe(401);
    });
  }

  test("origin and host binding rejects cross-origin and missing-origin writes", async ({
    request,
    baseURL,
  }) => {
    const address = Wallet.createRandom().address;
    const cases: Record<string, string>[] = [
      { Origin: "https://attacker.invalid" },
      {},
      { Origin: baseURL!, Host: "attacker.invalid" },
    ];
    for (const headers of cases) {
      const response = await request.post("/api/customer-auth/challenge", {
        headers,
        data: { address },
      });
      expect(response.status()).toBe(403);
    }
  });

  test("a real signature cannot redeem a challenge twice or from another origin", async ({
    request,
    baseURL,
  }) => {
    const wallet = Wallet.createRandom();
    const challengeResponse = await request.post("/api/customer-auth/challenge", {
      headers: { Origin: baseURL! },
      data: { address: wallet.address },
    });
    expect(challengeResponse.status()).toBe(200);
    const challenge = await challengeResponse.json();
    const data = {
      challengeId: challenge.challengeId,
      signature: await wallet.signMessage(challenge.message),
    };
    expect(
      (
        await request.post("/api/customer-auth/verify", {
          headers: { Origin: "https://attacker.invalid" },
          data,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.post("/api/customer-auth/verify", { headers: { Origin: baseURL! }, data })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.post("/api/customer-auth/verify", { headers: { Origin: baseURL! }, data })
      ).status(),
    ).toBe(401);
  });
});
