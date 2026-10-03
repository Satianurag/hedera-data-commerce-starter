# Reference document service

This optional **testnet-only** adapter connects the template to the pinned Neuron reference protocol. It imports the upstream canonical payment messages, signatures, EVM contract bindings, ECIES connection setup and real libp2p file transport. The application supplies durable state and explicit browser-wallet approval around them.

The service delivers the actual bytes of one operator-selected, permitted file. Follow the [maintenance report example](../../docs/paid-data-example.md) to configure a CSV purchase. Legacy aviation streaming and native-HBAR escrow use separate adapters.

## Exact compatibility target

- Upstream repository: `https://github.com/NeuronInnovations/neuron-specs.git`.
- Revision: `13ab01d70ac42531065094a52cd595ef7b6d3223`.
- Build runtime: Go `1.27.1`; dependencies use the same patched Hiero, libp2p, gRPC, crypto and Pion versions as the existing Go gateway. The prepared `build-provenance.json` records the resolved module graph.
- Payment uses the upstream `NeuronEscrow` **ERC20** ABI. Token values are integer token base units with independently checked decimals. They are never described as HBAR/tinybar. HBAR only pays network fees.
- Protocol payloads use the original upstream `payment` serializers unchanged. `serviceParams` is the upstream-defined application map; it carries the customer wallet, chain, escrow, immutable document hash/size/name and refund deadline for this document service.
- `agreementHash` is the upstream Keccak-256 of the canonical accepted `serviceResponse`. Its unique request ID refers to the signed service request containing exact terms.
- Escrow references are the upstream `<contractAddress>:<escrowId>` and release references add `:<releaseId>`. Network binding is separately enforced by the immutable testnet configuration and chain checks.
- The pinned invoice has eight canonical fields and **no `evidenceHash` field**. Evidence is bound by the onchain release request referenced by the invoice. The bridge verifies its exact amount, seller recipient and evidence hash before exposing buyer approval. Use the pinned serializer and contract binding together.
- `bridge/testdata/upstream-invoice-mirror.json` preserves an upstream signed invoice for serializer/signature regression tests; its `mem-*` references are demo identifiers.

The buyer's protocol identity is a server delegate. The signed-in customer wallet is separately bound in the signed request and is the actual onchain escrow buyer. The bridge has **no customer payment key**. Customer create, token allowance, deposit, release approval and refund calls are prepared as unsigned transactions and individually approved in the browser wallet. A separate seller key signs only its release request and withdrawal, with the recipient fixed to that seller.

Both P2P peers run on the same host over loopback QUIC. No public UDP listener is required. Browser receipt has its own byte/hash check; the delivered file is downloadable only through the customer's authenticated app session.

## Prepare and configure

Run `node packages/neuron-reference/scripts/prepare.mjs`. It fetches the exact revision into an external cache and compiles the original bridge overlay as `cmd/scaffold-reference`. The upstream internal Go packages require building in that module. No upstream source or binary is copied into this repository. The pinned upstream checkout has no root license file. Resolve its distribution rights before redistributing upstream source or the built binary; this repository's MIT license covers its original wrapper code only.

The preparation command prints the absolute binary path. Set `NEURON_REFERENCE_CACHE` to change the owner-controlled build cache. Go 1.27.1 can be selected through the standard Go toolchain mechanism. Changed upstream source, unexpected untracked/ignored inputs, symlinks and concurrent prepare operations are rejected. A stale generated bridge overlay is replaced exactly from the current template; its prior contents are retained under `retained-overlays` outside the repository. Changed generated `go.mod`/`go.sum` bytes are preserved under content-addressed `retained-manifests` before those files are reset to the pinned upstream baseline and declared compatibility patches are reapplied. Provenance records retention paths, overlay hashes and the resolved module graph. A failed preparation does not replace the last successful binary. A killed prepare can leave `.prepare.lock`, which records its PID. Verify that no process is still preparing this exact cache before explicitly removing only that lock; elapsed time or a PID check alone is insufficient because PIDs can be reused. Never remove runtime customer state or transaction journals to repair a build cache.

