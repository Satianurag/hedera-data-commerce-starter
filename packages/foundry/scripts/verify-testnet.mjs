import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { ethers } from "ethers";

const mirror = "https://testnet.mirrornode.hedera.com";
const rpc = "https://testnet.hashio.io/api";
const value = ethers.parseEther("0.1");
const tinybar = 10_000_000n;

async function account(name) {
  const id = process.env[`HEDERA_${name}_ACCOUNT_ID`];
  const path = process.env[`HEDERA_${name}_KEY_FILE`];
  if (!/^\d+\.\d+\.\d+$/.test(id ?? "") || !path) throw new Error(`${name} account and private key file are required`);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`${name} private key file must be owner-only`);
  const key = createPrivateKey({ key: Buffer.from((await readFile(path, "utf8")).trim(), "hex"), format: "der", type: "sec1" });
  const jwk = key.export({ format: "jwk" });
  const wallet = new ethers.Wallet(`0x${Buffer.from(jwk.d, "base64url").toString("hex")}`);
  const response = await fetch(`${mirror}/api/v1/accounts/${id}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${name} account missing on testnet Mirror`);
  const record = await response.json();
  const compressedPublicKey = `${Buffer.from(jwk.y, "base64url").at(-1) & 1 ? "03" : "02"}${Buffer.from(jwk.x, "base64url").toString("hex")}`;
  if (record.account !== id || record.deleted !== false || record.evm_address?.toLowerCase() !== wallet.address.toLowerCase() ||
      record.key?._type !== "ECDSA_SECP256K1" || record.key.key?.toLowerCase() !== compressedPublicKey.toLowerCase()) {
    throw new Error(`${name} EVM identity mismatch on testnet`);
  }
  return wallet;
}

async function confirmed(transaction, contractId) {
  const receipt = await transaction.wait(1, 90_000);
  if (!receipt || receipt.status !== 1) throw new Error(`transaction ${transaction.hash} failed or timed out`);
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`${mirror}/api/v1/contracts/results/${transaction.hash}`, {
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const result = await response.json();
      if (result.result !== "SUCCESS" || result.contract_id !== contractId) {
        throw new Error(`Mirror contract result mismatch for ${transaction.hash}`);
      }
      return transaction.hash;
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Mirror did not index ${transaction.hash}`);
}

async function main() {
  if (process.env.HEDERA_NETWORK !== "testnet") throw new Error("this integration run is testnet-only");
  const contractId = process.env.HEDERA_CONTRACT_ID;
  const address = process.env.HEDERA_CONTRACT_ADDRESS;
  if (!/^\d+\.\d+\.\d+$/.test(contractId ?? "") || !ethers.isAddress(address)) {
    throw new Error("HEDERA_CONTRACT_ID and HEDERA_CONTRACT_ADDRESS are required");
  }
  const [buyer, seller] = await Promise.all([account("BUYER"), account("SELLER")]);
  assert.notEqual(buyer.address, seller.address);
  const provider = new ethers.JsonRpcProvider(rpc);
  assert.equal((await provider.getNetwork()).chainId, 296n);
  const artifact = JSON.parse(await readFile(new URL("../out/BuyerEscrow.sol/BuyerEscrow.json", import.meta.url), "utf8"));
  assert.equal((await provider.getCode(address)).toLowerCase(), artifact.deployedBytecode.object.toLowerCase());
  const contractResponse = await fetch(`${mirror}/api/v1/contracts/${contractId}`, {
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  if (!contractResponse.ok) throw new Error(`selected contract missing on testnet Mirror: HTTP ${contractResponse.status}`);
  const contractRecord = await contractResponse.json();
  if (contractRecord.contract_id !== contractId || contractRecord.deleted !== false ||
      contractRecord.evm_address?.toLowerCase() !== address.toLowerCase()) {
    throw new Error("selected contract ID/address mismatch on testnet");
  }
  const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  const gasLimit = 400_000n;
  const feeCap = BigInt(process.env.HEDERA_MAX_FEE_TINYBAR ?? "0") * 10_000_000_000n;
  if (feeCap <= 0n || gasPrice * gasLimit > feeCap) throw new Error("test fee cap is insufficient");
  const overrides = { gasLimit, gasPrice };
  const buyerContract = new ethers.Contract(address, artifact.abi, buyer.connect(provider));
  const sellerContract = new ethers.Contract(address, artifact.abi, seller.connect(provider));
  const transactions = [];

  let id = await buyerContract.nextId();
  const releaseId = id;
  let deadline = (await provider.getBlock("latest")).timestamp + 90;
  const terms = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), refundAfter: deadline, test: "native-hbar-release" })));
  transactions.push(await confirmed(await buyerContract.fund(seller.address, deadline, terms, { ...overrides, value }), contractId));
  assert.equal((await buyerContract.escrows(id)).amount, tinybar, "Hedera EVM tinybar conversion mismatch");
  transactions.push(await confirmed(await buyerContract.approve(id, overrides), contractId));
  transactions.push(await confirmed(await sellerContract.withdraw(id, seller.address, overrides), contractId));
  assert.equal((await buyerContract.escrows(id)).state, 3n);

  id = await buyerContract.nextId();
  const refundId = id;
  deadline = (await provider.getBlock("latest")).timestamp + 45;
  const refundTerms = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), refundAfter: deadline, test: "native-hbar-refund" })));
  transactions.push(await confirmed(await buyerContract.fund(seller.address, deadline, refundTerms, { ...overrides, value }), contractId));
  assert.equal((await buyerContract.escrows(id)).amount, tinybar);
  while ((await provider.getBlock("latest")).timestamp < deadline) await new Promise(resolve => setTimeout(resolve, 2_000));
  transactions.push(await confirmed(await buyerContract.refund(id, buyer.address, overrides), contractId));
  assert.equal((await buyerContract.escrows(id)).state, 4n);

  id = await buyerContract.nextId();
  const abandonedApprovalId = id;
  deadline = (await provider.getBlock("latest")).timestamp + 45;
  const abandonedTerms = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), refundAfter: deadline, test: "approved-but-unclaimed-refund" })));
  transactions.push(await confirmed(await buyerContract.fund(seller.address, deadline, abandonedTerms, { ...overrides, value }), contractId));
  transactions.push(await confirmed(await buyerContract.approve(id, overrides), contractId));
  assert.equal((await buyerContract.escrows(id)).state, 2n);
  while ((await provider.getBlock("latest")).timestamp < deadline) await new Promise(resolve => setTimeout(resolve, 2_000));
  transactions.push(await confirmed(await buyerContract.refund(id, buyer.address, overrides), contractId));
  assert.equal((await buyerContract.escrows(id)).state, 4n);
  assert.equal(await provider.getBalance(address), 0n);
  console.log(JSON.stringify({ network: "testnet", contractId, buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), releaseId: String(releaseId), refundId: String(refundId), abandonedApprovalId: String(abandonedApprovalId), transactions }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "testnet lifecycle failed");
  process.exitCode = 1;
});
