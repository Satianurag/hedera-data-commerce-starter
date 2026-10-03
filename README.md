# Neuron × Scaffold-HBAR

A reusable Hedera template for discovering Neuron services, verifying HCS messages, receiving data and paying through escrow. It includes **Next.js App Router, TypeScript, Foundry and Go**, with separate frontend, contract and protocol packages.

Start with the read-only app: no wallet, account or secret is required. Add wallet sign-in, streaming or payments when your service is configured.

## Quick start

Install **Node 22.23.3 or 24.21.0 LTS** (later patches in either major are supported) and Git. `.nvmrc` selects Node 22.23.3. Use Linux, macOS or WSL2 on Windows.

```sh
git clone https://github.com/Satianurag/neuron-customer-app-scaffold-hbar.git neuron-app
cd neuron-app
npm ci --engine-strict
npm run dev
```

Open **http://localhost:3000**. Services reads the testnet directory; Evidence inspects HCS topics. An unavailable external service produces an unavailable state. Go **1.27.1** is needed only for the optional server adapters and HCS submission command. The project installs its pinned Foundry executable for contract builds and tests.

### Generate with Scaffold-HBAR

The Scaffold-HBAR CLI additionally requires `forge` on your PATH and a configured Git name and email. Check these with `forge --version`, `git config user.name` and `git config user.email`.

```sh
npx create-scaffold-hbar@latest neuron-app --template Satianurag/neuron-customer-app-scaffold-hbar
cd neuron-app
npm ci --engine-strict
npm run dev
```

Choose **Next.js App Router**, **Foundry**, **npm** and **testnet** when prompted. The app defaults to testnet; the CLI's network selection does not set `HEDERA_NETWORK`.

Without a global `forge`, this command supplies the pinned executable:

```sh
npx --yes --package=@foundry-rs/forge@1.7.1 --package=create-scaffold-hbar@0.4.1 -c 'create-scaffold-hbar neuron-app --template Satianurag/neuron-customer-app-scaffold-hbar --frontend nextjs-app --solidity-framework foundry --network testnet --skip-install --skip-hedera-skills --yes --ci --package-manager=npm'
cd neuron-app
npm ci --engine-strict
npm run dev
```

CLI 0.4.1 has an upstream archive-extractor dependency affected by [published security advisories](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw). The clone-based quick start avoids that extractor.

## Choose an integration

| Integration          | Included behavior                                                                                         | Setup                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Service explorer     | Directory records with account, key and topic checks                                                      | Available on testnet by default                                                                     |
| HCS evidence viewer  | Exact bytes, chunk reassembly, payer and signed-envelope checks                                           | Available on testnet and mainnet by default                                                         |
| Aviation data stream | QUIC → authenticated WebSocket → browser, Mode-S decoding and reconnect handling                          | [Streaming configuration](docs/configuration.md#legacy-streaming)                                   |
| Paid file service    | Signed negotiation, per-session file delivery, ERC20 escrow, buyer approval and timeout refund            | [Reference adapter](packages/neuron-reference/README.md) · [CSV example](docs/paid-data-example.md) |
| Native-HBAR checkout | Signed quotes, HBAR funding, same-session delivery, buyer approval, seller withdrawal and deadline refund | [Native seller setup](docs/native-seller.md)                                                        |

Each payment flow has its own protocol and contract. Select the adapter that matches your seller; the aviation protocol, reference ERC20 invoice and `neuronCustomerQuote/v1` HBAR quote are not interchangeable.

## Configure

Copy [`packages/nextjs/.env.example`](packages/nextjs/.env.example) to `packages/nextjs/.env.local` when you need optional features. All write features are disabled by default.

- **Network:** `HEDERA_NETWORK=testnet` by default; mainnet supports read-only app views.
- **Wallet sessions:** enable `NEURON_ENABLE_CUSTOMER_AUTH` and configure the exact `NEURON_APP_ORIGIN` and an owner-only `NEURON_CUSTOMER_DB_FILE` outside the checkout.
- **Adapters:** enable only the switches for the service you have configured. Use the guide linked in the table above.

The [configuration guide](docs/configuration.md) explains setup and recovery; the [environment reference](docs/environment.md) lists variables, defaults and validation. Keep keys and tokens outside the repository and out of `NEXT_PUBLIC_*` variables. Go commands read their process environment, not Next.js `.env.local`.

## Make it yours

| Change                               | Start here                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| Landing page, navigation and styling | `packages/nextjs/app/page.tsx`, `app/layout.tsx`, `app/style.css` |
| Discovery and service identity       | `packages/neuron-hedera/src/legacy.ts`                            |
| Network and Mirror reads             | `packages/neuron-hedera/src/network.ts`, `src/mirror.ts`          |
| Another data format                  | `packages/neuron-hedera/src/frames.ts` and the session view       |
| Delivered file                       | Reference adapter's `sourceFile` configuration                    |
| Escrow terms                         | `packages/foundry/src/BuyerEscrow.sol` and its tests              |

See [architecture](docs/architecture.md) for package responsibilities, state transitions and extension points.

## Development commands

Run from the project root:

| Command                                          | Purpose                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `npm run dev`                                    | Build shared code and start Next.js development server                                   |
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

[Verification](docs/verification.md) covers all test commands and live fixtures. [Example testnet records](docs/testnet-evidence.md) include public HCS, purchase and refund receipts.

## Deployment and guides

The app uses SQLite and persistent journals: deploy it as one long-lived server with private durable storage. The optional gateway also needs reachable UDP. Follow [Linux testnet deployment](deploy/testnet/README.md).

- [Configuration and recovery](docs/configuration.md)
- [Environment reference](docs/environment.md)
- [Native-HBAR contract and withdrawal](docs/contracts.md)
- [Network support](docs/mainnet.md)
- [Contributor instructions](AGENTS.md)

## License

[MIT](LICENSE) for this repository's original code. Dependencies retain their own licenses. The optional reference bridge builds external Neuron source; see its [compatibility and licensing notes](packages/neuron-reference/README.md#exact-compatibility-target) before redistributing that source or a built binary.
