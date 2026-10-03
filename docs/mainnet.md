# Mainnet support

Set `HEDERA_NETWORK=mainnet` to read mainnet HCS evidence through the official Mirror Node. Customer sign-in, legacy streaming, reference commerce, native-HBAR checkout and contract deployment are **testnet-only**. Changing the network variable does not enable those features on mainnet.

## Network configuration

| Setting                       | Mainnet behavior                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HEDERA_CHAIN_ID`             | Optional assertion; must be `295` when set. Testnet uses `296`.                                                                                                          |
| `HEDERA_MIRROR_URL`           | Defaults to `https://mainnet.mirrornode.hedera.com`; other origins are rejected.                                                                                         |
| `NEURON_LEGACY_DIRECTORY_URL` | Unset; the template has no mainnet legacy directory.                                                                                                                     |
| `HEDERA_RPC_URL`              | Optional for read-only browsing. If supplied, must be HTTPS without URL credentials, query or fragment. Hashio, local hostnames and literal IPs are rejected on mainnet. |

Shared EVM helpers require an explicit relay and verify its chain ID before use. Keep provider credentials server-side. See the [environment index](environment.md) for process-specific configuration.

## Standalone HCS writer

The separate `npm run hcs:submit` command can submit on mainnet only with both `HEDERA_NETWORK=mainnet` and `HEDERA_ALLOW_MAINNET_WRITES=true`. It also requires an operator account/key, a valid topic and a positive fee cap, as described in [HCS setup](configuration.md#submit-hcs-evidence). Export these settings in the command's environment; it does not load the app's `.env.local`.

This opt-in spends real HBAR and does not enable application commerce. The configured fee is divided among chunks; SDK retries can increase aggregate fees. Save the printed transaction IDs and reconcile uncertain results before retrying.

## Extending commerce to mainnet

A mainnet adapter needs its own accounts, topic permissions, seller protocol, token/contract addresses, pinned runtime and provider configuration. Testnet IDs and receipts cannot be reused. Preserve wallet ownership, exact asset units, transaction journals and deadline refunds when implementing the adapter. Validate purchase, rejection, restart and refund behavior with the selected wallet and services before accepting customer funds.
