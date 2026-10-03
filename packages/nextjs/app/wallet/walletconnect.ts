"use client";

import { registerWalletConnect, removeWalletConnect, type WalletProvider } from "./injected";
import { approvedTestnetAccount, testnetWalletAdapter } from "./walletconnect-session";
import { closeWalletConnectProvider, stopWalletConnectCore } from "./walletconnect-lifecycle";
import type UniversalProvider from "@walletconnect/universal-provider";

type WalletConnectConfig = { projectId: string; origin: string; chainId: 296; rpcUrl: string };
type Connection = {
  raw: UniversalProvider;
  wallet: WalletProvider;
  projectId: string;
  invalidate(): void;
};
let connected: Connection | null = null;
let opening = false;
let pendingAttempt: Promise<void> | null = null;
let providerPromise: Promise<UniversalProvider> | null = null;
let providerProjectId: string | null = null;
let ownedCore: UniversalProvider["client"]["core"] | null = null;
let closing: Promise<void> | null = null;
let stopped = false;
let unusable = false;

function checkConfig(config: WalletConnectConfig): void {
  if (
    !/^[0-9a-f]{32}$/i.test(config.projectId) ||
    config.origin !== window.location.origin ||
    config.chainId !== 296 ||
    config.rpcUrl !== "https://testnet.hashio.io/api"
  ) {
    throw new Error(
      "WalletConnect origin or Hedera testnet configuration does not match this page",
    );
  }
}

