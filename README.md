# Hedera Data Commerce Starter

**A Scaffold-HBAR template with Neuron integrations, HCS evidence and native-HBAR escrow.**

Build a customer-facing app for discovering data services, receiving data and reviewing escrow payments on Hedera. Start with a working read-only interface, then configure the streaming or payment integration you need. The stack is **Next.js App Router, TypeScript, Foundry and Go**, with separate frontend, contract and protocol packages.

This is an independent developer starter, not an official Neuron or Hedera product. Its included data-service adapters target specific Neuron protocols; its Hedera readers, wallet authentication and escrow patterns can be reused in other applications. Supporting another provider or protocol requires an adapter, not just a different URL.

## What can you build?

- **A data-service explorer:** browse the Neuron testnet directory and inspect the accounts, keys and topics behind its listings.
- **An aviation data dashboard:** configure a Neuron seller and receive its Mode-S data through a QUIC-to-WebSocket gateway.
- **A paid document service:** deliver an operator-selected file through the pinned Neuron reference protocol, with ERC20 escrow and explicit buyer approval. Start with the [maintenance CSV example](docs/paid-data-example.md).
- **A native-HBAR checkout:** configure a compatible seller, review signed terms, fund escrow, receive service and approve delivery or recover funds after the refund deadline.

These are starting points for your own application. The included file-service example runs its reference peers on one host; it does not establish compatibility with every public Neuron deployment.

## How Neuron, Hedera and Scaffold-HBAR fit together

