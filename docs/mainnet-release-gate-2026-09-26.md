# Mainnet release and cost gate

**Prepared:** 26 September 2026. **Decision:** closed. This is a planning record, not an approval to provision resources, spend HBAR, deploy a contract, or enable customer payments. The [implementation preflight](mainnet-release-preflight.md) and [product acceptance gates](superpowers/specs/2026-09-25-neuron-customer-app.md) remain applicable. Recheck variable prices, limits, provider terms and live resource availability on the actual release date.

## Resources that must be separate from testnet

| Item | Record before release | Current evidence |
| --- | --- | --- |
| Network and signer | `mainnet`, chain ID **295**, new owner-controlled mainnet ECDSA buyer/deployer/fee-payer identities as needed; public account IDs, keys and funding caps. Never reuse disclosed chat or testnet keys. | Mainnet has no candidate signer, funded account or write. Testnet chain ID is **296**. [Hedera relay network table](https://docs.hedera.com/evm/development/json-rpc). |
| HCS and seller | Mainnet seller account/key, service ID, registry or accurately labelled legacy provenance, topic IDs and topic metadata, payer policy, signed quote/invoice format, live UDP endpoint and verified PeerID. | None verified. Testnet IDs and the controlled seller quote do not transfer to mainnet. |
| Contract | Mainnet contract ID/address, deployed source revision and runtime bytecode match, owner/admin policy, expiry and renewal funding, isolation of customer liabilities, timeout-refund operator plan. | `0.0.10730636` and its refund proof are **testnet only**; its Mirror record had no auto-renew account. |
| Read providers | Explicit mainnet Mirror origin and a named production JSON-RPC relay with terms, authentication, capacity and failure plan; read-only `eth_chainId=295` and independent Mirror comparisons before signing. | [Hedera Mirror](https://docs.hedera.com/reference/rest-api) lists separate mainnet/testnet origins; the public mainnet API currently limits requests per IP. [Hedera says Hashio is for development/testing](https://docs.hedera.com/evm/development/json-rpc), so it is not the production-provider decision. A reported chain ID alone does not establish provider trust. |
| Browser wallet | Confirm the chosen adapter, its license/terms for a paid-data app, explicit provider selection, ECDSA account and mainnet chain binding; prove its prompts and recovery first with a disposable testnet wallet. | [Read-only HashPack audit](wallet-compatibility-audit-2026-09-26.md) found no injected `window.ethereum` on the inspected page. Owner's HashPack was on testnet. Neither HashPack nor MetaMask has completed candidate sign-in/checkout; no mainnet wallet proof exists. |

The [official Hedera mainnet guide](https://docs.hedera.com/networks/mainnet) says every mainnet transaction incurs a fee and points to the current network fee schedule and fee tables. Record the fee estimate and HBAR exchange assumption immediately before the pilot; testnet execution fees are not a mainnet price quote. HBAR's native unit has eight decimal places, while JSON-RPC `value` represents 18-decimal weibars ([Hedera relay documentation](https://docs.hedera.com/evm/development/json-rpc)).

## Hosting choice and cost record

The existing Mumbai host is an **Always Free E2 Micro testnet pilot**, with 1 GB RAM and only one short live-client capacity observation. It already occupies the remaining E2 Micro slot reported in this tenancy; an A1 request failed `Out of host capacity` despite quota. Its temporary IP-derived hostname, broad shared VCN security list and host-level firewall are recorded in the [testnet evidence](testnet-evidence-2026-09-26.md#hosted-mumbai-next-app-and-nginx-cutover--26-september-2026). It must not be counted as a reserved or proven production mainnet host.

[Oracle's Always Free policy](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) permits up to two E2 Micro instances and an A1 allowance equivalent to 2 OCPUs/12 GB in the tenancy **home region**, subject to available host capacity; E2 Micro has 1 GB RAM. Oracle says `Out of host capacity` can persist until capacity changes, and idle free instances may be reclaimed. A quota listing therefore does not guarantee another free VM. Its home-region block-volume allowance also counts boot disks. [Oracle's capacity troubleshooting](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/troubleshooting-out-of-host-capacity.htm) describes shape/domain alternatives, not a guaranteed allocation.

Select and document exactly one production path after sizing a real concurrent workload: (1) an actually allocated and separately secured OCI Always Free host, if available and adequate; or (2) a quoted paid host with reachable public UDP and HTTPS/WSS. A production domain, DNS/TLS renewal, backups, patching, monitoring, log retention, inbound firewall/VCN isolation and recovery are required either way. Do not migrate the unrelated existing OCI VM or relax its shared VCN rules merely to launch this service. A single 1 GB, no-swap, short-session measurement is insufficient to size customer concurrency or promise continuous free hosting.

Fill this dated cost sheet with **provider quotes and a hard maximum**, then compare the total to the approved budget. Blank values mean the gate is closed; no unquoted service is assumed free.

| Cost / exposure | Quantity and dated source to enter | Maximum to approve |
| --- | --- | --- |
| Compute, boot/block storage, backup and outbound traffic | Chosen OCI shape actually allocated or paid-host quote; account for all existing tenancy usage and region | **Unset** |
| Domain, DNS, TLS and monitoring | Provider/domain renewal quotes, alert/log storage and backup retention | **Unset** |
| Production JSON-RPC and any Mirror provider | Named plan, rate limit, overage policy and credentials/storage | **Unset** |
| Hedera setup transactions | Separate account/topic/contract create and deployment fee estimates from current [Hedera fee schedule](https://docs.hedera.com/networks/mainnet); contract gas and renewal reserve | **Unset** |
| Pilot service/payment and recovery | Maximum principal, transaction fees, gas caps, refund reserve and aggregate loss limit | **Unset** |

## Closed gates before the first mainnet write

1. Finish the current testnet product work and consolidated tests, including an installed-wallet flow, independent live seller-signed terms, real delivery-evidence checks, explicit buyer approval, actual seller settlement **and** timeout/refund recovery. Resolve draft Neuron 008 `evidenceHash` disagreement with a seller/maintainer. A controlled quote-to-refund test is valuable but cannot substitute for those gates.
2. Freeze a reviewed source commit, compatible lockfile and deployed artifact hashes. Verify mainnet configuration denies testnet IDs, signer keys, Mirror/RPC origins and chain 296. Complete read-only account/topic/contract metadata, seller identity, provider and gateway reachability checks on chain 295. Abort on a mismatch, stale/empty Mirror result, unverified bytecode or uncertain transaction.
3. Choose the mainnet host/provider and fill every cost-sheet cell with current quote, usage estimate and maximum. Include contract expiry/renewal funding, backup restoration, owner-only journal recovery and alerts. Reserve a bounded amount for refunds and network fees even if compute is free.
4. Review an exact pilot manifest: signer/account, seller, topics, contract bytecode hash and constructor terms, allowed transaction types and count, per-transaction HBAR/gas caps, total HBAR exposure, expiry, stop conditions and rollback/refund instructions. The owner makes a separate decision on this concrete mainnet manifest before writes. This document does not grant that decision.
5. Execute at most the approved pilot sequence, one write at a time. After each write, match the consensus receipt, independent mainnet Mirror transaction/log, contract state and account balance delta before continuing. Do not retry an uncertain outcome blindly. For payment, verify seller-signed terms and explicit wallet authorization, then verify live transport evidence and the buyer's manual decision before seller release. Exercise the agreed distinct-party refund/recovery path and retain transaction hashes and timestamps without secrets.
6. Keep mainnet customer payment controls disabled until the pilot evidence and monitoring/recovery review pass. Label `configured`, `verified`, `streaming`, `paid` and `refunded` separately; a heartbeat, quote, schedule or funded escrow alone is not a paid live service.

## Publication and privacy choice

The owner instructed that `Satianurag/neuron-customer-app-scaffold-hbar` stay **private**. A private collaborator checkout and local Scaffold-HBAR copy are supported; an anonymous public clone and the bounty's public-template submission are incompatible with that choice. Do not change visibility automatically. Record a separate owner decision if public release or bounty submission is later desired; source publication is not a prerequisite for private mainnet pilot planning, but it is a prerequisite for any public-template claim.

**Current result:** no mainnet signer, funded account, provider, seller, contract, production host capacity proof, completed cost sheet, approved pilot manifest or mainnet transaction exists. The gate remains closed.