export async function walletConnectConfig(
  signal?: AbortSignal,
): Promise<WalletConnectConfig | null> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch("/api/walletconnect", {
    cache: "no-store",
    credentials: "same-origin",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("WalletConnect configuration is unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object")
    throw new Error("WalletConnect configuration is invalid");
  checkConfig(value as WalletConnectConfig);
  return value as WalletConnectConfig;
}

function closeProvider(provider: UniversalProvider): Promise<void> {
  stopped = true;
  provider.client.core.heartbeat.stop();
  if (closing) return closing;
  const result = closeWalletConnectProvider(provider)
    .then((clean) => {
      if (!clean) unusable = true;
    })
    .catch(() => {
      unusable = true;
    })
    .finally(() => {
      if (closing === result) closing = null;
    });
  closing = result;
  return result;
}

function pageProvider(config: WalletConnectConfig): Promise<UniversalProvider> {
  if (providerProjectId && providerProjectId !== config.projectId)
    throw new Error("WalletConnect project changed; reload this page");
  if (!providerPromise) {
    providerProjectId = config.projectId;
    providerPromise = (async () => {
      const [{ UniversalProvider }, { Core }] = await Promise.all([
        import("@walletconnect/universal-provider"),
        import("@walletconnect/core"),
      ]);
      if (stopped) {
        unusable = true;
        throw new Error(
          "WalletConnect initialization was cancelled; reload this page before reconnecting",
        );
      }
      // One Core per page bounds the SDK's retained globals and browser listeners.
      // A new page gets fresh storage; an unsettled attempt cannot start another.
      const customStoragePrefix = `neuron-${crypto.randomUUID()}`;
      ownedCore = new Core({ projectId: config.projectId, logger: "error", customStoragePrefix });
      try {
        return await UniversalProvider.init({
          core: ownedCore,
          projectId: config.projectId,
          logger: "error",
          customStoragePrefix,
          metadata: {
            name: "Neuron customer app",
            description: "Hedera testnet service discovery and review",
            url: config.origin,
            icons: [],
          },
        });
      } catch (error) {
        unusable = true;
        await stopWalletConnectCore(ownedCore);
        throw error;
      }
    })();
  }
  return providerPromise;
}

export async function connectWalletConnect(
  config: WalletConnectConfig,
  displayUri: (uri: string | null) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  if (opening) throw new Error("A wallet connection is already opening");
  if (pendingAttempt || closing)
    throw new Error(
      "The previous WalletConnect attempt is still settling; wait or reload this page",
    );
  if (unusable)
    throw new Error(
      "WalletConnect could not finish cleanup; reload this page before connecting again",
    );
  checkConfig(config);
  if (signal?.aborted) throw new Error("WalletConnect connection cancelled");
  if (connected) {
    const current = connected;
    try {
      if (current.projectId !== config.projectId)
        throw new Error("WalletConnect project changed; connect again");
      await current.wallet.request({ method: "eth_accounts" });
      if (connected !== current || signal?.aborted)
        throw new Error("WalletConnect connection changed or was cancelled");
      registerWalletConnect(current.wallet);
      return;
    } catch (error) {
      current.invalidate();
      void closeProvider(current.raw);
      throw error;
    }
  }
  opening = true;
  let raw: UniversalProvider | null = null;
  let cancelled = false;
  let rejectCancellation: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (message: string) => {
    cancelled = true;
    stopped = true;
    rejectCancellation(new Error(message));
    if (connected?.raw === raw) connected?.invalidate();
    if (raw) void closeProvider(raw);
    else if (ownedCore) {
      stopped = true;
      void stopWalletConnectCore(ownedCore);
    }
  };
  const abort = () => cancel("WalletConnect connection cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => cancel("WalletConnect connection timed out; try connecting again"),
    120_000,
  );
  const attempt = (async () => {
    raw = await pageProvider(config);
    const provider = raw;
    if (cancelled) {
      await closeProvider(provider);
      return;
    }
    if (stopped) {
      if (provider.session || provider.client.session.length || unusable)
        throw new Error("WalletConnect cleanup is incomplete; reload this page");
      stopped = false;
      await provider.client.core.heartbeat.init();
      try {
        await provider.client.core.relayer.transportOpen();
      } catch (error) {
        await closeProvider(provider);
        throw error;
      }
      if (cancelled) {
        await closeProvider(provider);
        return;
      }
    }
    let valid = true;
    let wallet: WalletProvider | null = null;
    const invalidate = () => {
      valid = false;
      if (wallet) removeWalletConnect(wallet);
      if (wallet && connected?.wallet === wallet) connected = null;
      for (const event of [
        "accountsChanged",
        "chainChanged",
        "session_update",
        "session_delete",
        "disconnect",
      ])
        provider.removeListener(event, changed);
    };
    const changed = () => {
      if (valid) {
        invalidate();
        void closeProvider(provider);
      }
    };
    for (const event of [
      "accountsChanged",
      "chainChanged",
      "session_update",
      "session_delete",
      "disconnect",
    ])
      provider.on(event, changed);
    const onUri = (uri: unknown) => {
      if (cancelled) {
        void closeProvider(provider);
        return;
      }
      if (typeof uri !== "string" || uri.length > 4096 || !/^wc:[0-9a-f]{64}@2\?/.test(uri)) {
        cancel("WalletConnect returned an invalid pairing URI");
        return;
      }
      displayUri(uri);
    };
    provider.on("display_uri", onUri);
    try {
      await provider.connect({
        optionalNamespaces: {
          eip155: {
            chains: ["eip155:296"],
            methods: ["personal_sign", "eth_sendTransaction"],
            events: ["accountsChanged", "chainChanged"],
            rpcMap: { "296": config.rpcUrl },
          },
        },
      });
      if (cancelled || !valid)
        throw new Error("WalletConnect changed or was cancelled while connecting");
      approvedTestnetAccount(provider.session);
      wallet = testnetWalletAdapter(provider, () => valid && !cancelled);
      const account = await wallet.request({ method: "eth_accounts" });
      if (
        !valid ||
        cancelled ||
        !Array.isArray(account) ||
        account[0] !== approvedTestnetAccount(provider.session)
      ) {
        throw new Error("WalletConnect session changed while connecting");
      }
      connected = { raw: provider, wallet, projectId: config.projectId, invalidate };
      registerWalletConnect(wallet);
    } catch (error) {
      invalidate();
      await closeProvider(provider);
      // A late approval can arrive while the first cancellation cleanup runs.
      if (provider.session) await closeProvider(provider);
      throw error;
    } finally {
      provider.removeListener("display_uri", onUri);
    }
  })();
  pendingAttempt = attempt;
  void attempt
    .finally(() => {
      if (pendingAttempt === attempt) pendingAttempt = null;
    })
    .catch(() => {});
  try {
    await Promise.race([attempt, cancellation]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    displayUri(null);
    opening = false;
  }
}

export async function disconnectWalletConnect(): Promise<void> {
  const connection = connected;
  if (!connection) return;
  connection.invalidate();
  await closeProvider(connection.raw);
  if (unusable || connection.raw.session)
    throw new Error(
      "WalletConnect selection removed; wallet disconnection timed out. Reload this page before reconnecting",
    );
}