The [verification commands](#verification) cover clean preparation and stale-cache recovery.

Create an owner-only directory outside this repository (mode 0700). Copy `config.example.json` there as a mode-0600 file and provide:

1. A limited, funded testnet HCS operator account/key; two existing open topics without custom fees. If needed, `npm run reference:setup` creates buyer/seller inbox topics with your explicit `HEDERA_NETWORK=testnet`, `HEDERA_OPERATOR_ACCOUNT_ID`, `HEDERA_OPERATOR_KEY_FILE` and a pre-existing private `NEURON_REFERENCE_STATE_DIR`. This command spends testnet fees and journals each ID before sending; preserve `topics.json` when reconciling or rerunning.
2. Separate buyer protocol delegate and seller secp256k1 keys. Raw 32-byte hex and DER hex files are accepted. The seller account must have its EVM Address from Public Key and enough testnet HBAR for its bounded release/withdrawal fees. Use fresh credentials dedicated to your test deployment.
3. A deployed upstream ERC20 escrow and token, their independently checked runtime Keccak hashes, exact token decimals/symbol and a small price. No contract is deployed or token minted automatically by bridge startup.
4. An immutable permitted source file, a 120–86,400 second refund window, lifetime session limit and bounded HCS/gas fees. For an interactive wallet run allow enough time for each explicit customer decision. A source/configuration change requires a fresh state directory; existing funded sessions must remain recoverable under their original configuration.
5. A random bearer token of 32–128 URL-safe characters (letters, digits, `_` or `-`), such as 64 random hex characters in a mode-0600 file; it never goes into a browser or repository.

Set these server-only environment variables:

```text
NEURON_REFERENCE_CONFIG_FILE=/absolute/owner-only/bridge-config.json
NEURON_REFERENCE_API_TOKEN_FILE=/absolute/owner-only/api-token
NEURON_REFERENCE_STATE_DIR=/absolute/owner-only/sessions
NEURON_REFERENCE_LISTEN=127.0.0.1:8098
```

Start the prepared binary without arguments. `--check` runs read-only account/topic/chain/bytecode/token preflight and emits public configuration. For the Next app set `NEURON_REFERENCE_URL=http://127.0.0.1:8098` and its server-only `NEURON_REFERENCE_API_TOKEN_FILE`. Its existing testnet customer authentication must also be configured. The bridge binds only loopback, requires the bearer, rejects browser Origin headers and accepts session requests only from the authenticated application proxy.

## Restart the configured local service

Use a supported Node version from the [root prerequisites](../../README.md) for installation, build and startup. `better-sqlite3` 13 uses Node-API with a native binary for the operating system and architecture. If that binary is missing or incompatible with the host, select a supported Node version, then run `npm run rebuild:native` in the repository root.

Keep a trusted, operator-maintained shell environment file outside the repository, mode 0600 in a 0700 directory. Include the bridge variables above with their existing paths, plus:

```text
NEURON_REFERENCE_BINARY=/absolute/operator-cache/neuron-reference
HEDERA_NETWORK=testnet
NEURON_ENABLE_REFERENCE_COMMERCE=true
NEURON_ENABLE_CUSTOMER_AUTH=true
NEURON_APP_ORIGIN=http://127.0.0.1:3000
NEURON_CUSTOMER_DB_FILE=/absolute/owner-only/customer.sqlite
NEURON_REFERENCE_URL=http://127.0.0.1:8098
```

From the repository root, load that same file in each terminal using its actual absolute path. Start the bridge in the first terminal:

```sh
set -a
. /absolute/owner-only/reference-runtime.env
set +a
"$NEURON_REFERENCE_BINARY"
```

After the bridge reports ready on `127.0.0.1:8098`, start the existing production build in a second terminal:

```sh
set -a
. /absolute/owner-only/reference-runtime.env
set +a
npm run start -w @neuron/nextjs -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000/reference` and sign in with the same testnet wallet when its login expires. After source changes, run `npm run build` under the same Node version before startup.

Routine shutdown and restart must retain the customer SQLite database and its WAL/SHM files, bridge journals, received files, bearer-token file, and the exact original configuration/source bytes. Even reformatting the configuration changes its fingerprint. Reuse the recorded paths; clearing history or replacing a state directory can strand transaction recovery. Configuration changes require a separately reviewed migration with preserved originals. Restart performs preflight; use the saved session and transaction hash to reconcile an interrupted wallet operation before another payment.

## Customer flow and recovery

The `/reference` page negotiates a document session, displays exact signed terms and requests these individual wallet decisions: create escrow, approve the exact token amount, then deposit. After funding, **Receive document** runs actual reference P2P delivery, independently hashes the received bytes, saves them, requests the seller's onchain release and publishes its signed invoice. The customer can download/review the document, then explicitly approve payment. **Settle** lets the seller withdraw only that approved amount to its own address. Alternatively the buyer can claim the exact remaining deposit after the deadline.

Every browser wallet opening has a persisted intent, including the exact chain nonce, before the provider is invoked. A separate `open-wallet` transition is persisted before invoking the provider: a merely prepared intent can be resumed or cancelled after reloading. An opened request that returned no hash can be explicitly retried with its identical nonce, buyer, chain, target, calldata and value; the network can execute at most one such transaction. A consumed nonce requires transaction-history reconciliation, and another reference session cannot reserve the same nonce. Same-nonce retries have no arbitrary opening-count cutoff; each opening is durably timestamped. A provider rejection on a retry cannot erase the original uncertain attempt. Refused wallet openings return HTTP 409, preventing an old `wallet-open` state from being interpreted as a new authorization.

Retain the returned transaction hash and use Refresh when indexing is delayed. The server checks the transaction's chain, signer, recipient, value, calldata, recorded nonce, receipt events and resulting escrow state. Hash candidates are retained to correct a pasted hash without issuing a new transaction. If your wallet explicitly replaces an uncertain transaction with a mined zero-value, empty-data self-transfer at the original recorded nonce, paste that cancellation hash into the same reconciliation field. The bridge checks the chain, signer, exact nonce, transaction hash and successful receipt before archiving the entire original intent and offering a fresh action. A pending, foreign, wrong-nonce or historical nonce-less cancellation cannot clear it. Never discard an intent merely because a transaction may have failed or disappeared. No timeout alone proves non-submission. A historical intent created before nonce recording cannot be assigned a nonce retrospectively or retried; its wallet must reconcile that old transaction before preparing another reference purchase. Its original journal is preserved.

Every HCS transaction ID and exact signed envelope is fsynced before submission. A failed/uncertain result is read back from official Mirror, with chunk identity, payer, bytes and signature checked. It is never blindly resubmitted. If the process dies before an HCS transaction was actually sent, that recorded request remains unresolved; use the persisted ID to investigate rather than issuing a second payment. Funded sessions still have their direct contract timeout refund.

Seller EVM transactions are signed with an explicit legacy gas price and gas cap, persisted before broadcast and reconciled by their original hash. Successful release/withdrawal hashes are reused on recovery. An unresolved seller broadcast retains its signed raw transaction in the owner-only journal; when the provider reports it missing, recovery validates and rebroadcasts those exact bytes, nonce and hash. The API never returns the raw transaction. A new transaction with a new nonce is not created to guess whether the old one succeeded.

State is an fsynced, atomic owner-only per-session JSON journal with one process holding an exclusive file lock. Wallet ownership survives re-sign-in: the authenticated same wallet can rebind to its new app session. The purchased source bytes are snapshotted and must match the negotiated hash. At most three actual delivery attempts are allowed. Other wallets cannot inspect the record or download its delivered file.

ERC20 allowance belongs to the wallet and escrow contract, so another purchase can consume it. Available actions re-read allowance; when it is insufficient, the buyer can approve the exact price again. The bridge checks allowance, token balance and prior buyer deposit events immediately before opening a deposit wallet request. If a prepared request becomes stale, cancel that unopened intent and refresh. An opened request retains its original nonce and must be reconciled; a revert clears the failed intent and permits a fresh exact approval. Approval receipt validation uses the exact event, so later consumption does not invalidate a successful approval.

The pinned escrow accepts token deposits from other wallets, even after payout or refund. The bridge permits the buyer’s one negotiated deposit despite such surplus, proves buyer deposits using events scoped from the confirmed creation block, and pays the seller only the negotiated amount. `paid-with-remainder` keeps a positive residual balance visible and exposes its buyer refund after the deadline. Refund receipts record the actual amount, including surplus; later deposits after a refund remain recoverable as `refunded-with-remainder`. Remaining balance, last refund amount and seller payment are separate public fields.

Journal version 2 stores both signed HCS envelope and payload as base64 byte fields, preserving them through JSON formatting and restarts. On startup, legacy unversioned journals are migrated only when undoing the old writer’s formatting restores the recorded SHA-256, valid signature, sender and matching embedded payload. The exact original is atomically saved as `<session-id>.json.v1.bak` before replacement; retain it with the journal. Unknown versions or changed signed content fail closed. Neither migration nor recovery changes transaction IDs, re-signs messages or blindly submits another HCS transaction.

The adapter supports testnet only. It refuses a second buyer deposit into the same escrow, fixes the release recipient and requires explicit buyer approval for each release.

## Verification

From the template root, run the preparation integration check:

```sh
node --test packages/neuron-reference/scripts/prepare.integration.test.mjs
```

It fetches the pinned source into a disposable cache, builds twice, checks stale overlay/manifest recovery and unexpected-source rejection, then runs Go race tests and vet. CI runs this check. Fast cache regressions also run in `npm run test:tooling`. Neither sends Hedera transactions.

To check an existing prepared module (`<cache>/source/impl/golang`), run:

```sh
GOTOOLCHAIN=go1.27.1 go test -race -count=1 ./cmd/scaffold-reference
GOTOOLCHAIN=go1.27.1 go vet ./cmd/scaffold-reference
```

The local regression suite runs the pinned original ERC20 and escrow bytecode in an in-process EVM: shared allowance consumption/reapproval, stale deposit opening, dust before/after funding, exact seller payout, surplus/full refund and deposits after refund. Its seeded delivery/HCS records isolate payment accounting; they do not prove live Hedera or P2P delivery. Separate tests preserve signed bytes across versioned/legacy journals and SIGKILL, reject corruption, and reconcile an unverified persisted message against a local HTTP Mirror fixture.

For a configured testnet service, verify one exact-file purchase and a separate funded timeout refund with explicit wallet approval. Record revision, HCS references, file SHA-256, escrow IDs, token units, receipt results and buyer/seller balance changes. See the [maintenance report walkthrough](../../docs/paid-data-example.md) and [historical testnet evidence](../../docs/testnet-evidence.md).
