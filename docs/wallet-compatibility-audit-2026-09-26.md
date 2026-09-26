# Browser wallet compatibility audit — 26 September 2026

This is a read-only check before using the owner's installed wallet extensions. No wallet connection, signature, network switch, transaction, private key, or seed was requested or read.

## Observed extension and app behavior

- Chrome showed unlocked HashPack v15.0.1 on **Testnet**, account `0.0.10440893-gpxpy`. [Testnet Mirror](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10440893) reports its public key as `ECDSA_SECP256K1` and EVM address `0x4f52c6ec1f7b12e0f3260dc457ab36345bbfea33`. This is public account metadata, not proof that the app can connect to it.
- On an ordinary HTTPS page where Chrome granted HashPack full site access, `typeof window.ethereum` evaluated to `undefined`. This is one observed browser state, not a claim about every HashPack version or site.
- The current customer UI in `packages/nextjs/app/sessions/page.tsx` and `packages/nextjs/app/commerce/review.tsx` discovers only `window.ethereum` and calls `eth_requestAccounts`, `eth_chainId`, `personal_sign`, and `eth_sendTransaction`. It has no WalletConnect/Reown path or explicit EIP-6963 provider selection. Its installed-HashPack login, quote review, and payment paths are therefore **unverified and unavailable in the observed state**. No MetaMask extension behavior was checked.

## Current network boundary

- Customer sign-in, HCS service requests, quote review, funding, approval and refund code require `HEDERA_NETWORK=testnet` and chain **296**; the mainnet commerce UI is disabled. The shared config binds mainnet to chain **295** and its own Mirror origin. These source checks and previous zero-secret read-only mainnet boots are **not** a mainnet wallet, seller, contract, or transaction test.
- HashPack remained on Testnet throughout this audit. Mainnet was not selected or probed. Its mainnet account, key type, balance, provider behavior and signing were not inferred from testnet.
- The owner's installed testnet account was not used as a candidate buyer or asked to sign. The existing controlled CLI-wallet testnet funding/refund evidence does not transfer to this extension.

## Up-to-date integration assessment

[HashPack's developer documentation](https://docs.hashpack.app/dapp-developers/walletconnect) documents WalletConnect/Reown and lists Ethereum personal signing and sending as **ECDSA-only**. The [Hedera WalletConnect guide](https://github.com/hashgraph/hedera-wallet-connect#using-reowns-appkit-recommended) recommends Reown AppKit with `WagmiAdapter` for standard EVM `personal_sign` and `eth_sendTransaction` calls. This is the integration direction to investigate; the current app does not implement it.

An isolated dependency trial, outside the candidate lockfile, tried `@reown/appkit@1.8.24`, `@reown/appkit-adapter-wagmi@1.8.24`, Wagmi 2.19.5 and the current Next 16.3.6/React 19.3.0 pair. Strict installation on required Node 20.18.3 failed because transitive `unstorage@1.17.5` selected `chokidar@5`/`readdirp@5`, which need Node 20.19 or newer. An `unstorage@1.17.3` override removed that engine failure but left an `@wagmi/connectors@8.2.0` versus Wagmi core 2.22.1 peer conflict and **23 npm audit findings, including one high**. No compatible, peer-clean and audit-clean Reown graph was established; no packages or lockfile were changed. Do not equate the highest available version with a compatible integration.

## Gate before using the owner's extension

Resolve the WalletConnect package graph against both supported Node versions and the existing Next/React lockfile. Configure a dedicated Reown project ID and exact approved testnet app origin, then prove connection, address/chain binding, `personal_sign`, disconnect/account/network changes and a clearly capped testnet transaction using a disposable ECDSA account. Review exact wallet prompts and failed/uncertain transaction recovery. Only after this path passes should the owner's extension be considered for an explicit testnet check. Mainnet needs a separate account/provider/contract/seller and release review; no mainnet wallet signature or write is part of this audit.
