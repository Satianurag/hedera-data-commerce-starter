# Reference integration evidence — 27 September 2026

This records the new reference document service separately from historical legacy aviation streaming and the starter-specific native-HBAR escrow. Work is in progress; unlisted commerce outcomes have not passed.

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

This revealed a real recovery gap: a provider failure without a hash left the intent blocked, and a plain-object provider error lost its useful message in the UI. The follow-up fix records the exact nonce before wallet opening and prepares explicit retries of that same nonce and calldata. It must be checked before a new commerce pass. The original nonce-unknown journal is preserved; it is not silently cleared or retroactively marked verified.

The disposable wallet became Hedera account **0.0.10740507**. Initial funding was **0.5 testnet HBAR** and **0.05 NTT**, with separately verified transfer/mint receipts. A later native SDK top-up added **1.0 testnet HBAR** through [`0.0.10725146@1790490961.919637309`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790490961-919637309), costing **0.00128158 HBAR**. The initial EVM alias-creation transfer cost **0.66256413 HBAR**; mint cost **0.05592136 HBAR**. All are testnet units.

## Completion gates

- Installed MetaMask testnet connection and signature: **passed**.
- Real document delivery, invoice, payment and seller token receipt: **pending**.
- Independently funded buyer timeout refund: **pending**.
- Final consolidated candidate code checks: **passed** as detailed above; live commerce remains a separate gate.
- Updated hosted deployment, other installed wallets and mainnet writes: **not established by this run**.
