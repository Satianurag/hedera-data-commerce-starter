"use client";

import { useSyncExternalStore } from "react";
import { selectInjectedWallet, serverWalletSnapshot, subscribeWallets, walletSnapshot } from "./injected";

export function InjectedWalletPicker() {
  const { choices, selectedId, conflict } = useSyncExternalStore(subscribeWallets, walletSnapshot, serverWalletSnapshot);
  if (choices.length === 0) return <p role="status">{conflict ?
    "Conflicting injected-wallet announcements were detected. Resolve the extension conflict before signing." :
    "No supported injected EVM wallet detected. A wallet must report account and network changes. HashPack may need a WalletConnect connection, which this starter does not yet provide."}</p>;
  return <div className="wallet-picker">
    {conflict && <p className="notice" role="alert">Wallet providers announced conflicting identities. Choose a provider explicitly and check the wallet prompt before signing.</p>}
    <label htmlFor="neuron-wallet-provider">Wallet provider</label>
    <select id="neuron-wallet-provider" value={selectedId ?? ""}
      onChange={event => { if (event.target.value) selectInjectedWallet(event.target.value); }}>
      <option value="" disabled>Choose a wallet</option>
      {choices.map(choice => <option value={choice.id} key={choice.id}>
        {choice.name} · {choice.detail}
      </option>)}
    </select>
    <p>Choose a wallet each browser session. This identifies a browser provider only; account access and signatures still require your separate wallet approval.</p>
  </div>;
}
