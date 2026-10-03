# Testnet examples

These public records illustrate completed HCS, purchase and refund operations. They are examples, not accounts or contracts to configure in a new project. Testnet resets may remove them.

## HCS

The HCS submit command sent [transaction `0.0.10725146@1790499070.059923854`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790499070-059923854) from a scaffolded project. [Topic 0.0.10725147, sequence 13](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10725147/messages/13) contains 293 bytes with SHA-256 `9cf4105a82aa70e43d8423f0191c67b167921911c707aefb2e3befb7076f322b`.

A signed two-chunk example ends at [topic 0.0.10828164, sequence 8](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10828164/messages/8): 1,095 bytes, payer `0.0.10824371`, SHA-256 `4d39108b36040a219178d187ed5427414be1fbb7cbcc4e74e182be5e1c4f6c38`.

## Native-HBAR escrow

A controlled buyer/seller run used [contract 0.0.10828632](https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10828632) and explicit MetaMask confirmations:

| Action                                      | Public receipt                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Fund escrow with 0.001 HBAR                 | [Funding](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xb20df175691f779e172e502c8b369f7c7fc5a30aaca2d7fffa9dddb915ee924f)    |
| Approve delivery                            | [Approval](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xd28b6598f2cd3a69de2985044f8e318ef5fabca52497677fd626da691c528cbd)   |
| Pay the seller 100,000 tinybar              | [Withdrawal](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x2f8871e967420d5f7f2a50124fecbd04dbcf2f586c1f86dd61549770da0f9f06) |
| Refund a separate escrow after its deadline | [Refund](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xf28db9fd0ba772edd7deff2ba96bbb3fd69183226f946f4007090c5422d0b8c6)     |

The run used an explicitly configured seller and authenticated QUIC transport with replayed reference frames. For your own service, follow [native seller setup](native-seller.md).

## Reference ERC20 escrow

A separate controlled reference-adapter purchase paid 0.01 NTT using the pinned protocol:

| Action                                        | Public receipt                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve exact token allowance                 | [Allowance](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xdf04e7f042046e572e6e0271cfa7449936a53edf0fa181d6b9c5fce9ee6078fb)  |
| Deposit                                       | [Funding](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x1b1a7edb6528018a83ed17f6ebe624cdec7890c1a78e1c2f849a8f831f057a8d)    |
| Approve payment                               | [Approval](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x90d1a7fff1a60bff4d7aeafccbfcf6ba75a573c36fe2e46cf23633e674ca4be4)   |
| Pay the seller                                | [Withdrawal](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x5031eaa0b3a132705b61cf62f9630e46543514d17eea2feb79eb7b3298526196) |
| Refund a separate purchase after its deadline | [Refund](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x8b19f38f2ff6a03a0a8383b6520d2605e197d0631a8e374b8ba0be6bb7c79116)     |

See the [reference adapter guide](../packages/neuron-reference/README.md) to provision your own accounts and immutable document.

## Recheck the records

```sh
npm run check:evidence
```

The [manifest](../scripts/testnet-evidence.json) contains the expected message lengths/hashes, transaction results, decoded events, transfers and pinned contract-state checks, including recovery cases. The independent [verifier](../scripts/verify-evidence.mjs) compares those fields with live public records and fails on mismatches. It does not submit transactions or rerun wallet and transport interactions. See [verification](verification.md) for local tests and a live browser check.
