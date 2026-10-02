# Verification

How to check this template yourself, and the testnet records that show each Hedera integration working. Testnet links can expire when testnet is reset; they are evidence, not runtime configuration.

## Local checks

Use Node 22.23.3 from `.nvmrc` (Node 20.18.3 or later is supported):

```sh
npm ci --engine-strict
npm run verify
```

`verify` runs, in order:

| Step | Covers |
| --- | --- |
| `npm run test` | Shared package unit tests, Foundry unit, fuzz and invariant tests, Next.js route and API tests |
| `npm run typecheck` | Shared package and app TypeScript, including generated Next.js route types |
| `npm run lint` | ESLint over app routes, libraries, scripts and tests |
| Dependency tree | Fails on missing, invalid or extraneous packages (output is suppressed unless it fails) |
| Security audit | Fails on any reported vulnerability |

None of these needs a wallet, credentials or a funded transaction.

Other checks:

| Command | Covers |
| --- | --- |
| `npm run test:e2e` | Deterministic Playwright checks against production Next.js: desktop/mobile navigation, exact signed HCS fixture bytes and payer key, independent failure/empty/tampering cases, small-screen layout and disabled writes; simulated-wallet browser authentication against real signatures and disposable SQLite |
| `npm run check:scaffold-text` | Every tracked text file survives, unchanged, the text rewrite the Scaffold-HBAR CLI applies for npm |
| `npm run check:scaffold` | The bounty gate: scaffolds this checkout with the published CLI, confirms no template file changed, then runs a fresh install, lint and build, boots the production server and requests the core routes. Add `-- --remote` to scaffold from GitHub instead |
| `npm run test:live` | Read-only checks against the live directory and Mirror Node |
| `go test ./... && go vet ./...` in `packages/neuron-go` | Go 1.26.8 HCS writer and legacy gateway |

