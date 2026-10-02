import type { WalletProvider } from "./injected";

export type UniversalWallet = {
  session?: unknown;
  request(args: { method: string; params?: unknown[] }, chain?: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

/** Only an unexpired session granting this exact EVM chain and required events qualifies. */
export function approvedTestnetAccount(session: unknown): string {
  if (!session || typeof session !== "object") throw new Error("WalletConnect session is missing");
  const row = session as { expiry?: unknown; namespaces?: unknown };
  if (typeof row.expiry !== "number" || !Number.isSafeInteger(row.expiry) || row.expiry <= Date.now() / 1000 ||
      !row.namespaces || typeof row.namespaces !== "object" || Array.isArray(row.namespaces)) {
    throw new Error("WalletConnect session is expired or malformed");
  }
  for (const [key, raw] of Object.entries(row.namespaces)) {
    if ((key !== "eip155" && key !== "eip155:296") || !raw || typeof raw !== "object") continue;
    const { accounts, methods, events } = raw as { accounts?: unknown; methods?: unknown; events?: unknown };
    if (!Array.isArray(accounts) || !Array.isArray(methods) || !Array.isArray(events) ||
        !methods.includes("personal_sign") || !methods.includes("eth_sendTransaction") ||
        !events.includes("accountsChanged") || !events.includes("chainChanged")) continue;
    const approved = accounts.find(value => typeof value === "string" && /^eip155:296:0x[0-9a-f]{40}$/i.test(value));
    if (typeof approved === "string") return approved.slice("eip155:296:".length);
  }
  throw new Error("WalletConnect did not approve Hedera testnet, payment methods and wallet-change events");
}

export function testnetWalletAdapter(raw: UniversalWallet, active: () => boolean): WalletProvider {
  const original = approvedTestnetAccount(raw.session);
  return {
    async request(args) {
      if (!active()) throw new Error("WalletConnect session changed or disconnected; connect again");
      const account = approvedTestnetAccount(raw.session);
      if (account.toLowerCase() !== original.toLowerCase()) throw new Error("WalletConnect account changed; connect again");
      if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return [account];
      if (args.method === "eth_chainId") return "0x128";
      if (args.method === "personal_sign") {
        if (!Array.isArray(args.params) || args.params.length !== 2 || typeof args.params[0] !== "string" ||
            typeof args.params[1] !== "string" || args.params[1].toLowerCase() !== account.toLowerCase()) {
          throw new Error("WalletConnect signature account does not match the approved session");
        }
      } else if (args.method === "eth_sendTransaction") {
        const tx = args.params?.[0];
        if (!Array.isArray(args.params) || args.params.length !== 1 || !tx || typeof tx !== "object" || Array.isArray(tx)) {
          throw new Error("WalletConnect transaction is malformed");
        }
        const { from, chainId } = tx as { from?: unknown; chainId?: unknown };
        if (typeof from !== "string" || from.toLowerCase() !== account.toLowerCase() ||
            (chainId !== undefined && (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId) || BigInt(chainId) !== 296n))) {
          throw new Error("WalletConnect transaction account or network differs from the session");
        }
      } else throw new Error("WalletConnect method is not enabled by this app");
      // Never route a signature/payment through the provider's mutable default chain.
      return raw.request(args, "eip155:296");
    },
    on: (event, listener) => raw.on(event, listener),
    removeListener: (event, listener) => raw.removeListener(event, listener),
  };
}
