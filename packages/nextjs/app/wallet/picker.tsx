"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import qrcode from "qrcode-generator";
import { selectInjectedWallet, serverWalletSnapshot, subscribeWallets, walletSnapshot } from "./injected";
import { connectWalletConnect, disconnectWalletConnect, walletConnectConfig } from "./walletconnect";

type ConnectionConfig = NonNullable<Awaited<ReturnType<typeof walletConnectConfig>>>;

function PairingCode({ uri }: { uri: string }) {
  const code = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(uri);
      qr.make();
      const size = qr.getModuleCount();
      let path = "";
      for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) path += `M${col + 4},${row + 4}h1v1h-1z`;
      }
      return { size: size + 8, path };
    } catch { return null; }
  }, [uri]);
  if (!code) return <p>Copy the pairing URI into your wallet to connect.</p>;
  return <svg role="img" aria-label="Scan with a WalletConnect wallet" width="280" height="280"
    style={{ maxWidth: "100%", height: "auto" }} viewBox={`0 0 ${code.size} ${code.size}`} shapeRendering="crispEdges">
    <rect width={code.size} height={code.size} fill="white" /><path d={code.path} fill="black" />
  </svg>;
}

export function InjectedWalletPicker() {
  const { choices, selectedId, conflict } = useSyncExternalStore(subscribeWallets, walletSnapshot, serverWalletSnapshot);
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [message, setMessage] = useState("");
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void walletConnectConfig().then(value => { if (active) setConfig(value); })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : "WalletConnect is unavailable"); });
    return () => { active = false; connectionAttempt.current?.abort(); };
  }, []);
  async function connect() {
    if (!config || connecting) return;
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setCanCancel(true);
    setConnecting(true);
    setMessage("");
    try {
      const current = await walletConnectConfig(controller.signal);
      if (!current || current.projectId !== config.projectId || current.origin !== config.origin) {
        throw new Error("WalletConnect configuration changed. Reload this page before connecting.");
      }
      await connectWalletConnect(current, setPairingUri, controller.signal);
      setMessage("Hedera testnet wallet connected. Sign-in or a transaction still needs your separate approval.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "WalletConnect could not connect");
    } finally { connectionAttempt.current = null; setCanCancel(false); setPairingUri(null); setConnecting(false); }
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
      {canCancel && <button type="button" className="secondary"
        onClick={() => connectionAttempt.current?.abort()}>Cancel connection</button>}
    </div>}
    {pairingUri && <section aria-label="WalletConnect pairing">
      <p>Scan this code with your wallet, open your wallet app, or copy the URI into its WalletConnect connection screen.</p>
      <PairingCode uri={pairingUri} />
      <label htmlFor="neuron-walletconnect-uri">Pairing URI</label>
      <textarea id="neuron-walletconnect-uri" readOnly value={pairingUri} rows={3} spellCheck={false} />
      <div className="actions">
        <a href={pairingUri}>Open wallet app</a>
        <button type="button" className="secondary" onClick={() => {
          void Promise.resolve().then(() => navigator.clipboard.writeText(pairingUri)).then(() => setMessage("Pairing URI copied."))
            .catch(() => setMessage("Select and copy the pairing URI above."));
        }}>Copy pairing URI</button>
      </div>
    </section>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    <p>Choose a wallet each browser session. Connecting does not sign in or authorize payment; each signature and transaction requires a separate wallet approval.</p>
  </div>;
}
