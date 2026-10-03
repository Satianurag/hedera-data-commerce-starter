# Native-HBAR seller adapter

This testnet-only command fulfills **one operator-reviewed HCS service request against one funded `BuyerEscrow`**. It sends a selected file once over the authenticated `neuron/ADSB/0.0.2` QUIC stream, paced over the configured duration. File replay is not live sensor acquisition. The command has no automatic legacy scheduled-payment loop and performs no network transactions.

The transport buyer, HCS payer and customer payment wallet can be different accounts. The private configuration explicitly binds their exact request to the funded escrow. An operator must review the configuration; never derive it directly from untrusted client input.

The gateway serves a shared selected-seller ADS-B feed with one active authenticated browser subscriber. Session-bound tickets prevent subscriber takeover but do not isolate confidential content by purchase; another authenticated customer can receive later feed data after the current subscriber leaves. Use public feed data. For confidential customer files, use the authenticated [reference document service](../../../neuron-reference/README.md).

## Before delivery

1. Configure the same direct seller profile used by the app, request generator and gateway. The seller key must match that profile and current Mirror account evidence.
2. Obtain an actual confirmed buyer request and its exact HCS sequence and SHA-256 from the app journal. Obtain the funded escrow ID, transaction hash, terms hash, tinybar amount and both deadlines from the verified quote and funding journal. Review their session and identity association.
3. Select the source file, record its SHA-256, and put the configuration and seller DER key in owner-only files outside the checkout. The command snapshots at most 4 MiB of source bytes before connecting. Use one persistent journal for this seller's deliveries, in an existing owner-only directory; do not rotate it to bypass a prior attempt.

Configuration schema (replace every example identity, hash, time and path with reviewed values):

```json
{
  "schema": "neuronNativeSeller/v1",
  "network": "testnet",
  "sellerAccountId": "0.0.100",
  "sellerKeyFile": "/absolute/private/seller.der",
  "sellerStdinTopicId": "0.0.101",
  "buyerTransportAccountId": "0.0.200",
  "buyerStdinTopicId": "0.0.201",
  "buyerSharedAccountId": "0.0.202",
  "payerAccountId": "0.0.300",
  "requestSequence": 7,
  "requestSHA256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "buyerWalletAddress": "0x1111111111111111111111111111111111111111",
  "escrowContractId": "0.0.400",
  "escrowContractAddress": "0x4444444444444444444444444444444444444444",
  "runtimeSHA256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "fundingTransactionHash": "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "escrowId": "9",
  "termsHash": "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "amountTinybar": "1000000",
  "quoteExpiresAt": 1700000000,
  "refundAfter": 1700001000,
  "sourceFile": "/absolute/data/capture.bin",
  "sourceSHA256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "durationSeconds": 30,
  "journalFile": "/absolute/private/native-deliveries.jsonl"
}
```

All hex fields are lowercase. `durationSeconds` is 1–120. `amountTinybar` is the contract's native-HBAR storage amount in eight-decimal tinybars, not the eighteen-decimal JSON-RPC transaction value. Requests must be at most ten minutes old and a single HCS message. The payer must exactly match `payerAccountId`; sharing a transport public key does not authorize a different payer.

## Run

From `packages/neuron-go`, with the existing direct-profile environment:

```sh
export HEDERA_NETWORK=testnet
export NEURON_SELLER_DISCOVERY=direct
export NEURON_DIRECT_SELLER_PROFILE_FILE=/absolute/private/direct-seller.json
export NEURON_NATIVE_SELLER_CONFIG_FILE=/absolute/private/delivery.json
GOTOOLCHAIN=go1.27.1 go run ./cmd/native-seller
```

Public mode only dials one literal public IPv4 UDP/QUIC address from the decrypted request. DNS, relay paths, private ranges, link-local addresses, CGNAT and multicast are rejected. For explicitly configured local development, the direct profile must use `transport: "loopback"`, the app's local-stream environment must satisfy its loopback policy, and the delivery configuration must add `loopbackTarget` containing the exact `/ip4/127.0.0.1/udp/PORT/quic-v1` request address. That exception permits neither another loopback host nor another port nor private network addresses. Local transport still requires HCS, testnet contract reads, ECDH and peer-key authentication.

The command verifies testnet chain 296, contract ID/address, runtime SHA-256, successful funding receipt, exact `Funded` event and exact `Funded` storage tuple. Runtime and storage are read at the same block. Immediately before claiming delivery, the refund deadline must still exceed the duration plus 30 seconds for connection and safety. It then durably claims the request and escrow before connecting, writes the immutable snapshot, and waits for the receiver's stream close. Its JSON result records completed seller stream writes. Use the app to verify buyer receipt, review the content and explicitly approve payment. Seller withdrawal is a separate [operator action](../../../../docs/contracts.md#seller-withdrawal).

## Recovery and checks

A failed or interrupted run is retained. This command refuses another attempt for the same request or escrow, even after restart, because a missing completion record cannot prove no bytes reached the buyer. Inspect the preserved journal and buyer transport evidence before deciding on a fresh request and newly reviewed escrow. Use the existing deadline-refund path for an unfulfilled purchase; never erase delivery or payment journals to retry.

```sh
GOTOOLCHAIN=go1.27.1 go test ./cmd/native-seller
GOTOOLCHAIN=go1.27.1 go test -race ./cmd/native-seller
```

Tests distinguish mocked RPC/storage checks from a real local QUIC transfer. They cover HCS payer/sequence/hash/age, buyer identity and ECDH, service/protocol binding, non-public address rejection, exact runtime/escrow/receipt checks, concurrent/restarted delivery claims, binary preservation, cancellation and partial writes. The tests do not submit network transactions. A testnet delivery requires the reviewed inputs above.
