# Neuron Customer App Implementation Plan

> **For agentic workers:** Checkboxes track *complete tasks*, so partial work remains unchecked. The latest user instruction explicitly resumes **coding the full product**. Keep the real-infrastructure, no-mocks, end-to-end objective; earlier small-slice/bounty gates are milestones, not the completion definition. Read [AGENTS.md](../../../AGENTS.md) for current evidence.

**Goal:** Build a reproducible Scaffold-HBAR customer application template that proves a signed Neuron service session and Hedera testnet evidence, then adds independently gated live-seller commerce and a separate mainnet release.

**Target architecture:** The npm monorepo has a Next.js customer app, focused Neuron/Hedera reader, Go HCS writer and legacy QUIC/WebSocket gateway, and Foundry native-HBAR escrow package. Candidate HCS, a real legacy-seller stream in the Next.js browser, and distinct-account escrow release/refund transactions passed on testnet. The current read pages use the live legacy directory and real HCS/Mirror data. The local testnet stream page uses a loopback gateway and single-use ticket; durable customer sessions and remote TLS/WSS deployment remain. Signed spec-first sellers, quote-bound checkout and mainnet deployment each require independent proof.

**Tech Stack:** The candidate has an npm workspace and lockfile with Next.js 16.3.6 / React 19.3.0 / TypeScript 5.9.3, ESLint 9.39.5 / `typescript-eslint` 8.55.0, Foundry npm CLI 1.7.1 and ethers 6.17.0. Clean Node 20.18.3/22.23.3 installs, full dependency checks, build, typecheck, lint, 13 shared tests and five contract tests, and zero-finding npm audits passed for the current lockfile. The Go module pins `hiero-sdk-go/v2` 2.84.0, `go-libp2p` 0.50.0, `coder/websocket` 1.8.15, patched gRPC 1.83.2, `x/crypto` 0.56.0, Pion DTLS 3.1.4 and STUN 3.1.5 under Go **1.26.8**. Go 1.26.0 had reachable standard-library vulnerability findings and is below the current safe floor. Hardhat 2.29.1 had 19 npm audit findings and was removed. The browser stream UI is now local testnet only. The unpublished `@neuron-sdk/typescript` is **not** a dependency until installable and verified. See [AGENTS.md](../../../AGENTS.md).

**Spec:** [Product and release specification](../specs/2026-09-25-neuron-customer-app.md). **Audit:** [Readiness audit](../../../READINESS_AUDIT_2026-09-25.md).

## Global constraints

- Bounty deadline: **4 October 2026, 11:59 p.m. ET**. A fresh testnet transaction must come from the candidate template itself. The previous audit's transactions do not satisfy this.
- Bounty repository: public MIT monorepo, separate frontend and contracts packages, Next.js plus Hardhat/Foundry, npm or Yarn workspaces, Node ≥20.18.3, `template.json`, README and AGENTS.md.
- Current user instruction: resume coding the full product incrementally. Testnet first; mainnet is a later separate release. Router cannot accept inbound traffic; temporary outbound UDP tunnel is approved for legacy interoperability tests.
- One selected network per process. All account, topic, contract, chain, Mirror and RPC identifiers carry that network. CLI `--network` is not relied upon to configure runtime.
- No existing chat-pasted or old buyer key enters source, sample env, CI, frontend or mainnet. Zero-secret boot must work with writes disabled.
- Every money value uses an explicit asset and integer base units. Native HBAR has 8 decimals, JSON-RPC HBAR value representation 18, and ERC20 decimals are token-specific.
- Signed control message and seller binding are required before `verified` or `live` labels. Data stream freshness is measured separately from HCS heartbeat freshness.
- A quote/invoice and explicit authorization precede payment; transaction submission, schedule creation and Mirror indexing are distinct states. No automatic schedule signing.
- All upstream versions, testnet IDs and seller availability must be rechecked immediately before execution and before release. Record exact pins in the eventual lockfile/release evidence.

## Review focus

These are high-risk inputs that a happy-path demo could miss. Each belongs to the named task's verification:

1. A mainnet topic ID queried on testnet (or reverse) can produce an empty HTTP 200; Task 2/3 must reject it using network-tagged configuration and topic metadata.
2. A valid HCS message split into chunks or paginated across Mirror pages can be partly read; Task 3 must reconstruct 1,024/1,025/2,048-byte cases and reject missing/duplicate chunks.
3. A signed but stale/replayed message or a current heartbeat with dead data must not display a live service; Tasks 4/5/6 test nonce/expiry and stream freshness independently.
4. Legacy binary ADS-B can be corrupted by UTF-8 conversion; Task 8 must preserve exact bytes and prove representative CRC-valid decoding, including backpressure/reconnect.
5. A seller schedule naming the wrong payee, amount, asset or shared account may still be signable; Task 9 must reject it before signing and verify actual executed transfer/refund and balance deltas.