| Component           | Role in this starter                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neuron**          | The service directory and implemented streaming/reference-delivery protocols provide the ecosystem integrations. The reference adapter pins a specific [upstream revision](https://github.com/NeuronInnovations/neuron-specs/tree/13ab01d70ac42531065094a52cd595ef7b6d3223). |
| **Hedera**          | HCS records control messages and signed terms; Mirror Node supplies account, topic and transaction evidence; EVM contracts implement escrow. Data travels through the delivery adapters, not through an on-chain file store.                                                 |
| **Scaffold-HBAR**   | The [scaffolding CLI](https://github.com/hedera-dev/create-scaffold-hbar) generates a project from this external template.                                                                                                                                                   |
| **This repository** | Connects those pieces to a customer UI, wallet sessions, persistent recovery state and an original native-HBAR escrow extension.                                                                                                                                             |

**The payment protocols are separate.** The Neuron reference flow settles in ERC20 tokens; HBAR pays its network fees. Native-HBAR checkout uses this starter's `neuronCustomerQuote/v1` format and `BuyerEscrow` contract, not the upstream Neuron payment ABI. A seller must explicitly support the selected adapter. Legacy aviation listings and schedule requests are not automatically payable quotes.

## Quick start

Install **Node 22.23.3 or 24.21.0 LTS** (later patches in either major are supported) and Git. `.nvmrc` selects Node 22.23.3. Use Linux, macOS or WSL2 on Windows.

```sh
git clone https://github.com/Satianurag/hedera-data-commerce-starter.git hedera-data-commerce
cd hedera-data-commerce
npm ci --engine-strict
npm run dev
```

Open **http://localhost:3000**. No wallet, Hedera account or environment file is required for the default read-only app:

1. Open **Services** to read the Neuron testnet directory.
2. Open **Evidence** and enter a topic ID to inspect HCS messages. The [testnet evidence guide](docs/testnet-evidence.md) contains recorded examples.
3. Choose an optional integration below when you are ready to configure your own service.

Public directory and Mirror Node reads require internet access. An unavailable service or empty result is shown explicitly; it is not replaced with demo data. The default app does not require Docker. Go **1.27.1** is needed only for the optional server adapters and HCS submission command. Contract builds and tests use the project's pinned Foundry executable.

### Generate with Scaffold-HBAR

The Scaffold-HBAR CLI additionally requires `forge` on your PATH and a configured Git name and email. Check these with `forge --version`, `git config user.name` and `git config user.email`.

```sh
npx create-scaffold-hbar@latest hedera-data-commerce --template Satianurag/hedera-data-commerce-starter
cd hedera-data-commerce
npm ci --engine-strict
npm run dev
```

Choose **Next.js App Router**, **Foundry**, **npm** and **testnet** when prompted. The app defaults to testnet; the CLI's network selection does not set `HEDERA_NETWORK`.

Without a global `forge`, this command supplies the pinned executable and CLI:

```sh
npx --yes --package=@foundry-rs/forge@1.7.1 --package=create-scaffold-hbar@0.4.1 -c 'create-scaffold-hbar hedera-data-commerce --template Satianurag/hedera-data-commerce-starter --frontend nextjs-app --solidity-framework foundry --network testnet --skip-install --skip-hedera-skills --yes --ci --package-manager=npm'
cd hedera-data-commerce
npm ci --engine-strict
npm run dev
```

CLI 0.4.1 has an upstream archive-extractor dependency affected by [published security advisories](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw). The clone-based quick start avoids that extractor.

## What works by default?

| Capability           | Default state                                                                                                                       | Enable or explore                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Service explorer     | Read-only Neuron directory on testnet, with account, key and topic checks                                                           | Open **Services**                                                                                             |
| HCS evidence viewer  | Read-only on testnet or mainnet; exact bytes, chunk reassembly and payer checks, plus supported Neuron signed-envelope verification | Open **Evidence**; see [network support](docs/mainnet.md)                                                     |
| Wallet sessions      | Disabled                                                                                                                            | Configure [testnet EVM wallet authentication](docs/configuration.md#network-and-wallet-authentication)        |
| Aviation data stream | Disabled                                                                                                                            | Configure a seller and gateway using [streaming setup](docs/configuration.md#legacy-streaming)                |
| Paid file service    | Disabled                                                                                                                            | Provision the [reference adapter](packages/neuron-reference/README.md), file, token and ERC20 escrow          |
| Native-HBAR checkout | Disabled                                                                                                                            | Configure [native seller setup](docs/native-seller.md), HBAR escrow and the required wallet/delivery services |

Copy [`packages/nextjs/.env.example`](packages/nextjs/.env.example) to `packages/nextjs/.env.local` when enabling optional features. All app write features are disabled by default.

- **Network:** `HEDERA_NETWORK=testnet` by default. Mainnet supports read-only app views; application sign-in, streaming and commerce are testnet-only.
- **Wallet sessions:** enable `NEURON_ENABLE_CUSTOMER_AUTH`, configure the exact `NEURON_APP_ORIGIN` and use an owner-only `NEURON_CUSTOMER_DB_FILE` outside the checkout. HTTPS access also requires the customer allowlist described in the guide.
- **Adapters:** enable only the switches for the service you have configured. Connecting a wallet does not authorize a payment; transaction actions require explicit confirmation.

The [configuration guide](docs/configuration.md) explains setup and recovery; the [environment reference](docs/environment.md) lists variables, defaults and validation. Keep keys and tokens outside the repository and out of `NEXT_PUBLIC_*` variables. Go commands read their process environment, not Next.js `.env.local`. Existing `NEURON_*` settings and package names remain the integration's technical identifiers.

## Understand the evidence and payment boundaries

A directory listing, a valid signature, an HCS record, delivered bytes and a settled payment prove different things. An HCS message alone does not prove successful delivery or payment. Escrow enforces payment state and deadlines; it does not judge whether the data is useful or correct.

Both payment flows require buyer approval before seller withdrawal and offer deadline-based refund recovery under their respective contract rules. Preserve the database, journals and transaction identifiers across restarts. A wallet error or timeout is not proof that a transaction failed: reconcile its outcome before retrying. Follow [recovery instructions](docs/configuration.md#recovery-and-troubleshooting) and the selected adapter's guide.

## Make it yours

| Change                                      | Start here                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, navigation and landing page           | [`app/layout.tsx`](packages/nextjs/app/layout.tsx), [`app/page.tsx`](packages/nextjs/app/page.tsx), [`template.json`](template.json)                  |
| Styling                                     | [`app/style.css`](packages/nextjs/app/style.css)                                                                                                      |
| Another discovery source                    | [`legacy.ts`](packages/neuron-hedera/src/legacy.ts) and [`network.ts`](packages/neuron-hedera/src/network.ts); implement explicit provider validation |
| Hedera account, topic and transaction reads | [`mirror.ts`](packages/neuron-hedera/src/mirror.ts) and [`hcs.ts`](packages/neuron-hedera/src/hcs.ts)                                                 |
| Another streaming protocol or data format   | [`legacy/`](packages/neuron-go/legacy/) transport and [`frames.ts`](packages/neuron-hedera/src/frames.ts) decoding, plus the session view             |
| Delivered document                          | Reference adapter's `sourceFile` configuration; preserve the file snapshot for active sessions                                                        |
| Native-HBAR escrow terms                    | [`BuyerEscrow.sol`](packages/foundry/src/BuyerEscrow.sol) and its tests                                                                               |

See [architecture](docs/architecture.md) for package responsibilities, state transitions and extension points. Keep the three adapters' identities, assets, signed formats and contracts separate when extending them.

## Development and verification

Run commands from the project root:

| Command                                          | Purpose                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `npm run dev`                                    | Build shared code and start the Next.js development server                               |
| `npm run build` / `npm run start`                | Build all packages and serve the standalone production app                               |
| `npm run format` / `npm run format:check`        | Format authored files or check formatting                                                |
| `npm run test`                                   | Shared, contract and app tests                                                           |
| `npm run typecheck` / `npm run lint`             | TypeScript and authored JS/TS checks                                                     |
| `npm run verify`                                 | Tooling, formatting, tests, types, lint, dependency tree and security audit              |
| `npm run test:e2e`                               | Desktop/mobile browser tests; first build and run `npx playwright install chromium`      |
| `npm run check:scaffold`                         | Generate from this checkout and verify installation, formatting, tests, build and routes |
| `npm run check:scaffold-text`                    | Check authored files against the CLI's text transformation                               |
| `npm run check:evidence` / `npm run test:live`   | Read-only public evidence and network checks                                             |
| `npm run rebuild:native`                         | Check and repair the local SQLite binding                                                |
| `npm run reference:build`                        | Build the optional pinned reference bridge in an external cache                          |
| `npm run hcs:submit` / `npm run contract:deploy` | Explicitly configured transactions; spend network fees                                   |

The local suite uses fixtures, disposable databases and local contract tests. Default browser tests use deterministic service responses and a simulated wallet. They do not prove a live seller or installed wallet integration works. Public-network checks read existing records; they do not submit new funded transactions.

See [verification](docs/verification.md) for coverage, Go checks, scaffold validation and live browser configuration. [Recorded testnet evidence](docs/testnet-evidence.md) links to HCS, purchase and refund records with their verification commands. Those records document particular runs, not a guarantee of current external-service availability.

## Deployment and further reading

Deploy the app as **one long-lived server with private durable storage** for SQLite and journals. Adding replicas requires changes to state ownership and session routing. The optional streaming gateway also needs reachable UDP. Follow [Linux testnet deployment](deploy/testnet/README.md).

- [Configuration and recovery](docs/configuration.md)
- [Environment reference](docs/environment.md)
- [Native-HBAR contract and seller withdrawal](docs/contracts.md)
- [Network support](docs/mainnet.md)
- [Contributor and AI-agent instructions](AGENTS.md)

## License

[MIT](LICENSE) for this repository's original code. Dependencies retain their own licenses. The optional reference bridge builds external Neuron source; see its [compatibility and licensing notes](packages/neuron-reference/README.md#exact-compatibility-target) before redistributing that source or a built binary.
