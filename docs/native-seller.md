# Operate a native-HBAR seller

This optional testnet integration runs a seller you control. It uses real Hedera accounts, HCS messages, QUIC data and `BuyerEscrow` transactions. The operator supplies an explicit seller profile; the seller does not need to appear in the hosted aviation directory. Default directory discovery remains a separate integration.

The seller is a bounded file-delivery example, not an unattended marketplace. One operator-reviewed HCS request is matched to one funded escrow. A recorded Mode-S file can demonstrate transport, but it must not be described as current aircraft observations. The buyer decides whether the delivered service is acceptable before approving payment.

The gateway exposes a shared selected-seller ADS-B feed to authenticated customers, with one active browser subscriber. Tickets bind that subscriber to its session and owner, but do not provide confidential content isolation for each purchase: after one subscriber leaves, another authenticated customer can receive later feed data. The live owned-seller test used public Mode-S fixture bytes. Arbitrary confidential customer files are outside this adapter's supported scope.

## Prerequisites and identities

Use separate seller and buyer ECDSA testnet accounts. The buyer's transport account may differ from the browser wallet. The seller's account key must be the same key used for its quote signature, HCS quote payer and QUIC peer identity. Keep private keys and runtime files in owner-only directories outside the checkout.

Create three distinct, active, fee-free seller topics (request, status and quote) and one buyer reply topic. These topics must have no submit key for this adapter. Set their admin keys to the appropriate operator and protect those keys. The separate shared account is controlled by the transport buyer and must contain fewer than 100 tinybar; this integration never signs legacy payment schedules.

