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
| Browser reference service and payment actions | Passed actual installed MetaMask checkout | Source `803eaf7`; escrow 9/release 1, exact browser download and 0.01 NTT seller withdrawal |
| Distinct identities and actual testnet deployment/configuration | Passed actual preflight | Real topic creation, bytecode, account keys, token metadata and source hash verified |
| Complete paid-delivery path | Passed through authenticated API and installed MetaMask browser | API escrow 6 and browser escrow 9; each delivered the exact 29,099-byte file, paid 0.01 NTT and ended empty |
| Failure/refund path | API and installed-browser timeout recovery passed | API escrow 5 and browser escrow 8 returned 0.01 NTT and emptied; browser refund initially failed from insufficient gas, then succeeded with an explicit fresh nonce and sufficient gas |
| Browser wallet | MetaMask 13.50.0 full reference purchase passed | Disposable Account 2 on chain 296; no proof claimed for other installed wallets or native-HBAR checkout |
| Final candidate checks | Code gate passed at `5bf0dc3`; focused recovery gate passed at `c265128` | Production build, type/lint, 43 shared + 8 contract + 22 Next tests, zero npm audit and zero reachable Go findings; recovery revision also passed five frontend/four Go tests and rebuilt; gas fix `803eaf7` passed eight focused frontend tests, type/lint and production build |
| Hosted update | Access recovery pending | Needs current artifact deployment and HTTPS flow verification; existing OCI artifact is older |
| Mainnet | Separate milestone; not implemented end to end | Network-specific resources, compatible seller binding, provider, bounded cost/transaction manifest, release authorization and pilot |

The current live evidence, including failed attempts, is in [the 27 September record](reference-evidence-2026-09-27.md). Preserve session `1bce886b-a0a7-4ae9-9e08-a74bb0b4a5e2` (escrow 4): its original provider-failed deposit has no recorded nonce/hash, and must not be silently reset. At the independent observation its escrow had no funds and buyer retained all 0.05 NTT.

The complete paid/refund API run used source `c265128348b97fe86bb0ff143345496481a3c15d` and normal challenge/signature authentication with a fresh controlled testnet signer. It delivered the real file, paid the seller, then refunded the separate no-delivery escrow after its ten-minute deadline. Buyer gas including the 0.05 NTT mint totaled **0.86683231 HBAR**, below the **1.2 HBAR** bound. All buyer transactions and both seller settlement transactions were independently matched through RPC and official Mirror. These completed results need no repeat merely to obtain a differently owned seller.

Remaining live gates are the updated hosted deployment and separate mainnet milestone; other installed wallet paths retain their own verification requirements. **The MetaMask reference browser purchase is complete and must not be reopened as pending.** Earlier Account 2 session `d1559164-eaab-488a-8263-8f0a48e619d3` created escrow 7 and approved exactly 0.01 NTT before native control timed out. Its nonce-1 allowance was reconciled without resending, and escrow 7 remained empty after its deadline. Keep this historical outcome and the first account's unknown-nonce intent.

## Restart and browser continuation checkpoint

After the owner closed the applications and requested a restart, the independent **07:29:34 UTC** RPC/Mirror snapshot found Account 2 unchanged: latest/pending nonce **2**, **0.02 NTT**, **0.76215873 HBAR**, and **0.01 NTT** allowance. Escrow 7 was still empty, state `Created`, with its deadline passed. Mirror reported no account transactions since the prior snapshot. Keep this expired session as evidence; it is not a completed purchase or a fresh funding target.

The runtime's four-session cap was exhausted by the preserved browser/API attempts. An audited copy migration at **07:33:15 UTC** raised only `maxSessions` from **4** to **5**, allowing one fresh browser attempt. The active private runtime is now `$HOME/.local/share/neuron-customer-app/reference-2026-09-27/browser-session-five/`, with `bridge-config.json`, `sessions/` and `migration-manifest.json`. The manifest records byte-preserved originals and four copied journals differing only in their configuration fingerprint. Preserve the original runtime and the first account's unknown-nonce intent. This migration did not change transaction history, terms, file bytes or product code, and sent no chain transaction.

