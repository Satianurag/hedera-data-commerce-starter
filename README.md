# Neuron × Scaffold-HBAR

A developer template for building Hedera applications that discover Neuron services, receive data and verify payment. Built with **Next.js, TypeScript, Foundry and Go**, with separate frontend, contract and protocol packages.

Start with live, read-only discovery and HCS evidence. Enable a testnet adapter when you are ready to add wallet authentication, streaming or a paid document service. No account, wallet or secret is needed for the default app.

## Quickstart

Use **Node 22.23.3** (`.nvmrc`), npm and Git. Go **1.26.8** is needed for server adapters and HCS commands. Linux and macOS are the supported development environments; Windows users should use WSL2.

From a checkout:

```sh
nvm use
npm ci --engine-strict
npm run dev
```

Open **http://localhost:3000**. Visit **Services** for current testnet directory records and **Evidence** to inspect a Hedera topic. External outages produce an unavailable state; the template does not substitute generated records.

Optional settings belong in `packages/nextjs/.env.local`. Start from [`.env.example`](packages/nextjs/.env.example); write features are disabled by default. Shell environment variables also work. Set `HEDERA_NETWORK=mainnet` for mainnet **read-only** evidence; testnet commerce and streaming remain disabled there.

### Scaffold-HBAR CLI

The external-template command requires a public repository. This repository currently requires collaborator access; anonymous scaffolding becomes available after publication.

```sh
npm create scaffold-hbar@latest -- --template Satianurag/neuron-customer-app-scaffold-hbar
```

Choose **Next.js App Router · Foundry · npm · testnet**. CLI 0.4.0 checks for `forge` before scaffolding. If you do not have it, this pinned command supplies the official Foundry npm executable:

```sh
npx --yes --package=@foundry-rs/forge@1.7.1 --package=create-scaffold-hbar@0.4.0 -c 'create-scaffold-hbar neuron-app --template Satianurag/neuron-customer-app-scaffold-hbar --frontend nextjs-app --solidity-framework foundry --package-manager npm --network testnet --skip-install --skip-hedera-skills --yes --ci'
cd neuron-app
npm ci --engine-strict
npm run dev
```

The CLI network choice does not configure application runtime. Set `HEDERA_NETWORK` explicitly when changing networks. The lockfile supplies Foundry for builds inside an existing checkout. CLI 0.4.0 also installs its default Foundry library submodules; this template's contract imports none of them, and they are not part of this source tree.

## What you can build

| Example | Included behavior | Setup |
| --- | --- | --- |
| Service explorer | Live legacy directory; seller account/key/topic checks; provenance labels | Works by default on testnet |
| HCS evidence viewer | Topic metadata, exact bytes, bounded chunk reassembly, payer and signed-envelope verification | Works by default on either network |
| Binary data consumer | Legacy QUIC → authenticated WebSocket → browser, Mode-S decoding and stale/disconnected states | Configure the [legacy gateway](docs/configuration.md#legacy-streaming) |
| Paid document service | Signed reference negotiation, real file transport, exact ERC20 allowance/deposit, buyer inspection, seller payment and timeout refund | Configure the [reference adapter](packages/neuron-reference/README.md) |
| Native-HBAR escrow | Original Foundry contract and separately gated signed-quote extension | Read the [native-HBAR setup](docs/configuration.md#native-hbar-extension) |

These are separate protocol adapters. A legacy aviation seller does not automatically accept the reference ERC20 invoice or this template's native-HBAR quote. This is an independent integration, without official Neuron endorsement.

## Make it yours

| Change | Start here |
| --- | --- |
| Landing, navigation and styling | `packages/nextjs/app/page.tsx`, `app/layout.tsx`, `app/style.css` |
| Service discovery and identity | `packages/neuron-hedera/src/legacy.ts` |
| Network and Mirror rules | `packages/neuron-hedera/src/network.ts`, `src/mirror.ts` |
| Decode another data format | `packages/neuron-hedera/src/frames.ts` and the session view |
| Change the delivered document | The reference adapter's private `sourceFile` configuration |
| Add a payment protocol | A separate adapter with explicit terms, asset units and recovery rules |
| Change the native escrow | `packages/foundry/src/BuyerEscrow.sol` and its tests |

Keep network, identity, transport and payment verification independent. See [architecture and extension points](docs/architecture.md).

## Repository

```text
packages/
  nextjs/             App Router UI, authenticated API and customer journal
  foundry/            Native-HBAR escrow, deployment and contract tests
  neuron-hedera/      Shared network, Mirror, HCS and protocol utilities
  neuron-go/          Server HCS writer and legacy QUIC/WebSocket gateway
  neuron-reference/   Optional pinned reference document-service adapter
deploy/testnet/      Linux service and nginx templates
docs/                Configuration, architecture and verification
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the shared package and start development |
| `npm run build` | Build shared code, contracts and production frontend |
| `npm run start` | Serve the production build |
| `npm run typecheck` / `npm run lint` | TypeScript and lint checks |
| `npm test` | Local shared, contract and app checks; no funded transaction |
| `npm run verify` | Build/tests, types, lint, full dependency tree and npm audit |
| `npm run test:live` | Opt-in read-only network checks |
| `npm run hcs:submit` | Submit configured HCS bytes; spends network fees |
| `npm run contract:deploy` | Deploy native escrow with an explicit signer and fee cap |
| `npm run reference:build` | Prepare the pinned reference adapter outside the repo |

## Verification and limits

Installed **MetaMask 13.50.0** completed a real testnet document purchase: exact **29,099-byte** download, **0.01 NTT** seller payment and an empty escrow. A separate timeout refund returned **0.01 NTT**. [Receipts, source revisions, fees and reproducible checks](docs/verification.md) distinguish these results from the legacy stream and native-HBAR examples.

Mainnet writes, other installed wallets and the latest hosted deployment have separate pending gates. The optional reference integration builds upstream source in a local cache and does not redistribute that source or binary. Review its [compatibility and licensing notes](packages/neuron-reference/README.md#exact-compatibility-target) before distribution.

## Documentation

- [Configuration and recovery](docs/configuration.md)
- [Architecture and protocol boundaries](docs/architecture.md)
- [Linux testnet deployment](deploy/testnet/README.md)
- [Checks and testnet evidence](docs/verification.md)
- [Mainnet release requirements](docs/mainnet.md)
- [AI-assisted development](AGENTS.md)

[MIT](LICENSE) for this repository's original code. Dependencies retain their own licenses.
