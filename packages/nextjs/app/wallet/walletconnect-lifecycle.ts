import type UniversalProvider from "@walletconnect/universal-provider";

type Core = UniversalProvider["client"]["core"];

async function bounded(work: () => Promise<unknown>, milliseconds = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work).then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

// These are public APIs in the pinned SDK. Core.stop() is not available in 2.25.
export async function stopWalletConnectCore(core: Core): Promise<boolean> {
  core.heartbeat.stop();
  try { return await bounded(() => core.relayer.transportClose()); }
  finally { core.heartbeat.stop(); }
}

export async function closeWalletConnectProvider(provider: UniversalProvider): Promise<boolean> {
  const core = provider.client.core;
  core.heartbeat.stop();
  let clean = false;
  try {
    const results = await Promise.all([
      bounded(async () => { if (provider.session) await provider.disconnect(); }),
      bounded(() => provider.cleanupPendingPairings({ deletePairings: true })),
    ]);
    clean = results.every(Boolean);
  } finally {
    // A rejected or stalled disconnect must never bypass transport teardown.
    clean = await stopWalletConnectCore(core) && clean;
  }
  return clean;
}
