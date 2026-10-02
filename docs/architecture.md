# Architecture

This template provides reusable service discovery, Hedera evidence, wallet authorization and delivery/payment examples. Start with the read-only app; enable a configured integration when its server resources are ready. See [setup](../README.md).

## Package boundaries

| Package | Owns | Entry points |
| --- | --- | --- |
| `packages/nextjs` | App Router pages, wallet selection, authenticated APIs and customer SQLite journal | `app/`, `app/api/`, `lib/` |
| `packages/neuron-hedera` | Typed network configuration, bounded Mirror/HCS reads, signed-message checks, legacy discovery and Mode-S parsing | `src/index.ts` |
| `packages/foundry` | Starter-specific native-HBAR escrow, contract tests and deployment/reconciliation scripts | `src/BuyerEscrow.sol`, `scripts/` |
| `packages/neuron-go` | Server-only HCS writes, legacy request creation, persistent QUIC/WSS gateway and reference setup | `cmd/`, `legacy/` |
| `packages/neuron-reference` | Pinned upstream protocol integration, file delivery and ERC20 settlement coordination | `bridge/`, `scripts/prepare.mjs`, [operator guide](../packages/neuron-reference/README.md) |

All JavaScript packages share one `package-lock.json`. The Go gateway has its own module and sums. The reference build prepares an exact upstream checkout outside the repository because upstream Go packages are `internal`; its original bridge overlay and explicit dependency patches are tracked here. Downloaded upstream sources, binaries and runtime journals are not template files.

```mermaid
flowchart LR
  Browser[Browser and wallet] --> App[Next.js routes and customer journal]
  App --> Reads[Shared Hedera readers]
  Reads --> Mirror[Network-bound Mirror Node]
  App --> Reference[Reference bridge and session journals]
  Reference --> Delivery[Pinned Neuron delivery peers]
  Reference --> HCS[Hedera Consensus Service]
  Browser --> Escrow[Selected escrow contract]
  App --> Gateway[Legacy QUIC to WSS gateway]
  Seller[Legacy seller] --> Gateway
  Gateway --> Browser
```

## Three distinct integrations

| Integration | Control and data | Payment boundary |
| --- | --- | --- |
| Legacy aviation | Public legacy directory, Mirror account/topic binding, `neuron/ADSB/0.0.2` QUIC bytes, WSS and Mode-S decoding | Directory fees and incoming schedule requests are not payable quotes. The gateway never automatically signs seller payments. |
| Native-HBAR extension | Starter format `neuronCustomerQuote/v1`, seller signature and exact HCS reference | `BuyerEscrow` binds buyer, seller, terms, amount and deadline. Funding, delivery approval and refund require explicit buyer authorization. Legacy sellers are not assumed to implement it. |
| Reference file service | Draft-008 exchange and original delivery primitives from `neuron-specs@13ab01d70ac42531065094a52cd595ef7b6d3223` | Matching upstream ERC20 escrow, exact allowance/deposit, signed invoice, file hash/length, explicit buyer release and seller withdrawal or deadline refund. This is compatibility with that pinned implementation. |

The reference service transfers a selected real file. Its example is document delivery; the separate aviation adapter carries live sensor bytes. A self-operated seller can exercise the pinned protocol without implying compatibility with every Neuron deployment. The native-HBAR contract and upstream ERC20 escrow have different ABIs and must not be interchanged.

## Identity, state and transaction safety

- One process selects `testnet` or `mainnet`. Shared configuration binds chain ID, official Mirror origin and directory policy. Check account and topic metadata before interpreting messages; an empty message list is insufficient.
- Wallet sign-in uses a one-use challenge, EVM signature, exact origin and selected chain. The session cookie is HttpOnly; customer ownership is checked on server reads and writes. Connecting a wallet does not authorize payment.
- The app stores customer sessions, requests and payment intents in an owner-only SQLite database outside the repository. The legacy gateway maintains a locked append-only connection journal; the reference bridge persists configuration-bound session files.
- Journals retain transaction hashes and prepared nonces across refreshes and restarts. Reconcile uncertain outcomes before another wallet action. Never erase an intent to make a retry possible.
- Browser wallet actions disclose the selected asset, integer amount, recipient, chain and contract. The reference path validates calldata and buffers gas under explicit per-transaction gas/fee limits before opening the wallet.
- Seller signatures, HCS consensus, delivery and executed payment are separate observations. `paid` requires settlement reconciliation; a submitted hash or signed invoice alone cannot set it.
- Server keys, API tokens and databases stay outside the workspace with owner-only permissions. No private key belongs in `NEXT_PUBLIC_*`, API responses or a browser bundle.

