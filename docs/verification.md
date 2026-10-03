# Verification

Run checks with Node 22.23.3 from `.nvmrc` or Node 24.21.0; later patches in either major are supported. No wallet or funded account is needed for the local suite.

```sh
npm ci --engine-strict
npm run verify
npm run check:scaffold-text
```

## Local checks

`npm run verify` runs these checks in order:

| Check                  | Coverage                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run test:tooling` | Formatting, lint rules, native SQLite repair, scaffold text, evidence verifier and reference-cache regressions |
| `npm run format:check` | Source and documentation formatting; byte-bound fixtures remain unchanged                                      |
| `npm run test`         | Shared and app builds, shared utility/API tests, local Foundry unit, fuzz and invariant tests                  |
| `npm run typecheck`    | Shared package, app, generated Next.js route types and browser-test TypeScript                                 |
| `npm run lint`         | Authored JavaScript/TypeScript in packages, scripts, deployment and browser tests                              |
| Dependency tree        | Missing, invalid or extraneous installed packages                                                              |
| Security audit         | Known vulnerabilities in the installed project dependency graph                                                |

Use `npm run format` to format supported source files. `npm run build` builds shared code, contracts and the production frontend. The tests use disposable databases, local components and chain fixtures; they do not submit payments.

With Go 1.27.1 installed, check the server adapters:

```sh
cd packages/neuron-go
go test ./...
go vet ./...
```

From the project root, check the optional reference bridge's complete preparation and recovery path:

```sh
node --test packages/neuron-reference/scripts/prepare.integration.test.mjs
```

This downloads pinned public upstream source into a disposable cache, builds the bridge, tests stale overlays and manifests, rejects unexpected source files and runs Go race checks and vet. It needs network access for source/dependency downloads but no Hedera credentials.

## Browser checks

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

The default suite starts production servers on ports 3210 and 3211; `E2E_PORT` changes the first port, with authentication on the next port. It refuses to reuse another server. Server-side fixture responses make HCS, directory and failure states reproducible. Desktop and mobile tests require exact message bytes, payer, sequence, hash and signature; an error or empty topic cannot pass the success assertion.

The wallet project uses a simulated browser provider, real signatures, HTTP authentication and disposable SQLite. It checks selection, rejection, account/network changes, origin validation, replay protection and recovery UI. It does not connect an installed wallet or broadcast transactions.

This negative check must fail the HCS success test when Mirror reads fail:

```sh
E2E_FORCE_MIRROR_OUTAGE=1 npm run test:e2e -- --grep 'verifies exact HCS bytes' --project=desktop
```

### Read-only live browser check

Choose a dedicated testnet topic with a known latest message. Record expectations from the original payload and submission receipt, independently of the page:

```sh
E2E_LIVE=1 \
E2E_HCS_TOPIC_ID=0.0.REPLACE_TOPIC \
E2E_HCS_PAYER_ACCOUNT_ID=0.0.REPLACE_PAYER \
E2E_HCS_FINAL_SEQUENCE=REPLACE_SEQUENCE \
E2E_HCS_BYTE_LENGTH=REPLACE_LENGTH \
E2E_HCS_SHA256=REPLACE_SHA256 \
E2E_HCS_REQUIRE_SIGNED=1 \
npm run test:e2e
```

Live mode uses real network reads with no fixture responses, on desktop and mobile. Missing inputs fail. The signed option additionally requires the recovered key to match the current HCS payer key. The viewer reads the latest message, so another submission changes the expected result. Set `E2E_BASE_URL` in live mode to check an existing deployment instead of starting a local server.

## Scaffold checks

`npm run check:scaffold-text` checks extant tracked and untracked authored files against the published CLI's text rewriting. Ignored runtime files are excluded.

`npm run check:scaffold` generates a disposable project from this checkout using the pinned published Scaffold-HBAR CLI. It prints both Node and package-manager versions and verifies default installation and formatting, file preservation, a fresh install, formatting idempotence, tooling regressions, lint, build, startup and core routes. Expected metadata changes are the CLI's package-manager and Foundry settings, consumed template metadata, and npm@10's omission of optional Linux `libc` lockfile metadata. Dependency versions, integrity hashes, graph, flags and other platform selectors must remain unchanged; the committed lockfile retains `libc` for newer package-manager clients. It requires network access for CLI/dependency acquisition and Foundry libraries. Add `-- --keep` to retain the generated project, or `-- --remote` to download the configured GitHub template instead. See [setup](../README.md) for the published CLI's bootstrap dependency note.

## Public-network checks

| Command                  | Purpose                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:live`      | Read the testnet legacy directory and a mainnet system account, plus optional fixture checks below                         |
| `npm run check:evidence` | Compare recorded HCS and contract expectations with public Mirror/RPC records; see [testnet examples](testnet-evidence.md) |

Optional inputs for `test:live`:

- `NEURON_LIVE_SELLER_ACCOUNT_ID`: selected testnet legacy seller.
- `NEURON_LIVE_HCS_{TOPIC_ID,FINAL_SEQUENCE,PAYER_ACCOUNT_ID,BYTE_LENGTH,SHA256}`: exact multi-chunk message, over 1,024 bytes.
- `NEURON_LIVE_SIGNED_{TOPIC_ID,FINAL_SEQUENCE,PAYER_ACCOUNT_ID,BYTE_LENGTH,SHA256}`: signed message and its payer's current key.

Missing groups are skipped; incomplete groups fail. Use independently recorded sequence/hash values. These commands read existing records and do not create a new funded transaction.

## Continuous integration

[CI](../.github/workflows/ci.yml) runs project verification, browser fixtures, Linux artifact staging, scaffold checks on Node 22 and 24, Go tests/vet and reference preparation/recovery tests. Public-network evidence checks are explicit commands rather than CI prerequisites, because public records and testnet availability can change.
