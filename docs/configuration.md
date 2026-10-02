# Configuration and recovery

The default app is read-only. Put optional Next.js settings in `packages/nextjs/.env.local`, based on [the example](../packages/nextjs/.env.example), or export them in the process environment. Go commands read their process environment; they do not load Next.js `.env.local`.

Never put keys in `NEXT_PUBLIC_*`. Use absolute paths to owner-only files outside the checkout: private directories mode `0700`, key/token/config files mode `0600`. All enabled operations validate configuration before acting.

## Network and wallet authentication

| Variable | Meaning |
| --- | --- |
| `HEDERA_NETWORK` | `testnet` by default, or `mainnet` for read-only evidence |
| `HEDERA_CHAIN_ID` | Optional consistency check: testnet `296`, mainnet `295` |
| `HEDERA_MIRROR_URL` | Optional; only the official origin for the selected network is accepted |
| `NEURON_LEGACY_DIRECTORY_URL` | Optional; only the canonical testnet directory is accepted |
| `NEURON_ENABLE_CUSTOMER_AUTH` | `true` enables testnet wallet sign-in |
| `NEURON_APP_ORIGIN` | Exact browser origin, such as `http://localhost:3000`; no trailing slash |
| `NEURON_CUSTOMER_DB_FILE` | Absolute SQLite path in an existing private directory |
| `NEURON_ALLOWED_CUSTOMER_ADDRESSES` | Required for HTTPS pilots: 1–20 comma-separated checksummed EVM addresses, no spaces |
| `NEURON_REOWN_PROJECT_ID` | Optional dedicated 32-hex Reown project ID to expose WalletConnect |

Use one hostname consistently: `localhost` and `127.0.0.1` are different origins. An EVM wallet must report Hedera testnet chain **296** and account/network/disconnect events. Connection alone signs nothing. A sign-in signature authenticates the app session; it does not authorize payment.

Installed MetaMask has full reference checkout evidence. Other injected wallets and the optional WalletConnect/HashPack path require their own handshake, signature and transaction checks. The WalletConnect dependency retains its upstream licensing and service terms. Native Hedera/Ed25519 wallets are not interchangeable with this EVM signature path.

WalletConnect uses one SDK Core per page. Cancellation removes the wallet selection immediately and bounds local teardown; a pending SDK proposal may settle later. A new attempt waits for that settlement and cleanup, while a stalled or failed cleanup requires reloading the page. Late approvals cannot select a cancelled wallet. The lifecycle tests exercise real SDK heartbeat timers and idle relay open/close APIs; relay pairing, mobile approval and WalletConnect payments still require a configured project and separate live evidence.

## Reference document commerce

Follow [the adapter guide](../packages/neuron-reference/README.md) to provision your own accounts/topics, token and ERC20 escrow, choose a permitted immutable file and build the pinned bridge. No owner test resources are configured by default.

The Next process needs customer authentication above and:

| Variable | Meaning |
| --- | --- |
| `NEURON_ENABLE_REFERENCE_COMMERCE` | `true` enables the optional `/reference` route |
| `NEURON_REFERENCE_URL` | Bridge loopback origin, normally `http://127.0.0.1:8098` |
| `NEURON_REFERENCE_API_TOKEN_FILE` | Shared private bearer-token file; server-only |

The bridge independently needs `NEURON_REFERENCE_CONFIG_FILE`, `NEURON_REFERENCE_STATE_DIR`, the same token file and optional `NEURON_REFERENCE_LISTEN`. Run its `--check` preflight before enabling new sessions. Configuration and source fingerprints bind existing sessions; retain the original files through restart or migration.

## Legacy streaming

Build the Go commands from `packages/neuron-go` with Go 1.27.1:

```sh
go build -o /absolute/private/bin/legacy-gateway ./cmd/legacy-gateway
go build -o /absolute/private/bin/legacy-request ./cmd/legacy-request
go build -o /absolute/private/bin/hcs-submit ./cmd/hcs-submit
```

