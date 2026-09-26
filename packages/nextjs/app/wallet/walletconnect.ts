"use client";

import { registerWalletConnect, removeWalletConnect, type WalletProvider } from "./injected";

type WalletConnectConfig = { projectId: string; origin: string; chainId: 296; rpcUrl: string };
type ConnectedProvider = WalletProvider & {
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  session?: unknown;
  on(event: "session_update" | "session_delete" | "disconnect", listener: (...args: unknown[]) => void): void;
};

let connected: ConnectedProvider | null = null;
let connectedProjectId: string | null = null;
let opening = false;

export async function walletConnectConfig(): Promise<WalletConnectConfig | null> {
  const response = await fetch("/api/walletconnect", { cache: "no-store", credentials: "same-origin" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("WalletConnect configuration is unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("WalletConnect configuration is invalid");
  const config = value as Partial<WalletConnectConfig>;
  if (!config.projectId || !/^[0-9a-f]{32}$/i.test(config.projectId) ||
      config.origin !== window.location.origin || config.chainId !== 296 ||
      config.rpcUrl !== "https://testnet.hashio.io/api") {
    throw new Error("WalletConnect origin or Hedera testnet configuration does not match this page");
  }
  return config as WalletConnectConfig;
}

function testnetAccount(accounts: unknown, chain: unknown): boolean {
  return typeof chain === "string" && /^0x[0-9a-f]+$/i.test(chain) && BigInt(chain) === 296n &&
    Array.isArray(accounts) && accounts.length > 0 &&
    typeof accounts[0] === "string" && /^0x[0-9a-f]{40}$/i.test(accounts[0]);
}

function approvedTestnetSession(session: unknown, address: string): boolean {
  if (!session || typeof session !== "object") return false;
  const namespaces = (session as { namespaces?: unknown }).namespaces;
  if (!namespaces || typeof namespaces !== "object") return false;
  return Object.values(namespaces).some(namespace => {
    if (!namespace || typeof namespace !== "object") return false;
    const { accounts, methods } = namespace as { accounts?: unknown; methods?: unknown };
    return Array.isArray(accounts) && Array.isArray(methods) &&
      accounts.some(account => typeof account === "string" &&
        account.toLowerCase() === `eip155:296:${address.toLowerCase()}`) &&
      methods.includes("personal_sign") && methods.includes("eth_sendTransaction");
  });
}

export async function connectWalletConnect(config: WalletConnectConfig): Promise<void> {
  if (opening) throw new Error("A wallet connection is already opening");
  if (config.origin !== window.location.origin || config.chainId !== 296 ||
      config.rpcUrl !== "https://testnet.hashio.io/api") {
    throw new Error("WalletConnect is available only on the configured Hedera testnet origin");
  }
  opening = true;
  let provider: ConnectedProvider | null = null;
  try {
    if (connected) {
      if (connectedProjectId !== config.projectId) {
        const stale = connected;
        connected = null;
        connectedProjectId = null;
        removeWalletConnect(stale);
        try { await stale.disconnect(); } catch { /* Stale selection is already removed. */ }
        throw new Error("WalletConnect project changed. Connect again.");
      }
      const [accounts, chain] = await Promise.all([
        connected.request({ method: "eth_accounts" }), connected.request({ method: "eth_chainId" }),
      ]);
      if (!testnetAccount(accounts, chain) ||
          !approvedTestnetSession(connected.session, (accounts as string[])[0])) {
        const stale = connected;
        connected = null;
        connectedProjectId = null;
        removeWalletConnect(stale);
        try { await stale.disconnect(); } catch { /* Stale selection is already removed. */ }
        throw new Error("WalletConnect session is no longer on Hedera testnet. Connect again.");
      }
      registerWalletConnect(connected);
      return;
    }
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    provider = await EthereumProvider.init({
      projectId: config.projectId,
      metadata: { name: "Neuron customer app", description: "Hedera testnet service discovery and review",
        url: config.origin, icons: [] },
      optionalChains: [296], rpcMap: { 296: config.rpcUrl }, showQrModal: true,
    }) as ConnectedProvider;
    await provider.connect();
    const [accounts, chain] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    if (!testnetAccount(accounts, chain) ||
        !approvedTestnetSession(provider.session, (accounts as string[])[0])) {
      throw new Error("WalletConnect did not approve a Hedera testnet EVM account");
    }
    // A proposal may resolve just before a wallet emits an account or chain change.
    const [settledAccounts, settledChain] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    if (!testnetAccount(settledAccounts, settledChain) ||
        (settledAccounts as string[])[0].toLowerCase() !== (accounts as string[])[0].toLowerCase()) {
      throw new Error("WalletConnect account or chain changed while connecting");
    }
    const active = provider;
    const invalidate = () => {
      removeWalletConnect(active);
      if (connected === active) {
        connected = null;
        connectedProjectId = null;
      }
    };
    const invalidateAndDisconnect = () => {
      invalidate();
      void active.disconnect().catch(() => { /* The wallet was already removed from app selection. */ });
    };
    provider.on("disconnect", invalidate);
    provider.on("session_delete", invalidateAndDisconnect);
    provider.on("session_update", invalidateAndDisconnect);
    connected = provider;
    connectedProjectId = config.projectId;
    registerWalletConnect(provider);
  } catch (error) {
    if (provider) {
      if (connected === provider) {
        connected = null;
        connectedProjectId = null;
      }
      removeWalletConnect(provider);
      try { await provider.disconnect(); } catch { /* A failed connection remains unselected. */ }
    }
    throw error;
  } finally { opening = false; }
}

export async function disconnectWalletConnect(): Promise<void> {
  const provider = connected;
  if (!provider) return;
  connected = null;
  connectedProjectId = null;
  removeWalletConnect(provider);
  await provider.disconnect();
}