The next browser session `02265960-6ffb-4b93-adc4-e6b41f9cd87c` created and funded escrow **8**, delivered and downloaded the exact file, then reached its deadline. The first refund reverted at the wallet's unbuffered 64,563-gas estimate; a read-only comparison reproduced the failure at that limit and succeeded at 100,000. A fresh nonce-6 MetaMask refund with 100,000 gas then returned the complete **0.01 NTT**, independently verified through RPC/Mirror. The failed receipt remains preserved.

Source **`803eaf7`** adds bounded dynamic wallet gas preparation before opening the wallet: `ceil(estimate × 1.5) + 10,000`, maximum 400,000 gas and 0.5 HBAR proposed fee, current balance check, exact saved nonce and calldata, no automatic retry. Eight focused frontend tests, typecheck/lint, independent review and a production build passed. No dependency update or broad compatibility rerun was needed.

A second audited copy raised only `maxSessions` from **5** to **6**, retaining all five original journals, every historical deadline and the 600-second default. **The active runtime is now `browser-session-six/`**, with its own `bridge-config.json`, `sessions/` and `migration-manifest.json`. The same validated bridge binary serves `127.0.0.1:8098`; the updated Next app serves `http://127.0.0.1:3000/reference` under Node 22.23.3 with the existing customer database. Preserve both prior runtime copies. All six bounded proof slots are now consumed; the running instance retains completed/recoverable sessions. A later intentionally requested fresh purchase needs a reviewed cap/configuration change that preserves history, not a state reset.

Final installed-browser session **`1e25e7cd-0d70-4929-b9c5-ea26426f57a4`**, source **`803eaf7`**, completed escrow **9**/release **1**. Actual MetaMask creation, exact allowance and deposit were followed by the real file receive/download, inspection, explicit payment approval and seller withdrawal. The application displays **`paid`**, exactly **0.01 NTT** paid, escrow empty. Withdrawal hash: `0x5031eaa0b3a132705b61cf62f9630e46543514d17eea2feb79eb7b3298526196`. Temporary native window-control failures were recovered through the same browser and saved hashes; no API signing shortcut or history reset was used. [Dated evidence](reference-evidence-2026-09-27.md) records independent checks and costs. Do not create further purchases just to repeat this completed result.

Use [the portable restart instructions](../packages/neuron-reference/README.md#restart-the-configured-local-service) for later restarts. The existing OCI hosted artifact is older; its missing SSH access and expired CLI session remain an access-recovery gate. Mainnet needs its own signer, resources, provider and bounded release authorization.

## Invariants

- Never use the old chat-disclosed account key or buyer-env key for candidate server transactions. Server signers remain fresh owner-only files. On 27 September the owner explicitly authorized a newly created disposable MetaMask wallet for testnet UI checks after disclosing its recovery material; treat that wallet as disclosed and testnet-only. Do not copy its recovery material or password into files, logs or documentation, and never give it mainnet assets.
- A server protocol delegate is distinct from the customer's EVM wallet. Bind both to the authenticated session; the wallet explicitly authorizes funding, release or recovery.
- Read real receipt/contract/HCS state before advancing labels. No in-memory escrow or generated success records in the enabled reference path.
- Pin and verify seller identity, network, currency units, amount, recipient, contract bytecode and request/session binding. A signed invoice alone is not delivery or payment proof.
- Do not use upstream automatic release approval. Source inspection found incomplete checks and an apparent recipient error in its ADS-B finalizer; use explicit validated transaction preparation instead.
- Preserve existing public-seller integration claims within their observed legacy scope. Report reference compatibility against the pinned revision and any documented integration corrections.
- Keep requested mainnet work on the roadmap without reopening already completed testnet work merely because mainnet credentials are absent.
- Consolidate results here and in a dated evidence record after implementation. Run additional checks only for a concrete change or defect.