The single-host SQLite/file-journal design is deliberate. Horizontal scaling needs shared transactional ownership, replay protection and session routing; adding replicas without those changes is unsupported.

## Extension points

| Change | Start here | Preserve |
| --- | --- | --- |
| Frontend branding and navigation | `packages/nextjs/app/layout.tsx`, `page.tsx`, `style.css` | Visible network and honest capability states |
| New discovery source | `packages/neuron-hedera/src/legacy.ts`, `mirror.ts`, `network.ts` | Explicit provenance, network/identity checks and bounded reads |
| Another binary service | `packages/neuron-go/legacy/`, `packages/neuron-hedera/src/frames.ts` | Expected peer/protocol, raw bytes, resource limits and freshness |
| Different delivered document | Reference configuration's service file | Snapshot bytes, length and SHA-256; do not mutate active session terms |
| New payment protocol | A separately named shared adapter, server coordinator and wallet UI | Exact asset units, authenticated terms, explicit authorization, receipt reconciliation and recovery |
| Another browser wallet | `packages/nextjs/app/wallet/` | Provider choice, account/chain/disconnect events and independent flow verification |
| Deployment | [Testnet deployment guide](../deploy/testnet/README.md) | Target-architecture native builds, persistent state, HTTPS/WSS and UDP reachability |

## Compatible dependency graph

The manifests and lockfiles are authoritative. These pins describe the current graph; “newest” alone is not an upgrade criterion.

| Layer | Selected versions |
| --- | --- |
| Default runtime | Node `22.23.3` / `24.21.0` LTS; Go `1.27.1` for server commands |
| Web | Next / matching Next ESLint plugin `16.3.8`; React / React DOM / React types `19.3.0` |
| Type and lint tools | TypeScript `6.0.3`; ESLint `10.11.0`; typescript-eslint `8.71.0`; Oxlint `1.86.0` |
| Wallet and state | ethers `6.17.0`; WalletConnect Universal Provider `2.25.0`; QR generator `2.0.4`; better-sqlite3 `13.0.3` |
| Contracts | Foundry CLI `1.7.1` (`@foundry-rs/forge`); Solidity `0.8.37`; EVM target `paris` |
| Go integration | Hiero SDK `2.85.1`; libp2p `0.50.0`; coder/websocket `1.8.15` |

Keep native bindings aligned with the deployment OS and architecture. better-sqlite3 13 uses Node-API; the runtime and CI remain pinned to supported Node 22 and 24 LTS releases. ESLint 10 runs current Next and React Hooks rules; Oxlint runs the corresponding React, accessibility and import checks without the old ESLint-9-only plugin dependencies. TypeScript 6.0.3 is the current compatible compiler API: typescript-eslint explicitly rejects TypeScript 7, so a version-number-only upgrade would break linting. Review peer ranges, engines, security findings and meaningful regressions together when updating. The template does not require an unpublished Neuron SDK package or the JavaScript Hedera SDK.

## Structure references

The organization follows relevant, established starter patterns: [Scaffold-ETH 2](https://github.com/scaffold-eth/scaffold-eth-2) for frontend/contracts boundaries and customization entry points; [Create T3 App](https://github.com/t3-oss/create-t3-app) for focused, optional integrations; [Turborepo's basic example](https://github.com/vercel/turborepo/blob/main/examples/basic/README.md) for a package map and root task commands; and [Next.js conventions](https://nextjs.org/docs/app/getting-started/project-structure) for colocated route code. These references do not add dependencies to this template.
