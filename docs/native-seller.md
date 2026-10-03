# Operate a native-HBAR seller

This optional testnet integration runs a seller you control. It uses real Hedera accounts, HCS messages, QUIC data and `BuyerEscrow` transactions. The operator supplies an explicit seller profile; the seller does not need to appear in the hosted aviation directory. Default directory discovery remains a separate integration.

The seller delivers a selected file for one operator-reviewed HCS request matched to one funded escrow. Use recorded Mode-S bytes for replay, or connect a live source in your own adapter. The buyer decides whether the delivered service is acceptable before approving payment.

The gateway exposes a shared selected-seller ADS-B feed to authenticated customers, with one active browser subscriber. Tickets bind that subscriber to its session and owner, but do not provide confidential content isolation for each purchase: after one subscriber leaves, another authenticated customer can receive later feed data. Use public data with this feed. For confidential per-customer files, use the authenticated [reference document service](../packages/neuron-reference/README.md).

## Prerequisites and identities

Use separate seller and buyer ECDSA testnet accounts. The buyer's transport account may differ from the browser wallet. The seller's account key must be the same key used for its quote signature, HCS quote payer and QUIC peer identity. Keep private keys and runtime files in owner-only directories outside the checkout.

Create three distinct, active, fee-free seller topics (request, status and quote) and one buyer reply topic. These topics must have no submit key for this adapter. Set their admin keys to the appropriate operator and protect those keys. The separate shared account is controlled by the transport buyer and must contain fewer than 100 tinybar; this integration never signs legacy payment schedules.