The current [Hedera account and topic documentation](https://docs.hedera.com/hedera/getting-started) covers provisioning. Existing limited testnet resources can be reused after checking their current account and topic metadata. Do not copy account IDs or keys from verification evidence into a deployment.

## Explicit seller discovery

Save the following profile in an absolute, owner-owned `0600` file whose parent directory is `0700`. Replace every placeholder with your resources:

```json
{
  "schema": "neuronDirectSeller/v1",
  "network": "testnet",
  "chainId": 296,
  "accountId": "0.0.REPLACE_SELLER",
  "publicKey": "REPLACE_66_LOWERCASE_HEX_COMPRESSED_PUBLIC_KEY",
  "stdinTopicId": "0.0.REPLACE_REQUEST_TOPIC",
  "stdoutTopicId": "0.0.REPLACE_STATUS_TOPIC",
  "quoteTopicId": "0.0.REPLACE_QUOTE_TOPIC",
  "serviceId": "1",
  "protocol": "neuron/ADSB/0.0.2",
  "paymentProtocol": "neuronCustomerQuote/v1",
  "transport": "public"
}
```

Set `NEURON_SELLER_DISCOVERY=direct` and `NEURON_DIRECT_SELLER_PROFILE_FILE` to this path in the app, gateway and seller processes. Retain the request, commerce and wallet configuration in [configuration](configuration.md). Profile identity, topics, service and network must match those settings. There is no fallback to a different discovery source when validation fails. Current Mirror metadata and the pinned key are checked before use; account key rotation requires deliberate profile reconfiguration.

`public` requires the buyer gateway's actual reachable IPv4 UDP/QUIC address. A temporary UDP tunnel may be used for a bounded test, but its expiry is an availability limit. Keep its address stable for an outstanding HCS request. For development on one machine, `transport: "loopback"` allows only an exact `/ip4/127.0.0.1/udp/PORT/quic-v1` target and local HTTP app/gateway configuration. It does not enable private-network or arbitrary-host dialing. A loopback test does not establish public connectivity.

## Publish terms for a signed-in buyer

Start the configured app and gateway, then sign in through the browser wallet. Save the `seller` descriptor returned by authenticated `GET /api/customer-commerce` to an owner-only JSON file. It includes the actual session ID, buyer address, seller, topic, cap and escrow contract. Never include the session cookie in this file.

Save a quote preparation configuration outside the checkout:

```json
{
  "descriptorFile": "/absolute/private/customer-descriptor.json",
  "sellerKeyFile": "/absolute/private/seller.hex",
  "amountTinybar": "100000",
  "durationSeconds": 5,
  "quoteLifetimeSeconds": 600,
  "refundDelaySeconds": 900,
  "outputDirectory": "/absolute/private/quote-1"
}
```

The signing key file contains the seller's 32-byte hex key. Set `NEURON_NATIVE_QUOTE_CONFIG_FILE` to the configuration path, along with the direct discovery variables, then run:

```sh
npm run native:quote
```

This verifies the configured seller and contract against Mirror and writes canonical `terms.json`, signed `envelope.json` and a `prepared-not-submitted` record. It sends no transaction and refuses to overwrite an existing output directory. Duration is limited to 1–120 seconds, amount to the buyer's cap and at most 1 HBAR, and the quote must fit within the current sign-in session. Quote lifetime is 300–3,600 seconds; the refund delay must cover that lifetime, the delivery duration and a further 180 seconds. These margins accommodate the app's separate 120-second funding and approval safety windows; delayed operations still require fresh checks.

Publish `envelope.json` using the existing [HCS writer](configuration.md#submit-hcs-evidence), with the seller as the operator/payer and the profile's quote topic. Save stdout and stderr to private files so the assigned transaction ID and exact payload hash survive an interrupted command. Use the final verified HCS sequence on the Commerce page. An unknown submission must be reconciled before retrying; a prepared envelope alone is not a confirmed quote.

## Fund, request and deliver

1. On Commerce, verify the quote, sign the exact terms review, prepare funding and confirm the native-HBAR transaction in the wallet. Wait for the app to reconcile the funded escrow.
2. In the same signed-in browser session, open Sessions and connect to the gateway. Submit **Request seller data** and wait for confirmed HCS evidence.
3. Stop and reconnect the browser stream after funding and request consensus. Approval requires a completed connection that began after both events. Keep the session signed in.
4. Configure and run the [native seller command](../packages/neuron-go/cmd/native-seller/README.md) with the actual request sequence/hash, buyer identities, funding hash, escrow ID, exact terms and source file. Reuse the seller's existing persistent delivery journal for every request; choose its path only during initial setup. The command verifies HCS, the request's encrypted address, buyer identity, pinned runtime, funding event and current escrow state before dialing the authenticated buyer peer.
5. Receive the complete file for the quoted duration, then press Stop. The seller's write count and the buyer gateway's receipt record are independent evidence. The app requires positive bytes in the same customer's completed transport interval; this does not prove service quality.
6. Return to Commerce, review the recorded delivery, explicitly acknowledge it and confirm approval in the buyer wallet. The seller can then call the deployed contract's `withdraw(escrowId)` before its deadline. Reconcile the receipt, `Released` event, exact amount and resulting `Paid` state. The buyer UI must not report payment merely because approval succeeded.

If delivery fails, do not approve it. After `refundAfter`, use the buyer's refund action and reconcile the original escrow. Seller approval or a submitted transaction hash does not remove the refund deadline. The seller command sends no blockchain writes and never automatically signs either party's payment.

## Recovery and verification

The delivery journal binds both the request and escrow. Concurrent or repeated delivery attempts are refused. A crash after claiming delivery is an uncertain attempt; retain the journal and inspect both peers' evidence. Do not delete it to force another delivery or charge. Buyer transaction retries use the existing persisted nonce and reconciliation safeguards described in [configuration](configuration.md#recovery-and-troubleshooting).

Test wrong keys, mismatched profiles, changed topic metadata, replayed HCS messages, altered source bytes, the wrong escrow buyer/seller/amount, expired funding, interrupted delivery and cross-user access before enabling a pilot. The seller's unit tests mock remote chain reads; its local QUIC test exercises real sockets. Complete testnet verification additionally requires real HCS consensus, a real funded escrow, actual buyer receipt, wallet approval and exact reconciled payout or refund.

A successful direct-discovery run proves that configured mode. It does not assert enrollment in the hosted directory, compatibility with every third-party seller, or production/mainnet readiness.
