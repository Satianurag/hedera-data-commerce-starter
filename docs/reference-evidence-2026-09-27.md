# Reference integration evidence — 27 September 2026

This records the new reference document service separately from historical legacy aviation streaming and the starter-specific native-HBAR escrow. Real paid delivery and timeout refund passed through the authenticated application API. Installed-browser full checkout remains pending; unlisted outcomes have not passed.

## Source and runtime

- Reference source: `NeuronInnovations/neuron-specs@13ab01d70ac42531065094a52cd595ef7b6d3223`, rechecked on 27 September. The original wrapper is in `packages/neuron-reference`; it imports original upstream Go components in an external pinned checkout.
- Node default: `22.23.3`, supported Node 22 LTS; existing mutually compatible package lock retained. No forced major dependency update. The reference Go build selects `1.26.8` and records dependency patches in build provenance.
- Repository `Satianurag/neuron-customer-app-scaffold-hbar` was independently read as `PRIVATE` during this run. No publication was performed.
- A frozen copy of the project's README is the real file being offered: **29,099 bytes**, SHA-256 `cf915d1268763dadfabf3dc9902899a41eee852c3be871fcf5738a1001ade413`. It is a document, not sensor data. Both actual QUIC peers run on the local host.

## Testnet resources

The setup command durably recorded transaction IDs before sending and reconciled official Mirror results. The SDK receipt lookup returned `UNKNOWN`; Mirror independently confirmed `SUCCESS`. A read-only rerun reused the same resources.

| Resource | ID | Transaction |
| --- | --- | --- |
| Buyer protocol inbox | `0.0.10740349` | [`0.0.10725146@1790489627.985170583`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790489627-985170583) |
| Seller inbox | `0.0.10740354` | [`0.0.10725146@1790489634.739818059`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790489634-739818059) |

Each topic cost 25,631,823 tinybar, totaling **0.51263646 testnet HBAR**. Topics are open, have no custom fees, and their admin keys match the fresh operator. Private runtime state and keys stay outside the repository.

Previously deployed reference contracts were rechecked against compiled runtime bytes on chain **296**:

| Contract | Address | Runtime Keccak-256 |
| --- | --- | --- |
| Upstream NeuronEscrow `0.0.10709683` | `0x4b6f531464782fc92df193c06811d1b930c20460` | `0x6fde0350e725af80a8ed48591c9bb8442bc44593577df6ef555c037eb30fa27e` |
| Neuron Test Token `0.0.10709685` | `0x31f5a82bbc6f79d9846612f29bef3d7fcbbf610d` | `0xeabc65215107582d1275faaf907a8fdd0348dc981562d62d511c784dee9811bd` |

NTT has 18 decimals. This service is priced at `10000000000000000` token base units (**0.01 NTT**). HBAR pays network fees only.

## Installed browser wallet

The owner created a disposable wallet in the isolated **Google Chrome for Testing 151.0.7922.34** profile with official **MetaMask 13.50.0**. Its public address is `0xa2657414d8B7a73b48EA1CA30B1458a14cB18DF8`. Its recovery material was disclosed by the owner and must never be stored here or used for mainnet.

