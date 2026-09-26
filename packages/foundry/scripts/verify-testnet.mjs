import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
      return receipt;
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
  const journalPath = process.env.HEDERA_TEST_JOURNAL_FILE;
  if (!journalPath || !isAbsolute(journalPath)) throw new Error("HEDERA_TEST_JOURNAL_FILE must be an absolute owner-only path");
  const journal = await open(journalPath, "a", 0o600);
  const journalInfo = await journal.stat();
  if (!journalInfo.isFile() || (journalInfo.mode & 0o077) !== 0) {
    await journal.close();
    throw new Error("test journal must be an owner-only regular file");
  }
  const overrides = { gasLimit, gasPrice };
  const buyerContract = new ethers.Contract(address, artifact.abi, buyer.connect(provider));
  const sellerContract = new ethers.Contract(address, artifact.abi, seller.connect(provider));
  const transactions = [];

  async function submit(label, transactionPromise) {
    const transaction = await transactionPromise;
    console.error(`${label} submitted: ${transaction.hash}`);
    await journal.appendFile(`${JSON.stringify({ label, transaction: transaction.hash, contractId, network: "testnet" })}\n`);
    await journal.sync();
    const receipt = await confirmed(transaction, contractId);
    transactions.push(transaction.hash);
    return receipt;
  }

  async function fund(deadline, terms) {
    const receipt = await submit("fund", buyerContract.fund(seller.address, deadline, terms, { ...overrides, value }));
    const funded = receipt.logs.flatMap(log => {
      if (log.address.toLowerCase() !== address.toLowerCase()) return [];
      try {
        const parsed = buyerContract.interface.parseLog(log);
        return parsed?.name === "Funded" ? [parsed] : [];
      } catch { return []; }
    });
    assert.equal(funded.length, 1, "fund transaction must emit exactly one Funded event");
    const event = funded[0].args;
    assert.equal(event.buyer.toLowerCase(), buyer.address.toLowerCase());
    assert.equal(event.seller.toLowerCase(), seller.address.toLowerCase());
    assert.equal(event.amount, tinybar);
    assert.equal(event.refundAfter, BigInt(deadline));
    assert.equal(event.termsHash.toLowerCase(), terms.toLowerCase());
    const id = event.id;
    await journal.appendFile(`${JSON.stringify({ label: "funded", transaction: receipt.hash, id: String(id), contractId, network: "testnet" })}\n`);
    await journal.sync();
    const escrow = await buyerContract.escrows(id);
    assert.equal(escrow.buyer.toLowerCase(), buyer.address.toLowerCase());
    assert.equal(escrow.seller.toLowerCase(), seller.address.toLowerCase());
    assert.equal(escrow.amount, tinybar, "Hedera EVM tinybar conversion mismatch");
    assert.equal(escrow.refundAfter, BigInt(deadline));
    assert.equal(escrow.termsHash.toLowerCase(), terms.toLowerCase());
    assert.equal(escrow.state, 1n);
    return id;
  }

  let deadline = (await provider.getBlock("latest")).timestamp + 90;
  const terms = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), refundAfter: deadline, test: "native-hbar-release" })));
  const releaseId = await fund(deadline, terms);
  await submit("approve", buyerContract.approve(releaseId, overrides));
  await submit("withdraw", sellerContract.withdraw(releaseId, seller.address, overrides));
  assert.equal((await buyerContract.escrows(releaseId)).state, 3n);

  deadline = (await provider.getBlock("latest")).timestamp + 45;
  const refundTerms = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), refundAfter: deadline, test: "native-hbar-refund" })));
  const refundId = await fund(deadline, refundTerms);
  while ((await provider.getBlock("latest")).timestamp < deadline) await new Promise(resolve => setTimeout(resolve, 2_000));
  await submit("refund", buyerContract.refund(refundId, buyer.address, overrides));
  assert.equal((await buyerContract.escrows(refundId)).state, 4n);

  deadline = (await provider.getBlock("latest")).timestamp + 45;
  const abandonedTerms = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), refundAfter: deadline, test: "approved-but-unclaimed-refund" })));
  const abandonedApprovalId = await fund(deadline, abandonedTerms);
  await submit("approve", buyerContract.approve(abandonedApprovalId, overrides));
  assert.equal((await buyerContract.escrows(abandonedApprovalId)).state, 2n);
  while ((await provider.getBlock("latest")).timestamp < deadline) await new Promise(resolve => setTimeout(resolve, 2_000));
  await submit("refund", buyerContract.refund(abandonedApprovalId, buyer.address, overrides));
  assert.equal((await buyerContract.escrows(abandonedApprovalId)).state, 4n);
  assert.equal(await provider.getBalance(address), 0n);
  await journal.close();
  console.log(JSON.stringify({ network: "testnet", contractId, buyer: buyer.address, seller: seller.address, amountTinybar: String(tinybar), releaseId: String(releaseId), refundId: String(refundId), abandonedApprovalId: String(abandonedApprovalId), transactions }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "testnet lifecycle failed");
  process.exitCode = 1;
});
