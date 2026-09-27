# Verification

This record distinguishes the current template checks from earlier live protocol evidence. Public links below are testnet observations and can expire when testnet resets. They are evidence, not default runtime configuration.

## Reproduce the checks

Use Node 22.23.3 from `.nvmrc`, then:

```sh
npm ci --engine-strict
npm run verify
```

The local gate builds and tests the shared package, native contract and frontend, checks types/lint/dependency resolution and audits the npm graph. It needs no wallet, credentials or funded transaction. In `packages/neuron-go`, use Go 1.26.8 for `go test ./...`, `go vet ./...` and the official `govulncheck`. The optional reference bridge has its separate prepared-module checks in [its README](../packages/neuron-reference/README.md#verification).

`npm run test:live` performs read-only directory and mainnet system-account checks. Optional real fixtures use:

- `NEURON_LIVE_SELLER_ACCOUNT_ID` for a selected testnet legacy seller.
- `NEURON_LIVE_HCS_{TOPIC_ID,FINAL_SEQUENCE,PAYER_ACCOUNT_ID,BYTE_LENGTH,SHA256}` for an actual multi-chunk message.
- `NEURON_LIVE_SIGNED_{TOPIC_ID,FINAL_SEQUENCE,PAYER_ACCOUNT_ID,BYTE_LENGTH,SHA256}` for an actual signed message and its current payer key.

Each fixture group is optional; absent groups are explicitly skipped and incomplete groups fail. Multi-chunk messages must exceed 1,024 bytes. Use your own exact final sequence and expected bytes/hash; do not assume the latest message is your fixture.

## Final template gate — 27 September 2026

Clean source **`58d343206cbf63d699efd7a1112cfbe8f52bf7d9`** passed the genuine published Scaffold-HBAR **0.4.0** local-template path, starting from a tracked-source export without dependencies, builds, runtime files or credentials. The published CLI bytes were verified against the npm artifact. This checks actual CLI transformations; anonymous GitHub download remains the public-release gate.

| Check | Result |
| --- | --- |
| Fresh `npm ci --engine-strict`, Node 22.23.3 | Passed; 650 installed packages |
| Production build, generated Next types, typecheck and lint | Passed |
| Shared / Foundry / Next tests | 43 / 8 / 27 passed; one intentional opt-in check skipped |
| Full npm dependency tree and audit | Passed; zero reported vulnerabilities |
| Testnet/mainnet read-only boot and disabled APIs | 34/34 route checks passed, including six page routes per network |
| Default external read-only suite | 2 passed; 3 unconfigured fixture checks explicitly skipped |
| Local Go 1.26.8 adapters | 22 top-level tests and vet passed |
| Fresh reference build | 4 tests and vet passed; binary hash matches the paid-flow binary |
| Go vulnerability scans | Zero reachable-symbol/imported-package findings; one unused module-only `GO-2026-5932` finding in `x/crypto@v0.56.0` |
| Source/history secret review | No actual secrets identified; two scanner matches reviewed as patterned test-session data and a public test key |
| Local documentation links | No missing target files |
| Visual and keyboard review | Desktop, skip-link/navigation and Safari 300% zoom responsive layout passed; exact 375px device emulation was unavailable |

The CLI rewrites npm command strings; `scripts/verify.mjs` uses argument arrays to preserve the verification command. Its automatic default Foundry libraries are CLI behavior and are absent from this template's source. An initial CI runner-context error was corrected at `7c75c83`. [GitHub Actions run 36307481953](https://github.com/Satianurag/neuron-customer-app-scaffold-hbar/actions/runs/36307481953) then passed both Ubuntu 24.04 jobs: clean Node install/verification/standalone staging and Go adapters/reference build/tests/vet. Later evidence-only documentation edits do not change that tested application code.

### Fresh candidate transaction

The HCS writer **from that clean generated project** submitted [transaction `0.0.10725146@1790499070.059923854`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790499070-059923854). Consensus returned **SUCCESS**. An independent official Mirror lookup matched the payer, all **293 bytes**, source commit/tree and [topic sequence 13](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10725147/messages/13).

- Payload SHA-256: `9cf4105a82aa70e43d8423f0191c67b167921911c707aefb2e3befb7076f322b`.
- Consensus timestamp: `1790499083.745312717`.
- Actual fee: **0.00386065 testnet HBAR**, below the 0.1 HBAR ceiling.

This is source-provenance evidence from the submission candidate. The separate payment evidence below proves the earlier unchanged payment implementation.

## Installed MetaMask reference purchase — 27 September 2026

Source **`803eaf7e9482d1dc2d54419ee06c8deb978d613b`**, MetaMask **13.50.0**, Hedera testnet chain **296**. A distinct buyer and seller completed escrow **9**, release **1**, using the pinned reference implementation `13ab01d70ac42531065094a52cd595ef7b6d3223`.

| Action | Official Mirror result |
| --- | --- |
| Create escrow | [Successful transaction](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xebfd9452f3b7a12e650eed679f23800069c96fa1330278542aece2ecfc90dbfb) |
| Exact token allowance | [Successful transaction](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xdf04e7f042046e572e6e0271cfa7449936a53edf0fa181d6b9c5fce9ee6078fb) |
| Deposit | [Successful transaction](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x1b1a7edb6528018a83ed17f6ebe624cdec7890c1a78e1c2f849a8f831f057a8d) |
| Seller release request | [Successful transaction](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xe44e05c4e25e7bbee6c870ff080a206da7eb8266328df118f5841376cf2c9ae0) |
| Buyer payment approval | [Successful transaction](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x90d1a7fff1a60bff4d7aeafccbfcf6ba75a573c36fe2e46cf23633e674ca4be4) |
| Seller withdrawal | [Successful transaction](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x5031eaa0b3a132705b61cf62f9630e46543514d17eea2feb79eb7b3298526196) |

The actual browser downloaded a frozen owner-selected README: **29,099 bytes**, SHA-256 `cf915d1268763dadfabf3dc9902899a41eee852c3be871fcf5738a1001ade413`. The seller received exactly **0.01 NTT** (`10000000000000000` units, 18 decimals); escrow balance and pending total ended at zero. The buyer allowance ended at zero. Buyer fees were **0.41500660 testnet HBAR**; seller fees were **0.20788698 HBAR**.

All six receipts were independently matched through RPC and official Mirror, including sender, calldata and resulting state. Signed HCS envelopes were reassembled and checked for exact bytes, payer and signatures: seller inbox [final sequence 16](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740354/messages/16) through 18, buyer inbox [sequence 10](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740349/messages/10) through [invoice sequence 12](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740349/messages/12). These are genuine template-generated Hedera operations.

Both actual QUIC peers ran on one host. This proves compatibility with that pinned implementation and controlled seller, not remote seller interoperability, a canonical registry or live sensor data. The downloaded README predates this documentation cleanup; its frozen hash is intentional.

## Refund and gas recovery

Separate browser escrow **8** returned the complete **0.01 NTT** after its deadline: [successful refund](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x8b19f38f2ff6a03a0a8383b6520d2605e197d0631a8e374b8ba0be6bb7c79116). The previous [64,563-gas attempt reverted](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x156df324a64ec23e2e1f14468e9863561bc8ae9d0e7bb625d1ed8c73f38429ac); an explicit fresh nonce with 100,000 gas succeeded and left escrow empty. This recovery used a manual gas correction.

The permanent fix uses `ceil(estimate × 1.5) + 10,000`, capped at 400,000 gas and 0.5 HBAR proposed fee, with a pending-balance check before opening the wallet. Eight focused tests, type/lint and production build passed; the later successful browser purchase exercised the fix. Unknown-nonce and failed transaction journals remain preserved outside the template.

The real authenticated API path independently completed paid escrow **6** and timeout-refunded escrow **5** at source `c265128`. Those CLI-wallet API results are distinct from installed-browser proof.

## Other integration evidence

- The candidate HCS writer produced [a committed-source testnet message](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10725147/messages/11), matching its payer, bytes and selected network.
- The legacy gateway delivered real seller bytes over QUIC and remote WSS, with binary preservation, decoded CRC-valid DF17 aircraft frames and stop/reconnect checks. A [real seller request](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790419678-383050168) reached the configured seller; gateway and subscriber byte totals matched.
- The original native-HBAR contract [testnet deployment](https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10730636) passed buyer-approved withdrawal and both timeout refund paths. A separate controlled signed quote funded/refunded through the app API. These do not establish installed-wallet native-HBAR checkout or external seller quote acceptance.

## Release boundaries

| Surface | Status |
| --- | --- |
| Default read-only template and local checks | Passed the clean candidate gate above |
| Pinned reference API and MetaMask paid/refund flows | Passed within the documented scope |
| Other installed wallets / native-HBAR browser checkout | Not yet verified |
| Latest hosted artifact | Deployment/access gate remains; earlier host proof is historical |
| Mainnet service/payment/deployment | Separate [release gate](mainnet.md); no write proof |
| Anonymous external-template command | Requires public repository; current repository is private |

The [official bounty](https://hedera.com/blog/scaffold-hbar-template-bounty/) requires a public MIT repository, clean CLI scaffold, manifest/docs, working Hedera integration and testnet evidence. Its submission form and developer-experience survey are owner submission steps. No submission or publication is implied by local verification.
