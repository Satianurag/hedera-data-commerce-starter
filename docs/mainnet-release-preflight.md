# Mainnet release preflight

**Status:** implementation preparation, 26 September 2026. This is not a mainnet approval or evidence of a deployed service. The final consolidated test pass is scheduled after the remaining coding is complete.

## Network boundaries now encoded

- `HEDERA_NETWORK=mainnet` selects EVM chain ID **295** and `https://mainnet.mirrornode.hedera.com`. Testnet selects **296** and `https://testnet.mirrornode.hedera.com`. The app rejects a mismatched `HEDERA_CHAIN_ID` and an unapproved Mirror origin.
- An EVM relay is optional and has **no mainnet default**. `HEDERA_RPC_URL` is interpreted only under the selected `HEDERA_NETWORK`. The URL must be HTTPS and contain no credentials, query or fragment; mainnet additionally rejects Hashio, loopback and literal IP hosts. `assertEvmRpcNetwork` performs a bounded, read-only `eth_chainId` request and rejects a response that does not match the selected chain. Every future EVM signer or transaction path must call it before constructing a provider or authorizing a transaction. The URL and any provider credentials must remain server-side. These checks do not authenticate a provider merely because it reports chain ID 295.
- The legacy directory is approved only for testnet. A mainnet seller cannot be inferred from a testnet account, topic, contract, PeerID or HCS message.

The [Hedera JSON-RPC Relay documentation](https://docs.hedera.com/evm/development/json-rpc) lists chain IDs 295/296 and public Hashio endpoints, but explicitly limits Hashio to development and testing. A mainnet production provider must be selected and reviewed; merely receiving chain ID 295 does not prove the provider is trustworthy or production grade. The [Hedera Mirror Node REST documentation](https://docs.hedera.com/reference/rest-api) lists the two network-specific origins and notes a public mainnet rate limit that may change.

## Facts required before a mainnet release decision

| Required fact | Current state | Evidence needed |
|---|---|---|
| Mainnet signer and fee payer | Missing | Dedicated mainnet account, owner-controlled signing method, Mirror account/key match, approved funding and per-transaction/aggregate limits. Never reuse chat-disclosed or testnet keys. |
| Production EVM relay | Missing | Named provider or self-hosted relay, exact HTTPS endpoint, capacity/reliability and authentication plan, chain-ID preflight, independent read comparison with Mirror. The deployment script now requires an explicit `HEDERA_RPC_URL` on mainnet; that guard remains untested until the final pass and does not select a provider. |
| Mainnet seller identity | Missing | Actual seller account and signing key, approved registry/Agent Card or explicitly labelled legacy provenance, live service ID, topic metadata and network-bound transport endpoint. |
| Signed commercial terms | Missing | Seller-signed quote/invoice with exact asset, integer amount, recipient, buyer, service/session, duration, expiry, budget and evidence binding. Resolve draft Neuron 008 invoice-field conflict with a seller or protocol maintainer. |
| Contract and recovery | Missing | Mainnet contract design and deployment owner, source/runtime verification, renewal funding, liability isolation, refund operation and monitoring. Testnet contract IDs do not count. |
| Data gateway | Testnet Mumbai pilot only | Stable production DNS/TLS/WSS, reachable inbound UDP, capacity sizing, customer ownership journal, incident response and recovery. The 1 GB test VM and temporary tunnel are not production proof. |
| Costs and authorization | Missing | Dated line-item network/hosting/relay budget, bounded pilot transaction list and maximum spend, owner approval of that concrete pilot. |

## Bounded pilot sequence after implementation and final test pass

1. Complete the clean candidate's testnet compatibility, live seller, commerce and recovery gates. Preserve receipt, Mirror and balance evidence for each claim.
2. Record the exact mainnet resources, provider, seller, contracts, identities, spend caps and rollback/incident steps in a release sheet. Review the deployed bytecode and contract expiry/renewal plan.
3. Run mainnet **read-only** checks: `eth_chainId`, Mirror account/topic/contract metadata, provider response consistency, gateway reachability and seller identity. Failure closes the gate.
4. Obtain a separate decision on the concrete bounded pilot before any mainnet write. Execute only the listed writes; reconcile each consensus receipt, Mirror row and balance change before proceeding. If commerce is in scope, include a seller-signed quote and an actual refund/recovery path with distinct parties.
5. Publish a dated evidence record that names only the features actually exercised. A read-only mainnet boot is not a mainnet service, payment or refund proof.

No mainnet write or deployment has been authorized by this document. Current code and evidence do not satisfy this release gate.