Provision on **testnet** using the current [account creation](https://docs.hedera.com/learn/core-concepts/accounts/account-creation) and [topic creation](https://docs.hedera.com/native/consensus/create-topic) procedures. Use the pinned `github.com/hiero-ledger/hiero-sdk-go/v2/sdk` module:

1. Obtain a limited ECDSA testnet operator through [Hedera Portal](https://portal.hedera.com/). Keep its key outside the repository. Generate distinct seller and transport-buyer keys with `hiero.PrivateKeyGenerateEcdsa()`. Create their accounts with `hiero.NewAccountCreateTransaction().SetECDSAKeyWithAlias(key.PublicKey()).SetInitialBalance(hiero.NewHbar(1))`, using the funded testnet operator. The method retains `Alias` in its API name; the resulting identifier is an **EVM Address from Public Key**. The browser wallet must use its own funded ECDSA account. Record each assigned transaction ID before `Execute`, then its receipt account ID; reconcile an unknown result before creating another account.
2. Create the shared account with the **transport buyer's existing public key**, `SetKeyWithoutAlias(buyerKey.PublicKey())` and `SetInitialBalance(hiero.HbarFromTinybar(0))`. Do not generate a new key for it and do not fund it for legacy schedules.
3. For each of the four named topics, use `hiero.NewTopicCreateTransaction().SetAdminKey(ownerKey.PublicKey()).SetTopicMemo(role).SetMaxTransactionFee(hiero.HbarFromTinybar(100000000))`. Set `client.SetOperator(ownerAccountID, ownerKey)` to the seller for its three topics and the buyer for its reply topic. **Do not call `SetSubmitKey` or add custom fees.** Assign `hiero.TransactionIDGenerate(ownerAccountID)` with `SetTransactionID`, save that ID privately before `Execute(client)`, and obtain `TopicID` from `response.GetReceipt(client)`. Record roles explicitly; exchanging status/request topics is not interchangeable. A lost response requires inspecting the recorded ID on Mirror, not rerunning creation.
4. Verify each account at `https://testnet.mirrornode.hedera.com/api/v1/accounts/ACCOUNT_ID`: active ECDSA key, expected public key and expected EVM address. Verify each topic at `/api/v1/topics/TOPIC_ID`: `deleted: false`, `submit_key: null`, empty `custom_fees.fixed_fees`, and the intended admin. Record numeric IDs and public keys in a separate deployment inventory. Do not use the historical evidence IDs as deployment settings.

Creation spends testnet fees. Existing resources can be reused after the same metadata checks.

### Key formats

One seller identity needs two encodings of the **same** key. Renaming a file does not convert it.

| Consumer                                                                                   | File contents                                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `native:quote`                                                                             | Exactly 32-byte raw secp256k1 private key as 64 hex digits (optional `0x`)     |
| `hcs:submit`, `native-seller`, native contract deployer, legacy request/gateway Hedera key | DER-encoded ECDSA private key as hex                                           |
| Direct seller profile                                                                      | Compressed public key, 33 bytes / 66 lowercase hex digits; never a private key |

In a private Go provisioning program, parse the original ECDSA key using `hiero.PrivateKeyFromStringECDSA(rawHex)`, then save `key.StringRaw()` to `seller.hex` and `key.StringDer()` to `seller.der` with `os.WriteFile(path, []byte(value), 0600)` in a pre-existing `0700` directory. Refuse existing output files and symlinks; do not print either representation. `key.PublicKey().StringRaw()` is the public profile value, and `"0x" + key.PublicKey().ToEvmAddress()` must match the account's current EVM address. The DER and raw files are equally sensitive credentials.

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

`public` requires the buyer gateway's actual reachable IPv4 UDP/QUIC address. Keep that address reachable and stable for each outstanding HCS request. For development on one machine, `transport: "loopback"` allows only an exact `/ip4/127.0.0.1/udp/PORT/quic-v1` target and local HTTP app/gateway configuration. It does not enable private-network or arbitrary-host dialing.

## Publish terms for a signed-in buyer

Start the configured app and gateway, then sign in through the browser wallet. Save the `seller` descriptor returned by authenticated `GET /api/customer-commerce` to an owner-only JSON file. It includes the actual session ID, buyer address, seller, topic, cap and escrow contract. Never include the session cookie in this file. For example, after reviewing this snippet, run it in developer tools on your own signed-in app page. It downloads only the returned descriptor; it does not copy cookies or authorize a payment:

```js
const response = await fetch("/api/customer-commerce", { credentials: "same-origin" });
if (!response.ok) throw new Error(`Descriptor request failed: ${response.status}`);
const { seller } = await response.json();
if (!seller || seller.network !== "testnet" || seller.chainId !== 296)
  throw new Error("Wrong descriptor network");
const url = URL.createObjectURL(
  new Blob([JSON.stringify(seller, null, 2)], { type: "application/json" }),
);
const link = document.createElement("a");
link.href = url;
link.download = "customer-descriptor.json";
link.click();
setTimeout(() => URL.revokeObjectURL(url), 1000);
```

Move the downloaded file into your private directory, set mode `0600`, and remove the download copy. Its fields include `sessionId`, `sessionExpiresAt`, `buyerAddress`, `sellerAccount`, `quoteTopic`, `maxSpendTinybar`, `escrowContractId` and `escrowAddress`. Check those against the signed-in wallet and operator profile before preparing a quote. A new sign-in requires a new descriptor and new quote; never edit a session ID inside an old signed quote.

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
5. Receive the complete file for the quoted duration, then press Stop. The app requires positive bytes in the same customer's completed transport interval. Review the received content before approving payment.
6. Return to Commerce, review the recorded delivery, explicitly acknowledge it and confirm approval in the buyer wallet. The seller can then follow the [explicit withdrawal procedure](contracts.md#seller-withdrawal) before its deadline. Reconcile the receipt, `Released` event, exact amount and resulting `Paid` state. The buyer UI must not report payment merely because approval succeeded.

If delivery fails, do not approve it. After `refundAfter`, use the buyer's refund action and reconcile the original escrow. Seller approval or a submitted transaction hash does not remove the refund deadline. The seller command submits no network transactions and never automatically signs either party's payment.

## Recovery and verification

The delivery journal binds both the request and escrow. Concurrent or repeated delivery attempts are refused. A crash after claiming delivery is an uncertain attempt; retain the journal and inspect both peers' evidence. Do not delete it to force another delivery or charge. Buyer transaction retries use the existing persisted nonce and reconciliation safeguards described in [configuration](configuration.md#recovery-and-troubleshooting).

Run the [seller command tests](../packages/neuron-go/cmd/native-seller/README.md#recovery-and-checks) and the [template checks](verification.md) after changes. For a configured testnet deployment, verify HCS consensus, escrow funding, buyer receipt, explicit wallet approval and the reconciled payout or deadline refund.

## Availability

Check the selected account/topic metadata and confirm that your seller is running before requesting data. A directory entry or an old signed message does not establish current availability. Keep the direct profile, active seller key and gateway address synchronized.

The shared Mirror and directory GET clients retry only HTTP 429/503, at most three attempts inside one ten-second deadline. A valid `Retry-After` up to two seconds is honored; a longer/invalid value fails without an early retry. HCS submissions and wallet transactions use their own persisted intent and reconciliation flow. Metadata changes fail closed.