Create the private output directory first. The app requires request/submit binaries and their immediate parent to be owned by its service user and inaccessible to other users.

For the gateway:

| Variable | Meaning |
| --- | --- |
| `HEDERA_NETWORK` | Explicitly `testnet` |
| `NEURON_SELLER_ACCOUNT_ID` | Selected live seller, verified against directory and Mirror |
| `HEDERA_BUYER_KEY_FILE` | Private buyer secp256k1 key file |
| `NEURON_UDP_PORT` | Publicly reachable QUIC port, normally `4001` |
| `NEURON_GATEWAY_LISTEN` | Loopback HTTP listener, normally `127.0.0.1:9080` |
| `NEURON_APP_ORIGIN` | Exact browser origin shared with Next |
| `NEURON_SESSION_TOKEN_FILE` | Private file containing 32 random bytes encoded as 64 hex characters |
| `NEURON_SESSION_JOURNAL_FILE` | Private durable gateway journal; required for remote use |
| `NEURON_GATEWAY_SESSION_CHECK_URL` | `http://127.0.0.1:3000/api/gateway-session` for customer-bound tickets |

Next needs the same seller/origin/token and customer auth. Local streaming uses `NEURON_ENABLE_LOCAL_STREAM=true` with `NEURON_GATEWAY_WS_URL=ws://127.0.0.1:9080/stream`. Remote streaming uses `NEURON_ENABLE_REMOTE_STREAM=true`, a `wss://host/stream` URL, exact `NEURON_GATEWAY_PUBLIC_HOST`, and loopback `NEURON_GATEWAY_INTERNAL_ORIGIN` for server checks. Use [the deployment guide](../deploy/testnet/README.md) for TLS and firewall setup.

`Connect` opens a stream and does not pay a seller. To expose **Request seller data**, also configure:

- `NEURON_ENABLE_CUSTOMER_REQUEST=true`, `NEURON_SELLER_STDIN_TOPIC_ID`.
- `HEDERA_BUYER_ACCOUNT_ID`, `HEDERA_BUYER_STDIN_TOPIC_ID`, `HEDERA_SHARED_ACCOUNT_ID`.
- `HEDERA_OPERATOR_ACCOUNT_ID`, `HEDERA_OPERATOR_KEY_FILE`, `HEDERA_MAX_FEE_TINYBAR`.
- `NEURON_PUBLIC_UDP_MULTIADDR`, and absolute `NEURON_LEGACY_REQUEST_BIN` / `NEURON_HCS_SUBMIT_BIN`.

A public HTTPS request pilot additionally requires `NEURON_ENABLE_PUBLIC_CUSTOMER_REQUEST=true` and `NEURON_PUBLIC_REQUEST_LIMIT` (1–100 lifetime requests for that database). Requests require the same customer to own the active gateway subscriber. Repeated POSTs reuse the durable request. These commands sign no seller payment schedules.

The legacy protocol needs inbound UDP on a reachable host. A temporary tunnel can prove testnet connectivity, but cannot provide a durable deployment.

## Native-HBAR extension

This is a separate optional `/commerce` flow using `neuronCustomerQuote/v1`, not the reference ERC20 invoice.

For a seller you operate, follow the [native seller guide](native-seller.md). Explicit `direct` discovery pins its account, current public key, topics and protocols in an owner-only profile, with independent Mirror checks. It does not require an entry in the hosted aviation directory. The default `canonical` discovery mode remains separate; there is no automatic fallback. Share the same profile with Next, the gateway and seller command.

