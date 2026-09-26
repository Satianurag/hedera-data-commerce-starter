"use client";

export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
  removeListener?(event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
};

type ProviderInfo = { uuid: string; name: string; rdns: string };
type Announcement = { info?: ProviderInfo; provider?: WalletProvider };
export type WalletChoice = { id: string; name: string; detail: string };
export type WalletSnapshot = { choices: readonly WalletChoice[]; selectedId: string | null;
  revision: number; conflict: boolean };
type Entry = { choice: WalletChoice; provider: WalletProvider; preference: string };

const entries = new Map<string, Entry>();
const blockedIds = new Set<string>();
const ambiguousPreferences = new Set<string>();
const subscribers = new Set<() => void>();
type Invalidation = "selection" | "provider";
const invalidationSubscribers = new Set<(reason: Invalidation) => void>();
const events = ["accountsChanged", "chainChanged", "disconnect"] as const;
let started = false;
let selectedId: string | null = null;
let revision = 0;
let snapshot: WalletSnapshot = { choices: [], selectedId: null, revision: 0, conflict: false };
const emptySnapshot: WalletSnapshot = { choices: [], selectedId: null, revision: 0, conflict: false };
let selectedListener: ((...args: unknown[]) => void) | null = null;

function preference(entry: Entry): string { return entry.preference; }

function requireManualChoice(...keys: string[]): void {
  for (const key of keys) ambiguousPreferences.add(key);
  if (selectedId) setSelection(null);
}

function publish(reason?: Invalidation): void {
  if (reason) revision++;
  snapshot = { choices: [...entries.values()].map(entry => entry.choice), selectedId, revision,
    conflict: blockedIds.size > 0 || ambiguousPreferences.size > 0 };
  for (const subscriber of subscribers) subscriber();
  if (reason) for (const subscriber of invalidationSubscribers) subscriber(reason);
}

function unwatchSelected(): void {
  const current = selectedId && entries.get(selectedId);
  if (current && selectedListener) {
    for (const event of events) {
      try { current.provider.removeListener?.(event, selectedListener); }
      catch { /* A stale listener may only invalidate a later selection. */ }
    }
  }
  selectedListener = null;
}

function setSelection(id: string | null): void {
  if (id !== null && !entries.has(id)) throw new Error("Selected wallet is unavailable");
  if (id !== null) {
    const provider = entries.get(id)!.provider;
    if (typeof provider.on !== "function" || typeof provider.removeListener !== "function") {
      throw new Error("This wallet cannot report account or network changes");
    }
  }
  if (selectedId !== id) {
    unwatchSelected();
    selectedId = id;
    if (id) {
      const provider = entries.get(id)!.provider;
      const listener = () => publish("provider");
      const attached: typeof events[number][] = [];
      try {
        for (const event of events) {
          attached.push(event);
          provider.on!(event, listener);
        }
        selectedListener = listener;
      } catch {
        for (const event of attached) {
          try { provider.removeListener!(event, listener); } catch { /* Selection still fails closed. */ }
        }
        selectedId = null;
        selectedListener = null;
        publish("selection");
        throw new Error("This wallet cannot report account or network changes");
      }
    }
    publish("selection");
  }
}

function register(id: string, name: string, detail: string, provider: WalletProvider, key: string): void {
  if (!provider || typeof provider.request !== "function" ||
      typeof provider.on !== "function" || typeof provider.removeListener !== "function") return;
  if (blockedIds.has(id)) return;
  const existing = entries.get(id);
  if (existing) {
    if (existing.provider !== provider) {
      // A UUID collision cannot identify either provider. Remove the choice,
      // including an already selected one, and never accept this UUID again.
      blockedIds.add(id);
      requireManualChoice(existing.preference, key);
      entries.delete(id);
      publish();
    }
    return;
  }
  if ([...entries.values()].some(entry => entry.provider === provider)) return;
  if ([...entries.values()].some(entry => entry.preference === key)) requireManualChoice(key);
  entries.set(id, { choice: { id, name, detail }, provider, preference: key });
  publish();
}

function announce(event: Event): void {
  const { info, provider } = (event as CustomEvent<Announcement>).detail ?? {};
  if (!info || typeof info.uuid !== "string" || !/^[\w-]{1,80}$/.test(info.uuid) ||
      typeof info.name !== "string" || !info.name.trim() || info.name.length > 80 ||
      typeof info.rdns !== "string" || info.rdns.length > 160 || !provider) return;
  const name = info.name.trim();
  register(`eip6963:${info.uuid}`, name, info.rdns || "Injected wallet", provider,
    `eip6963:${info.rdns}:${name}`);
}

function registerLegacy(): void {
  const provider = (window as Window & { ethereum?: WalletProvider }).ethereum;
  const previous = entries.get("legacy");
  if (previous && previous.provider !== provider) {
    if (selectedId === "legacy") setSelection(null);
    entries.delete("legacy");
    publish();
  }
  if (provider) register("legacy", "Browser wallet", "Legacy injected provider", provider, "legacy");
}

export function discoverInjectedWallets(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Announcements may arrive asynchronously. The legacy provider is checked
  // after a short discovery window, but every wallet requires an explicit choice.
  window.setTimeout(() => {
    registerLegacy();
  }, 750);
  window.addEventListener("ethereum#initialized", registerLegacy);
}

export function subscribeWallets(listener: () => void): () => void {
  subscribers.add(listener);
  discoverInjectedWallets();
  return () => { subscribers.delete(listener); };
}

export function subscribeWalletInvalidation(listener: (reason: Invalidation) => void): () => void {
  invalidationSubscribers.add(listener);
  discoverInjectedWallets();
  return () => { invalidationSubscribers.delete(listener); };
}

export function walletSnapshot(): WalletSnapshot { return snapshot; }
export function serverWalletSnapshot(): WalletSnapshot { return emptySnapshot; }

export function selectInjectedWallet(id: string): void { setSelection(id); }

export function selectedInjectedWallet(): { provider: WalletProvider; revision: number } {
  discoverInjectedWallets();
  const entry = selectedId && entries.get(selectedId);
  if (!entry) throw new Error(entries.size > 1 ?
    "Choose the wallet you want to use before signing." : "An injected EVM wallet is required.");
  if (typeof entry.provider.on !== "function" || typeof entry.provider.removeListener !== "function") {
    setSelection(null);
    throw new Error("This wallet cannot report account or network changes. Choose a supported wallet.");
  }
  if (selectedId === "legacy" &&
      (window as Window & { ethereum?: WalletProvider }).ethereum !== entry.provider) {
    registerLegacy();
    throw new Error("The browser wallet provider changed. Select a wallet again.");
  }
  return { provider: entry.provider, revision };
}

export function assertInjectedWallet(provider: WalletProvider, expectedRevision: number): void {
  const current = selectedInjectedWallet();
  if (current.provider !== provider || current.revision !== expectedRevision) {
    throw new Error("Wallet account, network or provider changed. Recheck before signing.");
  }
}