Hedera testnet was added using chain **296**, `https://testnet.hashio.io/api`, and symbol HBAR, matching [Hedera's current setup documentation](https://docs.tokenization-studio.hedera.com/ats/getting-started/quick-start/). The installed extension connected to `http://127.0.0.1:3000` and displayed the exact wallet, origin, chain, nonce and five-minute expiry in its signature dialog. The operator approved the sign-in signature through the actual wallet UI. The app displayed the same signed-in address and an active owner-bound SQLite session; no payment was authorized by this message.

The first challenge attempt returned 503 because the local `better-sqlite3` native binding was absent. `npm rebuild better-sqlite3` under Node 22.23.3 installed the matching official prebuild; the subsequent challenge, signature and verification succeeded. This was an installation defect, not a wallet protocol failure.

## Final code checks

Under Node **22.23.3**, the consolidated production build and test command passed **43 shared tests, eight Foundry tests and 22 Next tests**, with one intentional opt-in test skipped. Typecheck, lint and the complete npm dependency tree passed; npm audit reported **zero vulnerabilities**. Logs are retained outside the repository. Turbopack emitted a nonfatal file-tracing warning for the workspace path boundary calculation; no dependency or build failure occurred.

The pinned bridge built successfully, its two focused tests and `go vet` passed, and `govulncheck` found **zero reachable or imported-package vulnerabilities**. One finding exists in an unused required module. The built binary SHA-256 is `2e7cfa3902b8363dbfd46868c0fe4e301174aa1eb7f3fa3e083b5f5dc0a3d327`. Read-only startup preflight verified chain, deployed bytecode, account keys, seller alias, topic metadata, token metadata and source hash against the actual configured testnet resources.

## First installed-wallet attempt and recovery finding

Product source was committed as `5bf0dc3`. The first real browser session was `1bce886b-a0a7-4ae9-9e08-a74bb0b4a5e2`:

- Signed request: seller inbox `0.0.10740354`, final sequence **2**, transaction `0.0.10725146@1790490482.754784782` (two chunks).
- Signed acceptance: buyer inbox `0.0.10740349`, sequence **1**, transaction `0.0.10725146@1790490488.222607536`.
- Actual wallet-created upstream escrow **4**: `0x93c1d2ae8ea1541c3ba78136cc4c55eef5cf5bcd1fda191ee9caaeaa6fd1037e`, independently successful through RPC and Mirror.
- Actual wallet-approved allowance exactly **0.01 NTT**: `0x3b84497039284042ba746802e57f3dc4940667aa0dd76583ac819e1da2f855af`, independently successful through RPC and Mirror.
- Deposit failed in MetaMask without returning a hash. The app retained `wallet-open` and did not automatically resend. Independent observation found latest/pending account nonce **2**, no confirmed deposit, escrow balance **0**, buyer **0.05 NTT**, seller **0 NTT**, and exact allowance **0.01 NTT**. MetaMask's failure detail subsequently displayed: `RPC 0x128 Custom eth_sendRawTransaction: RPC endpoint returned HTTP client error.` The exact HTTP status/root cause was not exposed; a later read-only estimate of the same deposit succeeded. Do not attribute it to insufficient funds without evidence.

This revealed a real recovery gap: a provider failure without a hash left the intent blocked, and a plain-object provider error lost its useful message in the UI. The follow-up fix records the exact nonce before wallet opening and prepares explicit retries of that same nonce and calldata. Its focused checks and subsequent API commerce pass are recorded below. The original nonce-unknown journal is preserved; it is not silently cleared or retroactively marked verified.

The recovery fix is committed as `c265128348b97fe86bb0ff143345496481a3c15d`. It passed five focused frontend tests, typecheck/lint, a new production build, four focused Go tests, vet and independent static review. Refused wallet openings return HTTP 409 before a provider call; rejecting a retry cannot discard an earlier uncertain submission. A wallet with an old unknown-nonce intent is blocked from new reference purchases until that historical operation is reconciled. The new bridge binary SHA-256 is `4fdf5aa76ba5fffd06076961e31ae05a103bcec19b411cd9d6822483d460de59`.

Native browser controls subsequently became unavailable (window/capture failures). At the owner's request the isolated testing window was closed and reopened; the actual project page rendered again. MetaMask then required unlocking. The owner reported completing the requested second account creation for the remaining browser checkout, preserving the first account's unresolved historical intent. Native UI input still reported window-availability failures; creation of Account 2 is not a completed checkout. Actual app API paid/refund checks used the existing controlled testnet buyer `0.0.10725511`, whose private key had not been disclosed, with normal challenge/signature authentication. This is real API/chain evidence, **not** installed-browser checkout proof. It did not use or derive the disclosed wallet recovery material.

The disposable wallet became Hedera account **0.0.10740507**. Initial funding was **0.5 testnet HBAR** and **0.05 NTT**, with separately verified transfer/mint receipts. A later native SDK top-up added **1.0 testnet HBAR** through [`0.0.10725146@1790490961.919637309`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790490961-919637309), costing **0.00128158 HBAR**. The initial EVM alias-creation transfer cost **0.66256413 HBAR**; mint cost **0.05592136 HBAR**. All are testnet units.

## Actual authenticated API paid-delivery result

Product source `c265128348b97fe86bb0ff143345496481a3c15d` completed the real paid path through the Next application HTTP API with normal wallet challenge/signature authentication. The controlled buyer was `0x13E42Bbd9fD9bB9e46914423BDdbdA9f7C44aC79` (`0.0.10725511`), distinct from seller `0x3938c6c903271Ee751726e7Aae07185E79C2BA2D` (`0.0.10725524`). The CLI client checked exact chain, nonce, target and calldata before each signature; it did not use the installed MetaMask wallet.

Session `e6bb8e00-0f7d-4082-9d7c-af744cd230c4` used escrow **6**, release **1**, at **0.01 NTT**. Signed request and acceptance, original encrypted connection setup and actual QUIC file delivery completed. The authenticated app file download returned **29,099 bytes**, SHA-256 `cf915d1268763dadfabf3dc9902899a41eee852c3be871fcf5738a1001ade413`, exactly matching the frozen source. Both P2P peers ran on this host; this demonstrates the pinned reference implementation with our operated seller.

The [seller-signed invoice](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740349/messages/5) is buyer inbox sequence **5**, transaction `0.0.10725146@1790491987.484252490`, exact envelope SHA-256 `241d2a22380714d7861ccab6516d9a017fab7a4edaa7b4bfa984a10d1793fcc7`. Its eight payload fields match the pinned reference format; `releaseRequestRef` points to the checked onchain release, whose evidence hash is `0xfaaa07e7419920a7d0e88ec3dbf67169d7fb02594f11e5ce22a525a6bffb8777`. No invoice `evidenceHash` field was invented.

| Operation | Testnet transaction |
| --- | --- |
| Create escrow 6 | `0x8a253e3d50a69b14556c2406bd8e16a462e6bf8b0371eed7f7b7aeb6a336cf04` |
| Exact token allowance | `0x1ae7f2162e8520b9fde9549b9bfc7d5c611fca597a5883c723249f8caa55c42f` |
| Deposit | `0x1b0041bcf58f4c0973e11783ebf15d0ec9dba48bf0c6c65787ec51284257a868` |
| Seller request release | `0x83efd55dd048574dff110919dd18cd4b78dfc2532420cef7060f03a1a245128e` |
| Explicit buyer approval | `0x01eeef3e3a9ae71aab45a3865511d0f2784c492456f423e53a31f7cf4fb48221` |
| Seller withdrawal | `0xd10fa014b607a72f5c1a4cc45b13a57eaab755e68b8f312569143d7b683d230a` |

Buyer transaction receipts matched RPC and official Mirror `SUCCESS`. The independently read seller token balance increased from **0** to **10,000,000,000,000,000 base units**, exactly **0.01 NTT**. Escrow 6 ended with balance **0**, escrow state **2** (released), and release 1 state **2** (withdrawn). Escrow 5 held a separate refund test's funds until the timeout result below.

An independent final read also checked both seller transactions against RPC and official Mirror:

| Seller operation | Mirror transaction | Charged fee |
| --- | --- | --- |
| Request release | [`0.0.7314364-1790491984-674104916`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7314364-1790491984-674104916) | 0.14221993 HBAR |
| Withdraw | [`0.0.7314364-1790492029-785679395`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7314364-1790492029-785679395) | 0.08720654 HBAR |

Both were `SUCCESS`, signed by the configured seller on chain 296 and addressed to the checked NeuronEscrow. The withdrawal receipt contained the exact ERC20 `Transfer` from escrow to seller and `Withdrawn(6, 1, seller, 10000000000000000)`. The release's recipient, amount and evidence hash matched the delivered session.

## Actual authenticated API timeout-refund result

The same committed source and controlled buyer created a separate session `10d0c195-dea3-45d8-b299-1bc6f46e3c4b`, escrow **5**, with **0.01 NTT**. This session was funded first so its genuine ten-minute timeout could run while the paid session completed. No delivery or release was requested for escrow 5.

| Operation | Testnet transaction |
| --- | --- |
| Create escrow 5 | `0x2cc08263ac313ca7e8e28b39f1e0f4cc96364cf7a3884a4b8f059f4e945757b3` |
| Exact token allowance | `0xea85240dddef3b316a6d53a5232d8c3d768c38fc56554b49402cf3c02faad15d` |
| Deposit | `0xa605d17af5a1d7f12e335f0ae213a44c07739ce0d5959d32e50dacb74533ce9e` |
| Buyer refund | [`0x3a26f84155cc22f52c31769e4c1e9cb70dfd91b57b39a19dcfa9a48743a319e2`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3a26f84155cc22f52c31769e4c1e9cb70dfd91b57b39a19dcfa9a48743a319e2) |

All four transactions had matching successful RPC receipts and official Mirror results. The deadline was Unix **1790492440**; refund consensus was **1790492463.577922418**, after that deadline. [Mirror transaction `0.0.7314364-1790492458-029863216`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7314364-1790492458-029863216) charged **0.05673668 testnet HBAR**. The receipt's token transfer and `RefundClaimed` event returned exactly **10,000,000,000,000,000 base units** to the buyer. The buyer's independently read token balance increased by **0.01 NTT**, the seller's did not change, and escrow 5 ended with balance **0**, state **3** (refunded).

## Bounded run and evidence retention

The authenticated API run lasted **06:50:24–07:01:18 UTC on 27 September 2026**, including the real timeout. It minted **0.05 NTT** to the controlled buyer and used two purchases of **0.01 NTT** each. Final token balances were buyer **0.04 NTT**, seller **0.01 NTT**, and escrow contract **0 NTT**. Buyer network fees, including the mint and eight purchase/refund transactions, totaled **0.86683231 HBAR**, below the authorized **1.2 HBAR** aggregate bound. Seller fees and HCS operator fees are separate; this figure is not the entire setup cost.

Every buyer transaction's exact nonce, chain, recipient, value and calldata was checked, and its signed hash was journaled before broadcast. No replacement transaction with a fresh nonce was automatically sent. An initial read-only preflight hit a Hashio upstream Mirror 504; one preflight retry succeeded before authentication or any write.

Sanitized `public-evidence.json` and `seller-settlement-independent.json` are retained in the owner-only `reference-2026-09-27/api-proof` runtime directory outside the repository. They contain transaction receipts, public session messages, source revision, file hash and balance observations. The separate private recovery journal contains the authentication cookie and signed transactions and must not be copied into the repository. Keys and recovery material are absent from the sanitized evidence.

## Second installed-wallet attempt

After the owner created Account 2, selecting the testing window from Chrome's **Window** menu temporarily restored native UI input. The actual MetaMask receive screen showed `0x064675a68904419BC596a9Fd912E99c898Fa8852` on Hedera testnet. Native funding created account **0.0.10740858**: **1.0 testnet HBAR** through `0.0.10725146@1790492720.114040425`, fee **0.00128158 HBAR**. Mint transaction `0xdf2afe1fecbd2ba9ed39f05eee04cc7d0cc31825fdfcce178f594ef8c97b70f6` credited **0.02 NTT**, fee **0.05592136 HBAR**. Both were independently successful through Mirror.

The previous app login was signed out through `/sessions`. An initial new login prompt still named Account 1 and was rejected. Account 2 was then connected to the local site; its actual MetaMask sign-in message matched its full address, origin `http://127.0.0.1:3000`, chain **296** and fresh nonce. The app displayed the correct authenticated Account 2.

Session `d1559164-eaab-488a-8263-8f0a48e619d3` agreed a **0.01 NTT** purchase with deadline **1790493357** (07:15:57 UTC). Its signed request is seller inbox final sequence **11**, transaction `0.0.10725146@1790492746.617258233`; acceptance is buyer inbox sequence **6**, transaction `0.0.10725146@1790492751.973787716`.

- Actual MetaMask escrow creation, nonce **0**: `0x50ffd67c15a0e30ab2e49b0711f81dea2a13a688a49bd0c5fc6a29141d133c83`; app reconciliation confirmed escrow **7**.
- Actual MetaMask exact **0.01 NTT** allowance, nonce **1**: `0xbf16a79e41a5ff10c8937ede886dda073a4a177f240260d9cd2d5c82d21be08f`. Native UI control returned a window error after the confirmation click and then timed out. Independent RPC and [Mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7314364-1790492879-773798501) nevertheless confirmed **SUCCESS**. The app retained the submitted hash and exact nonce; do not resend this allowance.

At **07:10:33 UTC**, Account 2's latest/pending nonce was **2**, token balance **0.02 NTT**, HBAR balance **0.76215873**, and allowance **0.01 NTT**. Escrow 7 had **zero deposited funds**. Native control continued timing out after a tool reset; the owner was asked only to bring the main testing window forward. The saved allowance must be reconciled before a deposit is considered. These observations establish another installed-wallet sign-in/create/allowance result, not a completed browser purchase. The independent snapshot is retained outside the repo as `api-proof/browser-independent.json`.

## Completion gates

- Installed MetaMask testnet connection and signature: **passed**.
- Real document delivery, invoice, payment and seller token receipt: **passed through the authenticated app API**; installed-wallet full checkout is separate and pending.
- Independently funded buyer timeout refund: **passed through the authenticated app API**, after the real deadline, with exact buyer return and zero remaining escrow balance.
- Final consolidated candidate code checks: **passed** as detailed above; live commerce remains a separate gate.
- Updated hosted deployment, other installed wallets and mainnet writes: **not established by this run**.
