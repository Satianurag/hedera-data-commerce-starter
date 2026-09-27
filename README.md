# Neuron × Scaffold-HBAR

A Scaffold-HBAR template for building Hedera apps that **discover Neuron data services, verify Hedera Consensus Service (HCS) evidence, stream binary sensor data and settle payment in escrow**. It uses **Next.js App Router, TypeScript, Foundry and Go**, with separate frontend, contract and protocol packages.

The default app is **read-only and needs no account, wallet or secret**. It shows live testnet directory records and HCS messages from the Mirror Node. Optional adapters add wallet sign-in, a live aviation data stream, a paid document service and a native-HBAR escrow contract when you are ready.

## Hedera services used

| Service | Where | What it does |
| --- | --- | --- |
| **Consensus Service (HCS)** | `packages/neuron-hedera`, `packages/neuron-go/cmd/hcs-submit` | Reads, reassembles and verifies signed topic messages; submits new messages from a server-side signer |
| **Smart contracts (Hedera EVM)** | `packages/foundry/src/BuyerEscrow.sol` | Native-HBAR escrow with buyer approval, seller withdrawal and deadline refund |
| **Mirror Node REST** | `packages/neuron-hedera/src/mirror.ts` | Network-bound account, topic, message and contract-result lookups |
| **JSON-RPC relay (chain 296)** | `packages/nextjs/lib` | Browser wallet sign-in and user-approved escrow transactions |

## Create a project

Prerequisites:

- **Node 20.18.3 or later**. Node 22.23.3 (`.nvmrc`) is the tested version.
- **Git**.
- **Foundry** (`forge`). The CLI checks for it before scaffolding; see below if you do not have it.
- **Go 1.26.8**, only for the optional server adapters and the HCS submit command.

Linux and macOS are supported. On Windows, use WSL2.

```sh
npx create-scaffold-hbar@latest neuron-app --template Satianurag/neuron-customer-app-scaffold-hbar
cd neuron-app
npm ci --engine-strict
npm run dev
```

When prompted, choose **Next.js App Router**, **Foundry**, **npm** as the package manager and **testnet**.

If `forge` is not installed, this pinned command provides the official Foundry executable and runs the CLI non-interactively:

```sh
npx --yes --package=@foundry-rs/forge@1.7.1 --package=create-scaffold-hbar@0.4.0 -c 'create-scaffold-hbar neuron-app --template Satianurag/neuron-customer-app-scaffold-hbar --frontend nextjs-app --solidity-framework foundry --network testnet --skip-install --skip-hedera-skills --yes --ci --package-manager=npm'
```

Open **http://localhost:3000**. **Services** lists current testnet directory records and **Evidence** inspects any HCS topic. If an external service is unavailable, the page says so; it never shows generated placeholder records.

The CLI network choice does not configure the app. Set `HEDERA_NETWORK` explicitly. CLI 0.4.0 also adds its default Foundry library submodules; this contract does not import them.

## Configure

Optional settings go in `packages/nextjs/.env.local`. Start from [`packages/nextjs/.env.example`](packages/nextjs/.env.example); every write feature is disabled by default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HEDERA_NETWORK` | `testnet` | `testnet` or `mainnet`. Mainnet is read-only in this template |
| `NEURON_ENABLE_CUSTOMER_AUTH` | `false` | Wallet sign-in and customer sessions (also needs `NEURON_APP_ORIGIN` and `NEURON_CUSTOMER_DB_FILE`) |
| `NEURON_ENABLE_REFERENCE_COMMERCE` | `false` | Paid document service through the reference adapter |
| `NEURON_ENABLE_LOCAL_STREAM` / `NEURON_ENABLE_REMOTE_STREAM` | `false` | Live aviation stream through the legacy gateway |
| `NEURON_ENABLE_CUSTOMER_REQUEST`, `_COMMERCE_REVIEW`, `_FUNDING`, `_APPROVAL` | `false` | Native-HBAR request, quote review, escrow funding and approval steps |

Every variable, with recovery steps, is in the [configuration guide](docs/configuration.md). Private keys never go in `NEXT_PUBLIC_*` variables or in the repository.

## What you can build

| Example | Included behavior | Setup |
| --- | --- | --- |
| Service explorer | Live directory; seller account, key and topic checks; provenance labels | Works by default on testnet |
| HCS evidence viewer | Topic metadata, exact bytes, bounded chunk reassembly, payer and signed-envelope checks | Works by default on either network |
| Binary data consumer | QUIC → authenticated WebSocket → browser, Mode-S decoding, stale and disconnected states | [Legacy gateway](docs/configuration.md#legacy-streaming) |
| Paid document service | Signed negotiation, real file transport, exact ERC20 allowance and deposit, buyer approval, seller payment, timeout refund | [Reference adapter](packages/neuron-reference/README.md) |
| Native-HBAR escrow | Foundry contract plus a separately gated signed-quote flow | [Native-HBAR setup](docs/configuration.md#native-hbar-extension) |

These are separate protocol adapters. A legacy aviation seller does not automatically accept the reference ERC20 invoice or this template's native-HBAR quote. This is an independent integration, not endorsed by Neuron.

## Make it yours

| Change | Start here |
| --- | --- |
| Landing page, navigation, styling | `packages/nextjs/app/page.tsx`, `app/layout.tsx`, `app/style.css` |
| Service discovery and identity | `packages/neuron-hedera/src/legacy.ts` |
| Network and Mirror Node rules | `packages/neuron-hedera/src/network.ts`, `src/mirror.ts` |
| Decode another data format | `packages/neuron-hedera/src/frames.ts` and the session view |
| Change the delivered document | The reference adapter's private `sourceFile` setting |
| Add a payment protocol | A new adapter with explicit terms, asset units and recovery rules |
| Change the escrow contract | `packages/foundry/src/BuyerEscrow.sol` and its tests |

Keep network, identity, transport and payment checks independent. See [architecture and extension points](docs/architecture.md).

## Repository layout

```text
packages/
  nextjs/             App Router UI, authenticated API routes, customer journal
  foundry/            Native-HBAR escrow, deployment scripts, contract tests
  neuron-hedera/      Shared network, Mirror Node, HCS and protocol utilities
  neuron-go/          Server HCS writer and QUIC/WebSocket gateway
  neuron-reference/   Optional pinned reference document-service adapter
