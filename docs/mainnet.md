# Mainnet release gate

**Current support:** network-bound mainnet Mirror reads. Mainnet customer sign-in, streaming and commerce are not an enabled or verified product path. Setting `HEDERA_NETWORK=mainnet` does not convert the testnet integration into a mainnet service.

## Network and provider

Mainnet uses chain **295**; testnet uses **296**. The shared configuration accepts only the official Mirror origin for the selected network and has no mainnet legacy directory. Mainnet EVM operations require an explicit HTTPS `HEDERA_RPC_URL` and a successful `eth_chainId` preflight. Mainnet RPC configuration rejects Hashio, loopback and literal-IP endpoints; a reported chain ID alone does not establish provider trust. [Hedera's relay documentation](https://docs.hedera.com/evm/development/json-rpc) lists network IDs and reserves Hashio for development/testing.

Select a production relay with documented authentication, capacity, availability and incident procedures. Changing the Mirror allowlist or adding authenticated provider handling requires a reviewed adapter change. Keep provider secrets server-side. Evaluate current network fees and hosting/provider quotes on the actual release date using the [mainnet documentation](https://docs.hedera.com/networks/mainnet).

## Required release manifest

Record these values in one reviewed deployment manifest before any write. Empty entries keep the gate closed.

| Area | Required information |
| --- | --- |
| Source | Exact source commit, lockfiles, built artifact hashes, contract source/runtime bytecode and constructor terms |
| Identity | Fresh mainnet signer and fee-payer accounts, owner-controlled signing method, current Mirror key binding and explicit funding limits |
| Service | Mainnet seller identity, protocol revision, service ID, signed terms, topic metadata, transport endpoint and expected peer identity |
| Assets | Mainnet token/contract IDs and EVM addresses, token decimals, buyer/seller/payee identities, principal and allowance limits |
| Providers | Approved RPC and Mirror policy, chain preflight, independent read comparison, quotas and failure handling |
| Operations | Persistent host, stable DNS/TLS/WSS, required UDP ingress, capacity, access control, backups, restoration and alert ownership |
| Custody | Contract expiry/renewal funding, customer liability accounting, deadline behavior and distinct-party refund/recovery procedure |
| Budget | Allowed transaction types/counts, per-transaction fee/gas caps, aggregate principal plus fees, hosting/relay ceilings and expiry |
| Decision | Named release owner, explicit approval of this bounded manifest, stop conditions and recovery steps |

Use new mainnet resources and keys. Never relabel testnet account/topic/contract identifiers as mainnet evidence or reuse disposable test credentials. Verify each resource's metadata on the selected network. Native HBAR uses eight decimal places; RPC HBAR value uses eighteen; ERC20 decimals come from the selected token.

## Release sequence

1. Freeze the candidate and complete its testnet installation, app, wallet, delivery, settlement and recovery checks. Identify the exact protocol/seller implementation covered; different protocols need separate adapters.
2. Implement and review the mainnet application path. Its sign-in, provider, seller, asset, contract and transport configuration must be network-specific. Removing a testnet guard by itself does not provide this implementation.
3. Run read-only mainnet preflight against the manifest: identities, topic permissions, bytecode, assets, provider responses, host reachability and monitoring. Abort on mismatch or unverifiable state.
4. Obtain the release owner's decision on the complete bounded manifest. `HEDERA_ALLOW_MAINNET_WRITES=true` is a command guard, not that decision.
5. Execute only approved writes, one at a time. Reconcile receipts, independent Mirror results, contract state and balance changes before continuing. Preserve uncertain outcomes and investigate before retrying.
6. Verify an actual authorized purchase and the agreed refund/recovery path before enabling customer commerce. Retain public transaction evidence without secrets; record only capabilities the pilot exercised.

Stop when any cap, deadline, identity or provider check fails. Keep an incident path available to recover existing funds while new purchases are disabled. A read-only boot, funded escrow or successful testnet transaction is insufficient to claim a mainnet payment release.

Public template submission and mainnet deployment are separate decisions. The [Scaffold-HBAR bounty](https://hedera.com/blog/scaffold-hbar-template-bounty/) requires public source and testnet transaction evidence; it does not require a mainnet launch.
