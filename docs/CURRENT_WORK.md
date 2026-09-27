# Current work — 27 September 2026

This is the current task list. Dated audits preserve historical evidence; they are not lists of work to repeat. The owner resumed implementation and asked for the missing integration to be completed autonomously. Keep scope to the reusable Neuron customer template.

## Decision

Operate our own reference-backed seller and connect one explicitly versioned protocol end to end. Seller ownership is not an interoperability restriction. The known reference signed invoice is already recorded at testnet topic `0.0.10709352`, sequence `3`; it used mock settlement, so do not rerun it merely to discover its fields.

Use `neuron-specs@13ab01d70ac42531065094a52cd595ef7b6d3223`, rechecked against upstream on 27 September. The upstream Go packages live under `internal/`; prepare a pinned checkout with the checked-in integration command, rather than assuming a published npm SDK. Retain the current compatible npm graph. The bounty says Node 20.18.3 **or later**; the existing dual-runtime checks are a project support choice, not a bounty rule requiring the oldest patch forever.

The default `.nvmrc` now selects **22.23.3**, the latest patch of the supported Node 22 LTS branch on 27 September. Node's official release table lists Node 20 as EOL. Historical Node 20 results remain historical compatibility evidence; new deployments use the supported default. Node 24.21.0 is another current LTS, but changing the working native-module runtime again is unnecessary for this integration.

The reference path uses draft-008 messages, original delivery primitives and the matching ERC20 contract. The existing `neuronCustomerQuote/v1` plus native-HBAR `BuyerEscrow` remains a separately named extension. Existing legacy public sellers use scheduled transfers and raw ADS-B QUIC; they do not automatically support either new checkout.

The first reference service delivers a real owner-selected document. In this checkout, the MIT project README can be used as actual content. Its length and SHA-256 must match across delivery; sample/synthetic sensor data must never be called live aviation. The existing external legacy aviation stream remains the live-source example.

## Finite implementation and release list

| Work | Current status | Completion evidence |
| --- | --- | --- |
| Existing template, live legacy stream, HCS/Mirror, native-HBAR mechanics | Implemented; historical candidate evidence recorded | Preserve current working components; relevant regression checks at final gate |
| Reference source preparation and server bridge | Implemented; actual paid and refund API flows passed | Original signed HCS messages, exact-byte QUIC delivery, invoice, ERC20 seller receipt and deadline refund verified |
| Browser reference service and payment actions | Implemented; real wallet create and exact allowance passed | Nonce recovery fixed at `c265128`; complete installed-wallet purchase remains pending |
| Distinct identities and actual testnet deployment/configuration | Passed actual preflight | Real topic creation, bytecode, account keys, token metadata and source hash verified |
| Complete paid-delivery path | Passed through authenticated application API | Escrow 6/release 1; exact 29,099-byte document downloaded, seller received exactly 0.01 NTT and escrow emptied |
| Failure/refund path | Passed through authenticated application API | Escrow 5 returned exactly 0.01 NTT after its real deadline; buyer balance increased, seller balance stayed unchanged and escrow emptied |
| Browser wallet | MetaMask 13.50.0 connect/sign/create/allowance passed | Disposable testnet wallet; full purchase remains pending. Other installed wallet paths are separate |
| Final candidate checks | Code gate passed at `5bf0dc3`; focused recovery gate passed at `c265128` | Production build, type/lint, 43 shared + 8 contract + 22 Next tests, zero npm audit and zero reachable Go findings; recovery revision also passed five frontend/four Go tests and rebuilt |
| Hosted update | Access recovery pending | Needs current artifact deployment and HTTPS flow verification; existing OCI artifact is older |
| Mainnet | Separate milestone; not implemented end to end | Network-specific resources, compatible seller binding, provider, bounded cost/transaction manifest, release authorization and pilot |

The current live evidence, including failed attempts, is in [the 27 September record](reference-evidence-2026-09-27.md). Preserve session `1bce886b-a0a7-4ae9-9e08-a74bb0b4a5e2` (escrow 4): its original provider-failed deposit has no recorded nonce/hash, and must not be silently reset. At the independent observation its escrow had no funds and buyer retained all 0.05 NTT.

The complete paid/refund API run used source `c265128348b97fe86bb0ff143345496481a3c15d` and normal challenge/signature authentication with a fresh controlled testnet signer. It delivered the real file, paid the seller, then refunded the separate no-delivery escrow after its ten-minute deadline. Buyer gas including the 0.05 NTT mint totaled **0.86683231 HBAR**, below the **1.2 HBAR** bound. All buyer transactions and both seller settlement transactions were independently matched through RPC and official Mirror. These completed results need no repeat merely to obtain a differently owned seller.

Remaining live gates are the complete installed-wallet purchase, the updated hosted deployment and the separate mainnet milestone. MetaMask Account 2 (`0.0.10740858`) completed actual sign-in, escrow 7 creation and exact 0.01 NTT allowance in session `d1559164-eaab-488a-8263-8f0a48e619d3`. Native control then timed out. The allowance nevertheless executed successfully at nonce 1; reconcile saved hash `0xbf16a79e41a5ff10c8937ede886dda073a4a177f240260d9cd2d5c82d21be08f`, never resend it. Escrow 7 was unfunded at the independent 07:10:33 UTC snapshot; its deadline is 07:15:57 UTC. The owner was asked to bring the testing window forward. The CLI API proof does not count as this browser gate. Other installed wallet support retains its own verification requirements.

## Invariants

- Never use the old chat-disclosed account key or buyer-env key for candidate server transactions. Server signers remain fresh owner-only files. On 27 September the owner explicitly authorized a newly created disposable MetaMask wallet for testnet UI checks after disclosing its recovery material; treat that wallet as disclosed and testnet-only. Do not copy its recovery material or password into files, logs or documentation, and never give it mainnet assets.
- A server protocol delegate is distinct from the customer's EVM wallet. Bind both to the authenticated session; the wallet explicitly authorizes funding, release or recovery.
- Read real receipt/contract/HCS state before advancing labels. No in-memory escrow or generated success records in the enabled reference path.
- Pin and verify seller identity, network, currency units, amount, recipient, contract bytecode and request/session binding. A signed invoice alone is not delivery or payment proof.
- Do not use upstream automatic release approval. Source inspection found incomplete checks and an apparent recipient error in its ADS-B finalizer; use explicit validated transaction preparation instead.
- Preserve existing public-seller integration claims within their observed legacy scope. Report reference compatibility against the pinned revision and any documented integration corrections.
- Keep requested mainnet work on the roadmap without reopening already completed testnet work merely because mainnet credentials are absent.
- Consolidate results here and in a dated evidence record after implementation. Run additional checks only for a concrete change or defect.