## Current evidence and unblocked design choices

| Question | Decision now | Evidence / remaining gate |
|---|---|---|
| What is being built? | A reusable **customer app starter**, with aviation as an example. | Spec §1; the owner-supplied research attachment is background and is not distributed with the template. |
| Can it use npm Neuron SDK? | No dependency on it in first release. Implement only a pinned, tested protocol subset. | `@neuron-sdk/typescript` returned E404 on 25 September; reference source is at [`13ab01d`](https://github.com/NeuronInnovations/neuron-specs/tree/13ab01d70ac42531065094a52cd595ef7b6d3223). |
| Which seller? | Real active legacy sellers for the first end-to-end data path; a separate spec-first seller only when it has an actual source. | No public canonical spec-first Agent Card/deployment established; all nine legacy sellers did send data via a temporary tunnel. |
| What does the browser use? | Authenticated WSS from a persistent gateway with byte-preserving payloads and explicit session states. | Next.js request handlers do not own long-lived legacy QUIC/UDP sessions; a reachable UDP host is required for deployment. |
| How will money work? | No signer is enabled until Task 9's signed-terms, durable-intent and refund gate passes; full product completion requires real settlement. | Legacy auto-sign is unsafe; seller registry `fee` did not map to actual debits; distinct-account ERC20 release/refund is only experimental. |
| Is a contract required? | Yes: `packages/foundry` implements native-HBAR custody, buyer approval and timeout refund, with local and real testnet tests. | This proves settlement mechanics; signed seller terms, delivery and customer checkout remain unimplemented. |
| Is mainnet ready? | No. Task 10 is a separate release gate. | No mainnet write, deployment, provider or signer proof exists. |

## Planned file map

Some paths now exist in the **partial candidate**; the rest are planned. One unit owns each responsibility; the exact implementation may follow scaffold conventions while preserving these boundaries. Check the worktree and [AGENTS.md](../../../AGENTS.md) before treating any row as complete.

| Path | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `template.json`, `.nvmrc`, `.gitignore` | npm workspace, reproducible scripts, CLI manifest, Node floor, secret/build exclusions |
| `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/testing.md` | user setup, network/credential model, honest capability labels, exact validation and troubleshooting |
| `packages/neuron-hedera/src/network.ts` | strict network selection, typed network-tagged IDs and endpoint allowlist |
| `packages/neuron-hedera/src/identity.ts` | configured seller descriptor, signing key binding, envelope verification, nonce/expiry replay policy |
| `packages/neuron-hedera/src/hcs.ts` | submit + receipt status, Mirror pagination/chunks, metadata and confirmation matching |
| `packages/neuron-hedera/src/session.ts`, `src/frames.ts` | session state, raw bytes, freshness, backpressure, decoder contract |
| `packages/neuron-hedera/src/commerce.ts` | quote/invoice validation, money units, cap and transaction state, activated only after Task 9 |
| `packages/nextjs/app/...`, `packages/nextjs/lib/...` | discovery/detail/session/evidence views, server routes for safe reads, WSS client, wallet boundary |
| `packages/gateway/...` | persistent authenticated WSS endpoint, session ownership and durable state |
| `packages/foundry/src/...`, `packages/foundry/test/...` | selected native-HBAR settlement contract and tests |
| `packages/legacy-neuron/...` | server-only adapter for live legacy registry/QUIC/UDP and binary aviation data |
| `tests/fixtures/...`, `scripts/verify-testnet...` | pinned protocol fixtures and reproducible fresh candidate HCS evidence collection |

The public template must describe exactly which live data and payment flows passed at its submitted commit. A bounty deadline does not reduce the user's full-product completion criteria.

## Phase 0: freeze sources and execution environment

### Task 0.1: Source/version ledger

**Files:** update audit; create candidate `docs/source-ledger.md` during implementation. **Inputs:** official bounty, CLI, scaffold, Neuron specs/Go SDK/NodeBuilder, Hedera HCS/Mirror/fees/network docs. **Output:** one table with URL, revision/date, observed result, and affected feature. **Checks:** repeat `npm view create-scaffold-hbar version` and `npm view @neuron-sdk/typescript version`; compare upstream heads with pins; inspect actual live seller/registry/topic metadata before use. **Pass:** no unversioned dependency or unsupported deployment/SDK assertion. **Stop:** bounty requirements changed materially or selected spec has no implementable signed session format.

- [ ] Recheck and record exact source revisions, package versions and license before touching the candidate.
- [ ] Classify each feature as `documented`, `reference-only`, `live tested`, or `not verified`.
- [ ] Resolve any changed source by updating spec, audit and this plan before implementation.

### Task 0.2: Clean environment and credentials

**Files:** candidate `.nvmrc`, `.gitignore`, example env with *names only*; local non-repository credential store. **Checks:** clean Node 20.18.3 and 22.23.3, npm installer; optional Yarn only if documentation claims it; `git status`, secret scan, zero-secret boot. **Pass:** a new limited testnet signer can be used only on the server/test runner and is not disclosed in logs or artifacts. **Stop:** only the previously exposed key is available, or a secret enters the browser/repo. The candidate must not depend on Docker because its daemon was stopped at last audit.

- [ ] Pin runtimes and package manager; install from a clean cache/directory.
- [ ] Create a fresh limited testnet identity; set test-only spend and request caps.
- [ ] Confirm no credential value is committed, copied into examples, or returned by an HTTP route.

## Phase 1: smallest truthful Scaffold-HBAR testnet template

### Task 1: Monorepo and CLI manifest

**Files:** root manifest/scripts/docs plus `packages/nextjs`, `packages/neuron-hedera`, `packages/foundry`; add `packages/gateway` and `packages/legacy-neuron` as their real session path is implemented. **Interface:** each workspace exposes explicit `lint`, `typecheck`, `test`, `build` where applicable; root commands invoke the real workspace scripts. **Checks:** CLI copying with `@latest` and pinned 0.4.0; npm workspace install on Node 20.18.3 and 22.23.3; package-selection behavior; root lint/typecheck/test/build/boot; `/` read-only HTTP 200 without secrets. **Pass:** valid `template.json` and no misleading capability fallback; AGENTS/README work from a fresh directory. **Stop:** success only in original repo, copied manifest missing files, or a baseline dependency error reproduced in the candidate.

- [ ] Create the minimal monorepo, lockfile, scripts, manifest and docs with MIT licensing.
- [x] Add separate Next.js and Foundry packages with tested native-HBAR custody/recovery mechanics; signed quote and app checkout remain open.
- [ ] Run fresh scaffold/install/build/boot on both Node versions; repair candidate dependencies before proceeding.

### Task 2: Explicit network and trust configuration

**Files:** `network.ts`, matching tests, frontend/server configuration. **Interface:** `NetworkConfig` contains `name`, `chainId`, `mirrorBaseUrl`, `rpcUrl`, `accountIds`, `topicIds`, optional contracts, and versioned seller descriptors; constructors reject mixed-network IDs/config. **Checks:** testnet setup succeeds; mainnet/testnet mismatch, missing topic metadata, empty messages HTTP 200, wrong chain/wallet and unknown hostname all fail closed; zero-secret mode permits reads and disables writes. **Pass:** no code path infers runtime network from CLI flag, account number or URL alone. **Stop:** one environment variable can silently point Hedera SDK to testnet and Mirror to mainnet.

- [ ] Define one network-tagged configuration shape and parse it at process startup.
- [ ] Test mismatched account/topic/Mirror/wallet/contract combinations and zero-secret behavior.
- [ ] Show current selected network and trust source in the app.

### Task 3: HCS transaction and Mirror evidence

**Files:** `hcs.ts`, `packages/neuron-go/cmd/hcs-submit`, fixtures/tests, evidence server route/view, fresh-testnet verification script. **Interface:** submit returns a transaction reference only after consensus receipt; read-back returns a verified message record with topic, payer, consensus timestamp, sequence, transaction ID, schema/version and payload hash. **Checks:** 1,024/1,025/2,048-byte fixtures, chunk groups, relative `links.next`, duplicate/missing/out-of-order chunks, malformed base64/JSON, unknown schema, payer mismatch, nonexistent topic, 404/429/5xx, indexing delay and timeout. The testnet integration creates or uses a controlled topic, submits from the candidate, obtains receipt `SUCCESS`, and independently matches Mirror result. One working-tree transaction now has this narrow proof; commit attribution and remaining edge cases are pending. **Pass:** clickable fresh transaction and topic evidence attributable to the submitted commit. **Stop:** treating transaction submission or an empty Mirror page as proof.

- [ ] Implement receipt-first HCS submission and bounded Mirror reconciliation.
- [ ] Verify metadata before messages, reassemble chunks exactly, and reject mismatches.
- [ ] Produce a fresh candidate testnet transaction and preserve its public evidence URL/decoded hash.

### Task 4: Live discovery and identity boundaries

**Files:** `identity.ts`, live legacy directory reader and tests, service detail view. **Interface:** a descriptor carries network/account/service/protocol/public key/endpoint; the live legacy directory is cross-checked against Mirror account/topic metadata and labelled `legacy directory` rather than signed Agent Card. Separately verified signed envelopes carry sender, nonce, issued/expiry time and payload hash. **Checks:** wrong account/PeerID/service, stale directory, forged key, expired/future/replayed nonce, key rotation and revoked descriptor; unsigned legacy heartbeat displayed only as unverified. **Pass:** actual seller records are shown with accurate provenance and trust. **Stop:** a registry API row or HCS payer alone makes the UI say `verified`.

- [ ] Read real legacy seller records and verify selected account/topic metadata on the selected network.
- [ ] Implement a signed spec-first subset only against canonical reference fixtures and a seller with an actual source; bind its key, service ID and endpoint to the network.
- [ ] Add negative identity and replay tests before enabling a `verified` label.

### Task 5: Persistent gateway and browser frames

**Files:** `session.ts`, `frames.ts`, persistent gateway and legacy QUIC adapter, WSS client and session view. **Interface:** start/stop operations carry an authenticated unique session ID; each received frame remains `Uint8Array` with checked sender, receive time and format; state machine has explicit stale/error/teardown states. Durable storage records owner, nonces and session lifecycle. **Checks:** browser opens WSS backed by a real legacy seller, receives exact bytes, stops, reconnects with a new session, rejects old frames; no-data timeout and control-heartbeat-only scenario show stale; malformed payload and backpressure are bounded; remote TLS/origin and UDP reachability are deployment tests. **Pass:** a working application-level stream carrying actual seller bytes; zero UTF-8 replacement before binary decoding. **Stop:** generated demo frames, a peer listed in heartbeat treated as a healthy stream, or an inbound router rule assumed on this host.

- [ ] Run a live legacy seller and browser through the complete request/connect/data/stop cycle using a reachable UDP route.
- [ ] Test reconnect, stale data, cleanup and bounded buffering with binary fixtures.
- [ ] Record which proof ran locally and which ran from a remote TLS browser host.

### Task 6: Customer application and zero-secret experience

**Files:** Next.js discovery/detail/session/evidence routes and server-only Hedera access. **Interface:** UI reads typed state from Tasks 2–5, displaying source/trust, exact network, data freshness, receipt status and reasoned errors. **Checks:** boot with no secrets; routes `/`, `/services`, one service detail, session and evidence load; wallet/server secrets absent from built JS and all HTTP payloads; accessibility, disconnect/retry and empty data. **Pass:** a Web2 tester can understand what was discovered, whether it is verified, whether bytes are arriving and what Hedera confirmed. **Stop:** hidden key use, false payment-ready button, or unqualified “live/verified” badge.

- [ ] Build read-only routes first; connect them to verified session and evidence state.
- [ ] Exercise empty, loading, disconnected, stale, invalid and successful states.
- [ ] Confirm server-only credential boundary and zero-secret boot from the scaffolded copy.

### Task 7: Bounty submission gate and evidence pack

**Files:** README, AGENTS, testing document, source ledger, release evidence JSON/Markdown. **Checks:** public MIT repo; exact current CLI command from a new directory; full install/lint/typecheck/tests/build/boot; Node 20.18.3 and 22.23.3; route smoke; fresh candidate HCS transaction and Mirror proof; no secrets or irrelevant local artifacts; contracts package retained. Compare template/manifest against [official brief](https://hedera.com/blog/scaffold-hbar-template-bounty/) again before submission. **Pass:** a reviewer can reproduce the demo and inspect the transaction, with E/F status accurately marked. **Stop:** historical audit transaction substituted for candidate transaction, or unresolved baseline build error waived.

- [ ] Run the exact clean-room scaffold and build matrix, recording commands and outputs.
- [ ] Verify the candidate's new testnet transaction independently and add the evidence link.
- [ ] Reconcile every README claim with the feature/evidence table and the actual submitted commit.

## Phase 2: legacy seller compatibility and safe commerce

### Task 8: Live legacy seller adapter and binary aviation data

**Files:** `packages/legacy-neuron` adapter, binary codec and tests, opt-in UI example, test harness docs. **Interface:** a selected seller uses exact legacy registry/contract/protocol version and a server-only QUIC peer; adapter emits original bytes and independent service/sender/session metadata, never a lossy string. **Checks:** user-approved temporary outbound UDP tunnel echo; exact live registry/topic/key binding; one, two, six and nine sellers; seller `0.0.6490481` sustained-session/retry investigation; Mode-S length, CRC, partial frame, malformed frame, high-throughput and UI backpressure. **Pass:** real data appears in the application and valid aviation frames decode without corruption, with measured stream health. **Stop:** NodeBuilder's different registry, JSON-lines assumption, private-key-leaking API, or a brief initial connection treated as durable. This task is required for the user's live-seller product goal.

- [ ] Revalidate live sellers and tunnel endpoint just before each controlled run.
- [ ] Preserve raw bytes from QUIC ingress through the server/browser boundary and test exact equality.
- [ ] Repeat concurrency and recovery tests; document any unresolved seller-specific loss.

### Task 9: Terms, settlement and fund recovery

**Files:** `commerce.ts`, checkout UI/server signer boundary, contract package payment extension only if chosen, tests and testnet evidence. **Interface:** quote/invoice binds network, buyer, seller/payee, shared account/contract, service/session, asset, amount in integer base units, duration, expiry, fee split and maximum spend; explicit user confirmation creates an authorized payment intent; receipt records actual executed transfer and balance deltas. **Checks:** wrong payee/amount/asset/decimals/nonce, replay, quote expiry, duplicate invoice, sender mismatch, unfunded shared account, insufficient allowance, RPC null/429/outage, schedule created but inner transfer absent, refund with missing signer, timeout, disputed or stalled session, failed delivery, distinct buyer/seller, payer balance after fees. For ERC20, use actual token decimals and independently test release and timeout refund; for native HBAR, do not claim escrow until a distinct, audited mechanism passes. **Pass:** no automatic sign; exact terms accepted by buyer; real testnet execution and recoverability independently verified. **Stop:** legacy registry `fee` shown as checkout price, an evidence hash treated as delivery oracle, or a scheduled transaction treated as unconditional escrow.

- [ ] Pick one documented payment binding based on signed seller terms and an explicit refund model.
- [ ] Add negative terms tests and caps before any testnet signer can authorize settlement.
- [ ] Run low-value distinct-account testnet delivery/payment/refund paths and reconcile Mirror/provider records.
- [ ] Require a security review of payment paths and truthful UI labels before broad live-seller use.

## Phase 3: separate mainnet release

### Task 10: Mainnet configuration, pilot and release decision

**Files:** separate mainnet config, deployment/evidence runbook, operational monitoring and rollback notes. **Prerequisites:** Tasks 1–7 pass on a clean candidate; Tasks 8–9 pass if mainnet live seller commerce is claimed. Mainnet has a distinct signer/account, topics, IDs, registry/Agent Card proof, WSS host, production Mirror/RPC provider, fee/spend cap and monitored incident response. **Checks:** read-only discovery; dry-run exact transaction list/cost; small scoped write, receipt and Mirror read-back; explicit seller/delivery/payment/refund pilot if commerce is enabled; no reliance on testnet IDs or temporary UDP tunnel as deployed architecture. **Pass:** a dated mainnet evidence record supporting only the features actually exercised. **Stop:** missing signer authorization, unknown costs, unavailable production provider, uncertain asset/quote/refund semantics, or any network mismatch. Mainnet writes require a separate reviewable release decision; this plan itself does not authorize them.

- [ ] Prepare a concrete mainnet deployment and cost sheet after testnet passes.
- [ ] Obtain dedicated mainnet credentials and release authorization only against that concrete sheet.
- [ ] Execute and independently verify a bounded pilot; update public support claims from its evidence.

## Completion ledger and handoff

| Milestone | Currently complete? | What makes it complete |
|---|---|---|
| Upstream/source audit | **Yes, as of 25 September 2026** | Audit links, pinned heads and historical live evidence; recheck before execution |
| Reviewable prebuild spec and plan | **Yes** | This spec/plan pair with scope, files, gates and failure conditions |
| Candidate app and bounty qualification | **No** | Tasks 0–7 and fresh candidate transaction |
| Public seller app compatibility | **No** | Task 8, including binary-safe browser output and concurrency characterization |
| Safe live commerce | **No** | Task 9 with signed terms, explicit authorization, execution and recovery |
| Mainnet support | **No** | Task 10 with its own provisioning, authorization and live evidence |

Before each implementation phase, the engineer should read the spec, historical audit, current worktree, and [AGENTS.md](../../../AGENTS.md), then rerun Task 0's relevant source checks. The latest user instruction authorizes coding the full customer app, including live commerce and dual-network verification; Tasks 1–7 are milestones. No part of this document treats the old research file, live seller API, or past transactions as instructions to spend funds.
