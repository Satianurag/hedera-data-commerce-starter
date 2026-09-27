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
| Reference source preparation and server bridge | In progress | Reproducible pinned source; real HCS, signed negotiation, real escrow, original file-delivery primitives, durable recovery |
| Browser reference service and payment actions | In progress | Reuse current customer authentication and wallet boundary; explicit wallet approval of exact ERC20 transactions; owner-bound state |
| Distinct identities and actual testnet deployment/configuration | Preflight in progress | Undisclosed owner-only signer files, matching public keys; real contract bytecode, token metadata and topic metadata |
| Complete paid-delivery path | Pending implementation | Signed terms, funded escrow, exact delivered bytes, explicit buyer approval, actual seller receipt and independently reconciled transaction |
| Failure/refund path | Pending implementation | Timeout with no release returns the actual escrow balance to the buyer |
| Browser wallet | Implemented adapters; handshake still unverified | One actual disposable supported wallet connects, signs and sends the bounded testnet actions |
| Final candidate checks | Pending source freeze | Build/lint/typecheck, relevant regression/security checks and complete paid/refund flows on one frozen revision |
| Hosted update | Access recovery pending | Current artifact deployed and HTTPS flow verified; existing OCI artifact is older |
| Mainnet | Separate milestone; not implemented end to end | Network-specific resources, compatible seller binding, provider, bounded cost/transaction manifest, release authorization and pilot |

## Invariants

- Never use the old chat-disclosed account key or buyer-env key for candidate server transactions. Server signers remain fresh owner-only files. On 27 September the owner explicitly authorized a newly created disposable MetaMask wallet for testnet UI checks after disclosing its recovery material; treat that wallet as disclosed and testnet-only. Do not copy its recovery material or password into files, logs or documentation, and never give it mainnet assets.
- A server protocol delegate is distinct from the customer's EVM wallet. Bind both to the authenticated session; the wallet explicitly authorizes funding, release or recovery.
- Read real receipt/contract/HCS state before advancing labels. No in-memory escrow or generated success records in the enabled reference path.
- Pin and verify seller identity, network, currency units, amount, recipient, contract bytecode and request/session binding. A signed invoice alone is not delivery or payment proof.
- Do not use upstream automatic release approval. Source inspection found incomplete checks and an apparent recipient error in its ADS-B finalizer; use explicit validated transaction preparation instead.
- Preserve existing public-seller integration claims within their observed legacy scope. Report reference compatibility against the pinned revision and any documented integration corrections.
- Keep requested mainnet work on the roadmap without reopening already completed testnet work merely because mainnet credentials are absent.
- Consolidate results here and in a dated evidence record after implementation. Run additional checks only for a concrete change or defect.