| Switch | Additional configuration |
| --- | --- |
| `NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW=true` | Customer auth, `NEURON_COMMERCE_SELLER_ACCOUNT_ID`, `NEURON_COMMERCE_QUOTE_TOPIC_ID`, `NEURON_COMMERCE_SERVICE_ID`, `NEURON_COMMERCE_MAX_SPEND_TINYBAR` (at most 1 HBAR), `HEDERA_CONTRACT_ID`, checksummed `HEDERA_CONTRACT_ADDRESS` |
| `NEURON_ENABLE_CUSTOMER_FUNDING=true` | Explicit HTTPS testnet `HEDERA_RPC_URL`, exact `NEURON_ESCROW_RUNTIME_SHA256`, `NEURON_COMMERCE_MAX_TX_FEE_TINYBAR` (at most 100,000,000), approval switch for new funding |
| `NEURON_ENABLE_CUSTOMER_APPROVAL=true` | Same funding gates, gateway token and internal origin, matching gateway/quote seller, service ID `1`, completed same-session positive-byte transport evidence and explicit buyer acknowledgement |

Deploy your own [native-HBAR contract](../packages/foundry/src/BuyerEscrow.sol) using `npm run contract:deploy` with `HEDERA_NETWORK=testnet`, `HEDERA_OPERATOR_ACCOUNT_ID`, `HEDERA_OPERATOR_KEY_FILE`, `HEDERA_DEPLOYMENT_JOURNAL_FILE`, `HEDERA_MAX_FEE_TINYBAR` and `HEDERA_CONTRACT_GAS`. The signer must be a dedicated ECDSA EVM-alias account. Deployment validates account/key, RPC chain and resulting runtime code. The mandatory journal is an absolute path outside the checkout in an owner-only directory; its signed transaction, nonce and computed hash are persisted before broadcasting. Resume with the same journal and unchanged configuration after a timeout or restart. Do not delete, replace or use a new journal to retry an uncertain deployment. A companion SQLite file provides a process-crash-safe lock. Both files remain private; the journal contains replayable signed transaction bytes. Fees are capped at 1 HBAR, and mainnet deployment is disabled pending its separate release.

A seller must publish real signed terms on its configured HCS topic. Directory prices are not checkout quotes. Byte counts do not prove service quality; buyer approval is an explicit decision. Existing timeout recovery remains available when new funding is disabled. The audit exercised native-HBAR funding and refund with an installed MetaMask wallet. The complete canonical-directory seller request → transport → approval browser flow and external legacy seller acceptance remain unverified.

## Submit HCS evidence

The server writer accepts 1–8,192 stdin bytes in at most eight 1,024-byte chunks. Configure a funded operator and a topic whose submit key matches it; deliberately use `HEDERA_TOPIC_ACCESS=open` for an open topic. Custom fixed-fee topics are rejected.

```sh
HEDERA_NETWORK=testnet \
HEDERA_OPERATOR_ACCOUNT_ID="$TESTNET_ACCOUNT_ID" \
HEDERA_TOPIC_ID="$TESTNET_TOPIC_ID" \
HEDERA_OPERATOR_KEY_FILE="$PRIVATE_KEY_FILE" \
HEDERA_MAX_FEE_TINYBAR="$MAX_FEE_TINYBAR" \
npm run hcs:submit < "$MESSAGE_FILE"
```

The writer prints a preassigned ID and payload hash before sending, then checks receipt and exact Mirror bytes/payer. A receipt may be `UNKNOWN` when Mirror independently confirms execution. The configured fee is divided across chunks; SDK retries mean it is not a hard aggregate spend ceiling. Reconcile uncertain results before any manual retry.

## Recovery and troubleshooting

| Symptom | Action |
| --- | --- |
| `better-sqlite3` native binding missing or incompatible | Select Node from `.nvmrc`, then `npm run rebuild:native`; build Linux artifacts on Linux |
| Auth disabled or origin rejected | Check explicit testnet, exact origin/Host and private DB directory; HTTPS also requires allowlist |
| Read-only page reports unavailable | Check current public directory/Mirror availability; retain the unverified state |
| WebSocket connected but no bytes | Check seller request, selected PeerID, UDP reachability and current seller availability; heartbeat alone is insufficient |
| Wallet request has no returned hash | Preserve intent/nonce. Reconcile wallet history and original chain transaction; never reset the journal |
| Reference session cap reached | Preserve all sessions. Review any capacity/config migration; a new empty state directory is not recovery |
| Funding or release is pending | Refresh receipt/state against the saved hash. A timeout does not authorize a duplicate transaction |