The optional reference bridge has separate checks in [its README](../packages/neuron-reference/README.md#verification). CI runs all of the above except `test:live` on every pull request.

### Browser test boundaries

Build first with `npm run build` and install Chromium with `npx playwright install chromium`. The default `npm run test:e2e` starts its own production servers on ports 3210 and 3211 (override `E2E_PORT` to change the first port). It refuses to reuse an existing server. A test-only Node preload supplies deterministic Mirror/directory responses to the **server-side** fetches; Playwright browser routing alone cannot intercept Server Component reads. Unknown external requests fail closed. The success test requires the exact topic, payer, sequence, length, SHA-256 and verified payer key, with no alert. The separate outage test requires an alert and no message evidence. Neither an error nor an empty topic counts as success.

To prove the success assertion cannot pass an outage, run the negative mutation check. This command **must fail** the HCS success test:

```sh
E2E_FORCE_MIRROR_OUTAGE=1 npm run test:e2e -- --grep 'verifies exact HCS bytes' --project=desktop
```

The `wallet-simulation` project uses an in-browser EIP-1193/EIP-6963 provider with random, real EVM signatures, real HTTP authentication and a disposable owner-only SQLite journal. It checks explicit provider selection, rejection, chain mismatch, events during signing, account/chain/disconnect invalidation, provider conflicts, origin/Host rejection, challenge replay and logout. It does **not** prove an installed wallet, WalletConnect relay or on-chain payment works. Those require separately recorded live tests.

For an independent, read-only **live browser** check, provide a known latest message on a dedicated topic:

```sh
E2E_LIVE=1 \
E2E_HCS_TOPIC_ID=0.0.REPLACE_TOPIC \
E2E_HCS_PAYER_ACCOUNT_ID=0.0.REPLACE_PAYER \
E2E_HCS_FINAL_SEQUENCE=REPLACE_SEQUENCE \
E2E_HCS_BYTE_LENGTH=REPLACE_LENGTH \
E2E_HCS_SHA256=REPLACE_SHA256 \
E2E_HCS_REQUIRE_SIGNED=1 \
npm run test:e2e
```

Live mode has no fixture preload or browser route mocks, runs both desktop and mobile, and fails rather than skipping missing fixture inputs. Record expected values independently from the submission receipt and original payload; do not derive expectations from the rendered page. `E2E_HCS_REQUIRE_SIGNED=1` additionally requires the recovered signer to match the current HCS payer key. The viewer reads the **latest** message, so later submissions intentionally invalidate an old fixture expectation. `E2E_BASE_URL` is accepted only in live mode for checking an already-running deployment; its revision and configuration are the operator's responsibility.

### Live fixtures

`npm run test:live` performs read-only directory and mainnet system-account checks. Optional fixtures:

- `NEURON_LIVE_SELLER_ACCOUNT_ID` for a selected testnet legacy seller.
- `NEURON_LIVE_HCS_{TOPIC_ID,FINAL_SEQUENCE,PAYER_ACCOUNT_ID,BYTE_LENGTH,SHA256}` for a real multi-chunk message.
- `NEURON_LIVE_SIGNED_{TOPIC_ID,FINAL_SEQUENCE,PAYER_ACCOUNT_ID,BYTE_LENGTH,SHA256}` for a real signed message and its payer's current key.

Each group is optional. Missing groups are skipped; incomplete groups fail. Multi-chunk messages must exceed 1,024 bytes. Use your own final sequence and expected hash; the latest message on a topic is not necessarily your fixture.

## Testnet evidence

### HCS message from a freshly scaffolded project

`npm run hcs:submit`, run inside a project generated by the Scaffold-HBAR CLI, submitted [transaction `0.0.10725146@1790499070.059923854`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790499070-059923854). Consensus returned **SUCCESS**, and the Mirror Node record matched the payer and all **293 bytes** at [topic 0.0.10725147, sequence 13](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10725147/messages/13).

- Payload SHA-256: `9cf4105a82aa70e43d8423f0191c67b167921911c707aefb2e3befb7076f322b`
- Consensus timestamp: `1790499083.745312717`
- Fee: **0.00386065 testnet HBAR**, under the 0.1 HBAR cap

This is historical live evidence. Default browser tests use clearly labeled deterministic fixtures; the separate live browser mode can check this message only while it remains the topic's latest message.

### Paid document purchase in MetaMask

MetaMask on Hedera testnet (chain 296) completed a purchase through the reference adapter, pinned to `NeuronInnovations/neuron-specs@13ab01d70ac42531065094a52cd595ef7b6d3223`, with a separate buyer and seller.

| Action | Mirror Node record |
| --- | --- |
| Create escrow | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xebfd9452f3b7a12e650eed679f23800069c96fa1330278542aece2ecfc90dbfb) |
| Exact token allowance | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xdf04e7f042046e572e6e0271cfa7449936a53edf0fa181d6b9c5fce9ee6078fb) |
| Deposit | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x1b1a7edb6528018a83ed17f6ebe624cdec7890c1a78e1c2f849a8f831f057a8d) |
| Seller release request | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xe44e05c4e25e7bbee6c870ff080a206da7eb8266328df118f5841376cf2c9ae0) |
| Buyer payment approval | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x90d1a7fff1a60bff4d7aeafccbfcf6ba75a573c36fe2e46cf23633e674ca4be4) |
| Seller withdrawal | [Contract result](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x5031eaa0b3a132705b61cf62f9630e46543514d17eea2feb79eb7b3298526196) |

The browser downloaded a **29,099-byte** file (SHA-256 `cf915d1268763dadfabf3dc9902899a41eee852c3be871fcf5738a1001ade413`). The seller received exactly **0.01 NTT** (`10000000000000000` base units, 18 decimals), and the escrow balance and buyer allowance both ended at zero. The signed HCS negotiation is on the seller inbox, [sequences 16](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740354/messages/16)–18, and the buyer inbox, [sequence 10](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740349/messages/10) to the [invoice at sequence 12](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10740349/messages/12).

Both P2P peers ran on one host. This shows compatibility with the pinned implementation and a controlled seller, not with every remote Neuron seller.

### Timeout refund

A separate escrow returned the full **0.01 NTT** after its deadline: [refund](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x8b19f38f2ff6a03a0a8383b6520d2605e197d0631a8e374b8ba0be6bb7c79116). An earlier attempt with a 64,563 gas limit [reverted](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x156df324a64ec23e2e1f14468e9863561bc8ae9d0e7bb625d1ed8c73f38429ac). The app now sets gas to `ceil(estimate × 1.5) + 10,000`, capped at 400,000 gas and a 0.5 HBAR fee, and checks the pending balance before opening the wallet. The purchase above used that rule.

### Native-HBAR escrow and legacy stream

