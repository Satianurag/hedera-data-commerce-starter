# Sell a maintenance report

This example uses the existing reference document adapter to sell a permitted maintenance report to one authenticated customer. The same path can deliver a public research extract, machine inspection report or licensed dataset. File format does not change the transport or payment protocol: the signed request binds the immutable filename, byte length, SHA-256, seller, customer wallet, exact ERC20 price and deadline. Do not use the shared native ADS-B feed for confidential per-customer files.

This example requires the configured testnet reference adapter and explicit buyer wallet confirmations.

## Prepare the document and identities

1. Create an owner-only directory outside the checkout (`0700`, `umask 077`). Save the following **public synthetic sample**, with its trailing newline, as `maintenance-report.csv` there. It contains no live customer data:

   ```csv
   machine_id,observed_at,temperature_c,vibration_mm_s,assessment
   demo-pump-01,2026-10-01T12:00:00Z,42.1,1.2,inspection-example
   demo-pump-02,2026-10-01T12:00:00Z,40.8,1.1,inspection-example
   ```

2. Record `shasum -a 256 /absolute/private/maintenance-report.csv` and `wc -c /absolute/private/maintenance-report.csv`. Retain the exact bytes. The bridge snapshots and hashes them again; neither a matching extension nor a success label is a content check.
3. Follow [reference setup](../packages/neuron-reference/README.md#prepare-and-configure): a limited HCS operator, separate buyer protocol delegate, separate seller account/key, and an actual buyer wallet. The protocol delegate is not the onchain buyer. Create the two open HCS inboxes with `npm run reference:setup`; save its assigned transaction IDs and `topics.json`. Do not overwrite the state directory to retry an unknown submission.
4. Use a deployed pinned `NeuronEscrow` ERC20 contract and a test token with verified runtime and decimals. The exact upstream source is [`13ab01d…/contracts`](https://github.com/NeuronInnovations/neuron-specs/tree/13ab01d70ac42531065094a52cd595ef7b6d3223/contracts). Its `Deploy.s.sol:DeployEscrow` deploys the escrow and unrestricted **test-only** `TestToken`; it is not this repository's `contract:deploy` command, which deploys native `BuyerEscrow`. Build and review that exact source and its deployment simulation before an operator-authorized testnet deployment. Use an encrypted wallet/keystore to keep raw keys out of command arguments. Retain deployment journals/receipts and obtain each address and runtime hash independently. Bridge startup does not deploy contracts or mint tokens.
5. For the upstream test token, query its `decimals()` and `symbol()` and require `18`/`NTT`. The sample price is `10000000000000000` base units = `0.01 NTT`. The test token's unrestricted `mint(address,uint256)` can provision a limited test buyer balance with explicit operator approval; record that receipt. NTT is an ERC20 test token; it is not HBAR or an HTS token. A different token needs its own runtime, decimal, balance and transfer-behavior review.

The key-format table in [native seller setup](native-seller.md#key-formats) explains raw versus DER. For this reference adapter, `operatorKeyFile` accepts ECDSA DER/raw through the SDK, while buyer/seller protocol files accept raw 32-byte or supported DER hex. Keep the operator, seller and buyer-delegate files distinct. Confirm every public key/address from its actual file before recording configuration.

## Start and buy

Copy the reference `config.example.json` into the private directory and set `sourceFile` to the exact CSV. Fill real numeric account/topic IDs, addresses, runtime Keccak hashes and token metadata. Use `priceBaseUnits: "10000000000000000"`, `refundAfterSeconds: 900` and a small lifetime `maxSessions`. Bind the bridge to loopback and configure its private bearer file, state directory and authenticated Next proxy as described in the reference README. Build the pinned bridge; its `--check` must pass before startup.

Open `/reference` in the configured testnet app and sign in as the customer wallet. In sequence:

1. Create a document session. Compare the displayed signed seller, buyer, filename, byte count, hash, token, exact units and deadline against the inventory.
2. Individually confirm escrow creation, exact token allowance and deposit in the buyer wallet. Wait for verified receipts; allowance or funding alone is not a purchase result.
3. Select **Receive document**. This executes real reference QUIC delivery between the two peers, verifies the received hash and negotiates the release/invoice. Download through the authenticated session and compare both `shasum` and byte length with the source.
4. Approve payment only after reviewing the result, then select **Settle**. Require a successful withdrawal, exact ERC20 `Transfer` to the seller and matching escrow remainder. HBAR pays the network fees; it is not the document price.
5. In a separate explicitly funded session, leave payment unapproved, wait past the deadline, and claim the timeout refund. Require the exact token `Transfer` back to the buyer and the recorded remainder.

Keep original configuration/source bytes, customer SQLite database, bridge state, signed HCS journals and wallet intents across restart. The same wallet can sign in again and rebind its history. An unknown wallet response must be reconciled through the saved nonce/hash; never start a replacement payment by deleting state. See [reference recovery](../packages/neuron-reference/README.md#customer-flow-and-recovery).

## Acceptance checks

| Check       | Required result                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Negotiation | Signed request, response and invoice bind the correct identities, immutable file and exact terms.  |
| Delivery    | The downloaded file matches the source SHA-256 and byte length.                                    |
| Payment     | A successful receipt contains the exact token transfer to the seller and matches escrow state.     |
| Refund      | A separate session returns the remaining deposit to the buyer after the deadline.                  |
| Restart     | The same buyer can recover its history using the retained configuration, journals and source file. |

Both reference peers run on the same host over loopback QUIC. The [native seller](native-seller.md) uses a separate public UDP transport. To use another immutable document, change `sourceFile` in a new configuration/state directory; preserve the original service and state until its outstanding sessions are settled or refunded.
