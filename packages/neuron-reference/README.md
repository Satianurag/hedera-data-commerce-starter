# Owner-operated Neuron reference document service

This optional **testnet-only** adapter connects the template to the pinned Neuron reference protocol. It imports the upstream canonical payment messages, signatures, EVM contract bindings, ECIES connection setup and real libp2p file transport. The application supplies durable state and explicit browser-wallet approval around them.

The service delivers the actual bytes of one operator-selected, permitted file. The development deployment uses the project's own MIT README document. It is a document delivery example, not a live aviation feed. Existing legacy aviation streaming and the starter's native-HBAR escrow remain separate adapters.

## Exact compatibility target

- Upstream repository: `https://github.com/NeuronInnovations/neuron-specs.git`.
- Revision: `13ab01d70ac42531065094a52cd595ef7b6d3223`.
- Build runtime: Go `1.26.8`; dependencies use the same patched Hiero, libp2p, gRPC, crypto and Pion versions as the existing Go gateway. The prepared `build-provenance.json` records the resolved module graph.
- Payment uses the upstream `NeuronEscrow` **ERC20** ABI. Token values are integer token base units with independently checked decimals. They are never described as HBAR/tinybar. HBAR only pays network fees.
- Protocol payloads use the original upstream `payment` serializers unchanged. `serviceParams` is the upstream-defined application map; it carries the customer wallet, chain, escrow, immutable document hash/size/name and refund deadline for this document service.
- `agreementHash` is the upstream Keccak-256 of the canonical accepted `serviceResponse`. Its unique request ID refers to the signed service request containing exact terms.
- Escrow references are the upstream `<contractAddress>:<escrowId>` and release references add `:<releaseId>`. Network binding is separately enforced by the immutable testnet configuration and chain checks.
- The pinned invoice has eight canonical fields and **no `evidenceHash` field**. Evidence is bound by the onchain release request referenced by the invoice. The bridge verifies its exact amount, seller recipient and evidence hash before exposing buyer approval. This resolves the observed implementation path without claiming the draft's contradictory prose is settled.
- `bridge/testdata/upstream-invoice-mirror.json` is a historical signed reference-demo invoice from testnet topic `0.0.10709352`, sequence `3`, fetched 27 September 2026. Its `mem-*` references mean it proves original invoice bytes/signature only, never candidate settlement.

The buyer's protocol identity is a server delegate. The signed-in customer wallet is separately bound in the signed request and is the actual onchain escrow buyer. The bridge has **no customer payment key**. Customer create, token allowance, deposit, release approval and refund calls are prepared as unsigned transactions and individually approved in the browser wallet. A separate seller key signs only its release request and withdrawal, with the recipient fixed to that seller.

This is an original orchestration adapter around upstream reference components. Both actual P2P peers run on the same host over loopback QUIC, so the user's blocked inbound router does not prevent this bounded path. It does not establish independent deployed seller compatibility, remote P2P reachability, official registry discovery, official endorsement, browser receipt, or physical sensor provenance. The delivered file is downloadable through the customer's authenticated app session.

## Prepare and configure

Run `node packages/neuron-reference/scripts/prepare.mjs`. It fetches the exact revision into an external cache and compiles the original bridge overlay as `cmd/scaffold-reference`. The upstream internal Go packages require building in that module. No upstream source or binary is copied into this repository. The upstream checkout has no root license file at this revision; public redistribution of its source/binary requires separate license review. Our wrapper follows this repository's license without relicensing upstream code.

The preparation command prints the absolute binary path. Set `NEURON_REFERENCE_CACHE` to change the owner-controlled build cache. Go 1.26.8 can be selected through the standard Go toolchain mechanism. A changed upstream source checkout is rejected.

Create an owner-only directory outside this repository (mode 0700). Copy `config.example.json` there as a mode-0600 file and provide:

1. A limited, funded testnet HCS operator account/key; two existing open topics without custom fees. Topic creation is an explicit provisioning step.
2. Separate buyer protocol delegate and seller secp256k1 keys. Raw 32-byte hex and DER hex files are accepted. The seller account must have its key-derived EVM alias and enough testnet HBAR for its bounded release/withdrawal fees. Never use the disclosed historical test credentials.
3. A deployed upstream ERC20 escrow and token, their independently checked runtime Keccak hashes, exact token decimals/symbol and a small price. No contract is deployed or token minted automatically by bridge startup.
4. An immutable permitted source file, a 120–86,400 second refund window, lifetime session limit and bounded HCS/gas fees. For an interactive wallet run allow enough time for each explicit customer decision. A source/configuration change requires a fresh state directory; existing funded sessions must remain recoverable under their original configuration.
5. A random bearer token of at least 32 characters in a mode-0600 file; it never goes into a browser or repository.