- `BuyerEscrow` is [deployed on testnet](https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10730636). Buyer-approved withdrawal and both timeout refund paths were exercised there. See the [contract guide](contracts.md).
- The legacy gateway delivered real seller bytes over QUIC and WSS, with CRC-valid DF17 aircraft frames and stop/reconnect handling. A [seller request](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790419678-383050168) reached the configured seller, and gateway and subscriber byte counts matched.

## Recovery verification — 2 October 2026

These are fresh testnet transactions from the recovery fixes. The buyer used a disposable scripted ECDSA wallet against the production API or reference bridge. They are separate from the earlier installed-MetaMask runs and from the simulated-provider browser tests.

| Recovery path | Observed result and public evidence |
| --- | --- |
| Failed native funding | An expired quote [reverted](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x68d750d0dedd7b17627e6496931907b2f096ff048bc4f41ec865d2d8bed9b575). The app proved expiry and unused terms, retained the failed hash, and a new authenticated session [funded escrow 7](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x6385d9b74163566fdeed0169e52b3a226195b185a53e9a4914a924236e909c0b). |
| Native refund recovery | Two wallet openings without broadcast remained retryable. A deliberately insufficient-gas [refund failed](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xb8126e5e3b82d03fd2f71984bd5bf9d77b0092984465f7323a6f0d77fcbc0a1e); the app then [refunded exactly 0.01 HBAR](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x270cbf3c930a48a7c04fa0f394d5f8fac312d3297e9631ff5f6ddb8dff9982e6). Further retry was refused. Restart retained all six funding/refund openings; another buyer received 404 and a cross-origin write received 403. |
| Native approval nonce cancellation | With explicitly controlled request/HCS/transport prerequisites, production approval recovery handled a mined self-cancellation and [approved at a new nonce](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x32b71590d3c5791fc0773c65d9e57b0869e18f61a6da2b6c449ae06f15e6800e). The seller [received exactly 0.001 HBAR](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3899de2638a85e0027c3f7c206c5d12bd27b8ccdb6cdf1cccf6957bbba7c8ddb). This mixes fixture prerequisites with real settlement; it is not a complete canonical-directory seller flow. |
| Reference shared allowance and surplus | Two purchases recovered after the first consumed their shared allowance. Real HCS negotiation and an 80-byte libp2p transfer completed despite one extra token base unit. Escrow 12 [paid exactly 1,000,000 base units](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xde615791fb6c8072765a8ea53f754002dea496a0dc6b0bf44d1097fafd5024d6), then [refunded the remaining 1](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3719b81532a4c5d9e8731e2126449239f997f6c89df217da75a4129ed872a5a0). Unpaid escrow 13 [refunded 1,000,001](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3c2a2ecd650c2cbdf9396ae25f5e475a167dc21e436e4f2e8d37d8d1d9871346). Both balances ended at zero after the real 600-second deadline. |
| Reference restart and migration | A bridge restart with deliberately lost confirmation markers reconciled original live HCS bytes and transaction IDs. A disposable copy of a genuine version-1 paid journal migrated with its six signed messages and transaction history intact; the original journal was untouched. Local child-process crash tests separately cover a killed writer. |
| Strict live HCS browser check | Desktop and mobile verified a freshly submitted, signed two-chunk message ending at [topic 0.0.10823693 sequence 19](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10823693/messages/19): 1,093 bytes, SHA-256 `d4154e8624069de14788549bb4c7cafec347e575c88f00fc3ab5a40c006228d9`, payer `0.0.10706215`, recovered signer matching that payer. A forced outage fails the success assertion. |

The local browser suite also checks provider/account/network changes, origin replay, durable opening references, manual hash recovery and stale responses. Simulated wallet tests do not establish installed-wallet or chain compatibility. Official Mirror receipts, payout actions and resulting escrow state were independently checked for the live payment results above.

## Not yet verified

| Surface | Status |
| --- | --- |
| Wallets other than MetaMask | Not tested |
| Full native canonical-directory → request → transport → approval browser flow | Funding/refund were exercised with MetaMask during the audit; recovery fixes have scripted live-chain and simulated-browser evidence. The complete canonical seller flow still requires a controlled registered seller with reachable transport |
| Remote third-party Neuron sellers | Not tested; the reference flow used a controlled seller |
| Mainnet writes | Not supported; see [mainnet requirements](mainnet.md) |
