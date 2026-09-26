"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { selectInjectedWallet, serverWalletSnapshot, subscribeWallets, walletSnapshot } from "./injected";
import { connectWalletConnect, disconnectWalletConnect, walletConnectConfig } from "./walletconnect";

type ConnectionConfig = NonNullable<Awaited<ReturnType<typeof walletConnectConfig>>>;

export function InjectedWalletPicker() {
  const { choices, selectedId, conflict } = useSyncExternalStore(subscribeWallets, walletSnapshot, serverWalletSnapshot);
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void walletConnectConfig().then(value => { if (active) setConfig(value); })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : "WalletConnect is unavailable"); });
    return () => { active = false; };
  }, []);
  async function connect() {
    if (!config || connecting) return;
    setConnecting(true);
    setMessage("");
    try {
      const current = await walletConnectConfig();
      if (!current || current.projectId !== config.projectId || current.origin !== config.origin) {
        throw new Error("WalletConnect configuration changed. Reload this page before connecting.");
      }
      await connectWalletConnect(current);
      setMessage("Hedera testnet wallet connected. Sign-in or a transaction still needs your separate approval.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "WalletConnect could not connect");
    } finally { setConnecting(false); }
  }
  async function disconnect() {
    if (connecting) return;
    setConnecting(true);
    setMessage("");
    try { await disconnectWalletConnect(); setMessage("WalletConnect disconnected."); }
    catch { setMessage("WalletConnect selection was removed, but the wallet did not confirm disconnection."); }
    finally { setConnecting(false); }
  }
  return <div className="wallet-picker">
    {conflict && <p className="notice" role="alert">Wallet providers announced conflicting identities. Choose a provider explicitly and check the wallet prompt before signing.</p>}
    {choices.length > 0 ? <>
      <label htmlFor="neuron-wallet-provider">Wallet provider</label>
      <select id="neuron-wallet-provider" value={selectedId ?? ""}
        onChange={event => { if (event.target.value) selectInjectedWallet(event.target.value); }}>
        <option value="" disabled>Choose a wallet</option>
        {choices.map(choice => <option value={choice.id} key={choice.id}>
          {choice.name} · {choice.detail}
        </option>)}
      </select>
    </> : <p role="status">No supported injected EVM wallet detected.</p>}
    {config && <div className="actions">
      <button type="button" className="secondary" disabled={connecting || selectedId === "walletconnect:testnet"}
        onClick={() => void connect()}>{connecting ? "Waiting for wallet" : "Connect with WalletConnect"}</button>
      {selectedId === "walletconnect:testnet" && <button type="button" className="secondary"
        disabled={connecting} onClick={() => void disconnect()}>Disconnect WalletConnect</button>}
    </div>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    <p>Choose a wallet each browser session. Connecting does not sign in or authorize payment; each signature and transaction requires a separate wallet approval.</p>
  </div>;
}