deploy/testnet/       Linux service and nginx templates
docs/                 Configuration, architecture, contract and verification guides
e2e/                  Browser smoke tests
```

## Commands

Run these from the project root.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the shared package and start the dev server |
| `npm run build` | Build shared code, contracts and the production frontend |
| `npm run start` | Serve the production build (standalone Next.js server) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint checks |
| `npm run test` | Shared, contract (including fuzz) and app tests; no network writes |
| `npm run test:e2e` | Desktop and mobile browser smoke tests against a production build (first run `npx playwright install chromium`) |
| `npm run check:scaffold` | Scaffold this checkout with the published CLI, then fresh install, lint, build, boot and route checks |
| `npm run check:scaffold-text` | Confirm no tracked file is altered by the CLI's command rewrite |
| `npm run verify` | Tests, types, lint, dependency tree and security audit |
| `npm run test:live` | Opt-in read-only checks against the live network |
| `npm run hcs:submit` | Submit configured bytes to an HCS topic; spends testnet fees |
| `npm run contract:deploy` | Deploy the escrow with an explicit signer and fee cap |
| `npm run reference:build` | Prepare the pinned reference adapter outside the repository |

## Testnet evidence

Every row is a real testnet operation you can check on the official Mirror Node.

| Operation | Evidence |
| --- | --- |
| HCS message submitted by `hcs:submit` from a fresh scaffold | [Transaction `0.0.10725146@1790499070.059923854`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790499070-059923854) · [topic 0.0.10725147 message 13](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10725147/messages/13) |
| `BuyerEscrow` deployed on Hedera EVM | [Contract 0.0.10730636](https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10730636) |
| Paid document purchase in MetaMask: seller withdrawal | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x5031eaa0b3a132705b61cf62f9630e46543514d17eea2feb79eb7b3298526196) |

The [verification guide](docs/verification.md) lists the full purchase and refund receipts and how to reproduce every check.

## Limits

- Mainnet is read-only. Mainnet writes are a [separate release](docs/mainnet.md).
- The native-HBAR browser checkout and wallets other than MetaMask have not been tested end to end.
- The reference adapter builds upstream Neuron source in a local cache and does not redistribute it. Read its [compatibility and licensing notes](packages/neuron-reference/README.md#exact-compatibility-target) before you distribute a build.
- The app keeps customer state in SQLite, so it runs as a single long-lived server, not on serverless hosting. See [Linux deployment](deploy/testnet/README.md).

## Documentation

- [Configuration and recovery](docs/configuration.md)
- [Architecture and protocol boundaries](docs/architecture.md)
- [Escrow contract](docs/contracts.md)
- [Checks and testnet evidence](docs/verification.md)
- [Linux testnet deployment](deploy/testnet/README.md)
- [Mainnet release requirements](docs/mainnet.md)
- [Guide for AI coding agents](AGENTS.md)

## License

[MIT](LICENSE) for this repository's original code. Dependencies keep their own licenses.