For a legacy HCS request in `uncertain`, or `submitting` for at least 120 seconds, set the original network/database/operator/seller-topic configuration and run:

```sh
npm run request:reconcile -w @neuron/nextjs -- <request-id>
```

This checks the saved transaction ID, hash, topic, payer and bytes without submitting again. Unmatched rows stay blocked. For reference sessions, use the saved transaction hash and the app's refresh/recovery controls. Retain SQLite state, bridge journals, downloaded files, token, source and exact configuration together across restarts. Follow [the reference restart procedure](../packages/neuron-reference/README.md#restart-the-configured-local-service).

### Native payment recovery

Never delete the SQLite journal to retry. Every wallet opening now stores a nonce and an opening reference before returning a transaction; returned hashes attach to that exact opening. Retries retain earlier transactions, including late returned hashes. Refresh/restart and signing in again with the same buyer preserve owned escrow history. Another wallet or origin cannot recover it.

- **Funding cancelled or interrupted before a hash was reported:** check wallet history and **Check chain outcome**. After one minute, with more than two minutes left on the quote, acknowledge the warning and use **Recheck and retry funding wallet**. The original authenticated session, reviewed terms, buyer, contract, value, calldata and nonce must match; the quote, seller, runtime, gas and balance are rechecked. The server refuses a reported hash, pending/consumed nonce, changed attempt or already-used terms. Gas estimates may change, but a fresh payment nonce is never allocated. Every opening remains recorded. Failed, nonce-less or expired funding uses the closure path below instead.
- **Expired funding (including a confirmed revert):** use **Check whether expired quote can be closed**. The server rechecks failure evidence, the pinned runtime, unused buyer/terms mapping at a post-expiry block, and the complete event range. Successful, conflicting or uncertain hashed funding is not abandoned. Keep continuing a bounded scan until complete. The original transaction hashes remain saved.
- **A new quote after closure:** sign out and sign in again on **Sessions**, return to **Commerce**, and give the seller the newly displayed session ID and buyer address. Each authenticated session accepts one reviewed quote. A quote signed for the previous session cannot be reused.
- **Refund or approval rejected, reverted, or interrupted:** refresh its outcome. A confirmed failure can retry immediately; an uncertain opening requires a one-minute wait, then a fresh explicit acknowledgement. Refund retries recheck the original refundable escrow; approval retries also recheck the same seller key, confirmed request and completed transport. Each new opening is atomically recorded. The prior unconsumed nonce is reused; another pending wallet transaction blocks allocation of a fresh nonce. If an unknown nonce was consumed (for example by a wallet cancellation), a new nonce requires proof of the pinned runtime and the exact still-refundable/unapproved escrow at the same block as the consumed-nonce observation. If that proof is unavailable, recover the original hash from wallet history and reconcile it.
- **Older journals without a nonce:** guarded refund/approval recovery retains an explicit legacy snapshot, its original opening count and any hash. With fresh chain checks and no pending wallet nonce, the buyer may explicitly accept a fresh attempt. An old broadcast can still succeed and charge gas; contract state permits only one effective refund or approval. This exception does not permit funding to resend: old funding must first satisfy expiry/unused-terms/event proof.

A receipt timeout or wallet error is never proof of rejection. No app can stop a user changing calldata or nonce in an external wallet; authoritative receipt/event/storage checks determine the result. Recovery never removes ownership, origin, network, runtime or delivery checks. If a returned hash was lost, use the matching **hash from wallet history** field on the escrow. It attaches to the saved wallet opening and does not send another transaction. Copy the exact original contract call, not an unrelated cancellation or transfer; the server rejects mismatched transaction evidence. Pending hash saves must finish before another wallet retry.
