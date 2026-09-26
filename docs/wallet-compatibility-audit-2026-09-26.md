# Browser wallet compatibility audit — 26 September 2026

This is a read-only check before using the owner's installed wallet extensions. No wallet connection, signature, network switch, transaction, private key, or seed was requested or read.

## Observed extension and app behavior

- Chrome showed unlocked HashPack v15.0.1 on **Testnet**, account `0.0.10440893-gpxpy`. [Testnet Mirror](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10440893) reports its public key as `ECDSA_SECP256K1` and EVM address `0x4f52c6ec1f7b12e0f3260dc457ab36345bbfea33`. This is public account metadata, not proof that the app can connect to it.
- On an ordinary HTTPS page where Chrome granted HashPack full site access, `typeof window.ethereum` evaluated to `undefined`. This is one observed browser state, not a claim about every HashPack version or site.
- At the time of the browser observation, the customer UI discovered only `window.ethereum`. The later candidate source added explicit EIP-6963 provider discovery and selection, plus a legacy injected-provider fallback. It still has no WalletConnect/Reown path. Whether this HashPack installation announces an EIP-6963 provider on the candidate origin has **not** been observed, so its login, quote review and payment paths remain **unverified**. No MetaMask extension behavior was checked.

## Current network boundary

- Customer sign-in, HCS service requests, quote review, funding, approval and refund code require `HEDERA_NETWORK=testnet` and chain **296**; the mainnet commerce UI is disabled. The shared config binds mainnet to chain **295** and its own Mirror origin. These source checks and previous zero-secret read-only mainnet boots are **not** a mainnet wallet, seller, contract, or transaction test.
- HashPack remained on Testnet throughout this audit. Mainnet was not selected or probed. Its mainnet account, key type, balance, provider behavior and signing were not inferred from testnet.
- The owner's installed testnet account was not used as a candidate buyer or asked to sign. The existing controlled CLI-wallet testnet funding/refund evidence does not transfer to this extension.

## Up-to-date integration assessment

[HashPack's developer documentation](https://docs.hashpack.app/dapp-developers/walletconnect) documents WalletConnect/Reown and lists Ethereum personal signing and sending as **ECDSA-only**. The [Hedera WalletConnect guide](https://github.com/hashgraph/hedera-wallet-connect#using-reowns-appkit-recommended) recommends Reown AppKit with `WagmiAdapter` for standard EVM `personal_sign` and `eth_sendTransaction` calls. This is an integration direction to investigate; the current app does not implement WalletConnect.

An isolated dependency trial, outside the candidate lockfile, tried `@reown/appkit@1.8.24`, `@reown/appkit-adapter-wagmi@1.8.24`, Wagmi 2.19.5 and the current Next 16.3.6/React 19.3.0 pair. Strict installation on required Node 20.18.3 failed because transitive `unstorage@1.17.5` selected `chokidar@5`/`readdirp@5`, which need Node 20.19 or newer. An `unstorage@1.17.3` override removed that engine failure but left an `@wagmi/connectors@8.2.0` versus Wagmi core 2.22.1 peer conflict and **23 npm audit findings, including one high**. That particular graph was unsuitable; no packages or lockfile were changed. Do not equate the highest available version with a compatible integration.

A second isolated trial found a smaller **technical candidate**, `@walletconnect/ethereum-provider@2.25.0` with an `unstorage@1.17.3` override. With pinned Next 16.3.6, React 19.3.0 and TypeScript 5.9.3, fresh Node **20.18.3** and **22.23.3** copies passed `npm ci --engine-strict`, `npm ls --all`, a minimal Next production build importing the provider in a client page, `tsc --noEmit`, and `npm audit --audit-level=low` with zero findings. The fixture compiled provider initialization for testnet chain 296 and an explicit RPC map; it did not connect to HashPack or run a wallet transaction. [Reown's provider documentation](https://docs.reown.com/advanced/providers/ethereum) requires a Reown project ID and matching origin metadata, recommends optional chain negotiation, and describes the EIP-1193 API. An exact chain/account check remains necessary after connection and before each action. No dependency was added to this template.

The smaller provider uses the **WalletConnect Community License** and pulls AppKit under the **Reown Community License**. This does not automatically relicense the app's own MIT source, but the SDK notices, gateway and branding conditions apply. [Reown's current terms](https://reown.com/terms-of-service) include usage thresholds and allow Reown to require an enterprise agreement for customer pay-ins/pay-outs, including e-commerce. Whether this paid-data app falls under that provision needs a project-specific terms decision before making the provider a required part of a reusable MIT payment template. A clean package graph alone does not settle this distribution question.

## Gate before using the owner's extension

Decide how the WalletConnect license and service terms fit this reusable paid-data template. If that path is used, configure a dedicated Reown project ID and exact approved testnet app origin, then prove connection, address/chain binding, `personal_sign`, disconnect/account/network changes and a clearly capped testnet transaction using a disposable ECDSA account. Review exact wallet prompts and failed/uncertain transaction recovery. Only after this path passes should the owner's extension be considered for an explicit testnet check. Mainnet needs a separate account/provider/contract/seller and release review; no mainnet wallet signature or write is part of this audit.
