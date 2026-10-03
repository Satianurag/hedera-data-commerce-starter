# Working on this template

Keep the default app usable without credentials. Read [README](README.md), [architecture](docs/architecture.md), [configuration](docs/configuration.md) and [verification](docs/verification.md) before changing a feature.

## Packages and checks

- `packages/nextjs`: UI, authenticated APIs and SQLite customer journal.
- `packages/neuron-hedera`: shared network, HCS, signatures and decoding.
- `packages/foundry`: native-HBAR escrow, deployment and contract tests.
- `packages/neuron-go`: server-side HCS and QUIC/WebSocket commands.
- `packages/neuron-reference`: bridge overlay for the pinned external reference implementation.
- `deploy/testnet`: single-server Linux deployment.

Use Node 22.23.3 from `.nvmrc` or Node 24.21.0 (later patches in either major are supported), the committed lockfile and Go 1.27.1 for Go packages. Install with `npm ci --engine-strict`. After implementation, run `npm run verify` and `npm run check:scaffold-text`; run `npm run test:e2e` for UI changes. Go changes require `go test ./...` and `go vet ./...` in `packages/neuron-go`. Reference preparation changes require `node --test packages/neuron-reference/scripts/prepare.integration.test.mjs` from the root.

Keep a supported compatible dependency set; check package engines, peer requirements and primary documentation before upgrading. Use one package manager. Preserve fixtures, interoperability vectors, lockfiles and recovery tests.

## Invariants

1. Legacy aviation, reference ERC20 commerce and `neuronCustomerQuote/v1` native-HBAR commerce are separate adapters. Do not mix their identities, assets, contracts or wire formats.
2. Bind network, chain ID, accounts, topics, contract, seller and wallet provider together. The app is mainnet read-only; see [mainnet](docs/mainnet.md).
3. Keep keys, seeds, bearer tokens, signed transactions and customer databases outside source and browser variables. Never log them.
4. Payments require explicit wallet confirmation. Check recipient, integer units, session, terms and deadline. HBAR has 8 decimal tinybar units; JSON-RPC value uses 18 decimals; read ERC20 precision from the token.
5. Persist intent and nonce before opening a wallet; persist transaction identifiers before waiting. Reconcile unknown outcomes before retrying. Never clear payment history to unblock the UI.
6. Confirm transaction receipts, exact Mirror evidence and resulting state before advancing payment labels. Funding and seller withdrawal are distinct steps.
7. Preserve binary bytes. Keep persistent P2P transport in the gateway. Enforce customer ownership, origin, ticket expiry and replay protection at each boundary.

The optional reference bridge targets `NeuronInnovations/neuron-specs@13ab01d70ac42531065094a52cd595ef7b6d3223` and builds outside the checkout. Do not vendor upstream source or binaries without resolving their licensing. Keep runtime artifacts and downloaded caches out of the template.

## Scaffold compatibility

The Scaffold-HBAR CLI rewrites text when a project uses npm: `npm <word>` becomes `npm run <word>` except for `run`, `install`, `exec` and `ci`. Use these forms in docs and scripts. For other subcommands, pass argument arrays to `npm_execpath`, as in `scripts/verify.mjs`. `npm run check:scaffold-text` checks authored files; `npm run check:scaffold` validates generated files, default installation, formatting, build and startup.

Update the relevant user guide when behavior or configuration changes. Keep documentation about using and maintaining the template.