Set these server-only environment variables:

```text
NEURON_REFERENCE_CONFIG_FILE=/absolute/owner-only/bridge-config.json
NEURON_REFERENCE_API_TOKEN_FILE=/absolute/owner-only/api-token
NEURON_REFERENCE_STATE_DIR=/absolute/owner-only/sessions
NEURON_REFERENCE_LISTEN=127.0.0.1:8098
```

Start the prepared binary without arguments. `--check` runs read-only account/topic/chain/bytecode/token preflight and emits public configuration. For the Next app set `NEURON_REFERENCE_URL=http://127.0.0.1:8098` and its server-only `NEURON_REFERENCE_API_TOKEN_FILE`. Its existing testnet customer authentication must also be configured. The bridge binds only loopback, requires the bearer, rejects browser Origin headers and accepts session requests only from the authenticated application proxy.

## Customer flow and recovery

The `/reference` page negotiates a document session, displays exact signed terms and requests these individual wallet decisions: create escrow, approve the exact token amount, then deposit. After funding, **Receive document** runs actual reference P2P delivery, independently hashes the received bytes, saves them, requests the seller's onchain release and publishes its signed invoice. The customer can download/review the document, then explicitly approve payment. **Settle** lets the seller withdraw only that approved amount to its own address. Alternatively the buyer can claim the exact remaining deposit after the deadline.

Every browser wallet opening has a persisted intent, including the exact chain nonce, before the provider is invoked. A separate `open-wallet` transition is persisted before invoking the provider: a merely prepared intent can be resumed or cancelled after reloading. An opened request that returned no hash can be explicitly retried with its identical nonce, buyer, chain, target, calldata and value; the network can execute at most one such transaction. A consumed nonce requires transaction-history reconciliation, and another reference session cannot reserve the same nonce. At most three wallet openings are allowed. A provider rejection on a retry cannot erase the original uncertain attempt. Refused wallet openings return HTTP 409, preventing an old `wallet-open` state from being interpreted as a new authorization.

Retain the returned transaction hash and use Refresh when indexing is delayed. The server checks the transaction's chain, signer, recipient, value, calldata, recorded nonce, receipt events and resulting escrow state. Up to eight hash candidates can be retained to correct a pasted hash without issuing a new transaction. Never cancel when a transaction may have been broadcast. No timeout alone proves non-submission. A historical intent created before nonce recording cannot be assigned a nonce retrospectively or retried; its wallet must reconcile that old transaction before preparing another reference purchase. Its original journal is preserved.

Every HCS transaction ID and exact signed envelope is fsynced before submission. A failed/uncertain result is read back from official Mirror, with chunk identity, payer, bytes and signature checked. It is never blindly resubmitted. If the process dies before an HCS transaction was actually sent, that recorded request remains unresolved; use the persisted ID to investigate rather than issuing a second payment. Funded sessions still have their direct contract timeout refund.

Seller EVM transactions are signed with an explicit legacy gas price and gas cap, persisted before broadcast and reconciled by their original hash. Successful release/withdrawal hashes are reused on recovery. An unresolved seller broadcast retains its signed raw transaction in the owner-only journal; when the provider reports it missing, recovery validates and rebroadcasts those exact bytes, nonce and hash. The API never returns the raw transaction. A new transaction with a new nonce is not created to guess whether the old one succeeded.

State is an fsynced, atomic owner-only per-session JSON journal with one process holding an exclusive file lock. Wallet ownership survives re-sign-in: the authenticated same wallet can rebind to its new app session. The purchased source bytes are snapshotted and must match the negotiated hash. At most three actual delivery attempts are allowed. Other wallets cannot inspect the record or download its delivered file.

The underlying upstream escrow has draft limitations and is enabled only for this limited testnet path. The bridge forbids repeated deposits into the same escrow, never changes the release recipient, and never approves a buyer release automatically. It does not make the upstream contract production safe or pass the separate mainnet release gate.

## Verification

Preparation builds the actual bridge. The final check should run the bridge's focused tests in the prepared upstream module, then one real buyer-wallet document purchase and one independently funded timeout-refund session. Record exact candidate revision, HCS references, document SHA-256, escrow IDs, token units, successful receipts and seller/buyer token deltas. A private reference-component run must not be called a public Neuron deployment or independent seller proof.

```text
GOTOOLCHAIN=go1.26.8 go test ./cmd/scaffold-reference
```

On 27 September 2026 the Go 1.26.8 bridge build, four focused tests and package vet passed. The official Go vulnerability scan reported zero reachable/imported-package vulnerabilities and one unused required-module finding. Read-only preflight passed against the actual configured testnet accounts, topics, runtime bytecode hashes and token metadata. No passing end-to-end purchase result is implied by those gates; record the separate live browser evidence after completing it.
