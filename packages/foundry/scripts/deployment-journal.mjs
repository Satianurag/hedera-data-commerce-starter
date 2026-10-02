import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transaction, getAddress, keccak256 } from "ethers";

const maxJournalBytes = 1 << 20;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const owned = stat => !process.getuid || stat.uid === process.getuid();

function privatePath(path, checkoutRoot) {
  if (!path || !isAbsolute(path)) throw new Error("Deployment journal requires an absolute path");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || !owned(parent)) {
    throw new Error("Deployment journal directory must be owner-only");
  }
  const actual = join(realpathSync(dirname(path)), basename(path));
  const inside = relative(realpathSync(checkoutRoot), actual);
  if (!inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error("Deployment journal must be outside the checkout");
  return actual;
}

function privateOpen(path) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || !owned(stat) || stat.size > maxJournalBytes) {
    closeSync(fd); throw new Error("Deployment journal must be an owner-only regular file within its size bound");
  }
  return fd;
}

/** SQLite provides a crash-released OS lock. Transaction evidence is fsynced in
 * the separate append-only file so it survives even while this lock is held. */
function openJournal(path, checkoutRoot) {
  path = privatePath(path, checkoutRoot);
  const lockPath = `${path}.lock.sqlite`;
  const lockFD = privateOpen(lockPath); closeSync(lockFD);
  const lock = new DatabaseSync(lockPath);
  let fd;
  try {
    lock.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS deployment_lock (id INTEGER); BEGIN IMMEDIATE;");
    fd = privateOpen(path);
    const buffer = Buffer.alloc(maxJournalBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const raw = buffer.subarray(0, length);
    if (raw.length > maxJournalBytes || (raw.length && raw.at(-1) !== 10)) throw new Error("Deployment journal is oversized or has a partial record; preserve it for recovery");
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\n").filter(Boolean);
    if (lines.length > 128) throw new Error("Deployment journal record bound exceeded");
    const records = lines.map(line => {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== line) throw new Error("Deployment journal is malformed or ambiguous");
      return value;
    });
    return {
      records,
      append(record) {
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
        const size = fstatSync(fd).size;
        if (size + bytes.length > maxJournalBytes || records.length >= 128) throw new Error("Deployment journal is full");
        let written = 0;
        while (written < bytes.length) {
          const count = writeSync(fd, bytes, written, bytes.length - written, size + written);
          if (count <= 0) throw new Error("Deployment journal write did not complete");
          written += count;
        }
        fsyncSync(fd);
        const parentFD = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(parentFD); } finally { closeSync(parentFD); }
        records.push(record);
      },
      close() { closeSync(fd); lock.close(); },
    };
  } catch {
    if (fd !== undefined) closeSync(fd);
    lock.close();
    throw new Error("Deployment journal is invalid or locked by another process; preserve it and retry after that process exits");
  }
}

function validatePrepared(record, binding, wallet, bytecode, gasLimit, maxFeeWei) {
  if (record.schema !== "neuronDeployment/v1" || record.state !== "prepared" || record.binding !== binding ||
      !/^0x[0-9a-f]{64}$/.test(record.hash ?? "") || !/^0x(?:[0-9a-f]{2})+$/.test(record.signedTransaction ?? "")) {
    throw new Error("Deployment journal differs from the selected network, signer, artifact or fee configuration");
  }
  let tx;
  try { tx = Transaction.from(record.signedTransaction); } catch { throw new Error("Deployment journal has an invalid signed transaction"); }
  if (tx.hash !== record.hash || tx.hash !== keccak256(record.signedTransaction) || tx.from !== wallet.address ||
      tx.to !== null || tx.type !== 0 || tx.chainId !== 296n || tx.value !== 0n || tx.data.toLowerCase() !== bytecode.toLowerCase() ||
      tx.gasLimit !== gasLimit || !tx.gasPrice || tx.gasPrice <= 0n || tx.gasPrice * tx.gasLimit > maxFeeWei ||
      !Number.isSafeInteger(record.nonce) || record.nonce < 0 || tx.nonce !== record.nonce) {
    throw new Error("Prepared deployment transaction does not match its reviewed intent");
  }
  return tx;
}

/** Testable orchestration; mocked providers test recovery, not live Hedera. */
export async function deployWithJournal({ journalFile, checkoutRoot, wallet, provider, accountId,
  rpcUrl, bytecode, runtime, gasLimit, maxFeeWei, confirmMirror, onStatus = () => {} }) {
  if ((await provider.getNetwork()).chainId !== 296n) throw new Error("Deployment is restricted to Hedera testnet chain 296");
  if (!/^0\.0\.[1-9]\d*$/.test(accountId) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode) ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtime) || gasLimit < 1n || gasLimit > 2_000_000n ||
      maxFeeWei < 1n || maxFeeWei > 100_000_000n * 10_000_000_000n) throw new Error("Invalid bounded testnet deployment configuration");
  const binding = sha256(JSON.stringify({ network: "testnet", chainId: "296", accountId, signer: wallet.address,
    rpcUrl, bytecodeSha256: sha256(Buffer.from(bytecode.slice(2), "hex")), runtimeSha256: sha256(Buffer.from(runtime.slice(2), "hex")),
    gasLimit: String(gasLimit), maxFeeWei: String(maxFeeWei) }));
  const journal = openJournal(journalFile, checkoutRoot);
  try {
    let prepared = journal.records[0];
    if (!prepared) {
      const latest = await provider.getTransactionCount(wallet.address, "latest");
      const pending = await provider.getTransactionCount(wallet.address, "pending");
      if (!Number.isSafeInteger(latest) || latest < 0 || pending !== latest) throw new Error("Signer has an unresolved pending nonce; reconcile it before deployment");
      const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
      if (gasPrice <= 0n || gasPrice * gasLimit > maxFeeWei) throw new Error("Deployment gas price exceeds the configured fee cap");
      const signedTransaction = await wallet.signTransaction({ type: 0, chainId: 296, nonce: latest,
        data: bytecode, value: 0, gasLimit, gasPrice });
      prepared = { schema: "neuronDeployment/v1", state: "prepared", binding,
        hash: keccak256(signedTransaction), nonce: latest, signedTransaction, preparedAt: new Date().toISOString() };
      validatePrepared(prepared, binding, wallet, bytecode, gasLimit, maxFeeWei);
      journal.append(prepared); // Durable nonce and exact signed bytes BEFORE broadcast.
    }
    validatePrepared(prepared, binding, wallet, bytecode, gasLimit, maxFeeWei);
    for (const record of journal.records.slice(1)) {
      if (!new Set(["broadcast-attempt", "confirmed", "failed"]).has(record.state) || record.hash !== prepared.hash || record.binding !== binding) {
        throw new Error("Deployment journal has an invalid transition or intent binding");
      }
    }
    onStatus(`deployment ${prepared.hash}; reconciling the preserved nonce ${prepared.nonce}`);
    let receipt = await provider.getTransactionReceipt(prepared.hash);
    if (!receipt) {
      if (journal.records.some(record => record.state === "confirmed" || record.state === "failed")) throw new Error("Previously settled deployment receipt is unavailable; no transaction will be resent");
      const known = await provider.getTransaction(prepared.hash);
      if (!known) {
        const latest = await provider.getTransactionCount(wallet.address, "latest");
        const pending = await provider.getTransactionCount(wallet.address, "pending");
        if (latest !== prepared.nonce || pending !== prepared.nonce) throw new Error("Prepared nonce is consumed or pending elsewhere; reconcile its original hash, never start a replacement deployment");
        journal.append({ state: "broadcast-attempt", binding, hash: prepared.hash, at: new Date().toISOString() });
        try {
          const sent = await provider.broadcastTransaction(prepared.signedTransaction);
          if (sent.hash !== prepared.hash) throw new Error("hash mismatch");
        } catch {
          throw new Error(`Deployment ${prepared.hash} broadcast outcome is unknown. Rerun with this same journal to reconcile; do not create a new journal`);
        }
      }
      try { receipt = await provider.waitForTransaction(prepared.hash, 1, 90_000); }
      catch { throw new Error(`Deployment ${prepared.hash} confirmation is unknown. Resume the same journal`); }
    }
    if (!receipt) throw new Error(`Deployment ${prepared.hash} remains pending. Resume the same journal`);
    if ((receipt.hash ?? receipt.transactionHash)?.toLowerCase() !== prepared.hash ||
        getAddress(receipt.from) !== wallet.address || receipt.to !== null) throw new Error("Deployment receipt differs from the preserved transaction");
    if (receipt.status !== 1) {
      if (!journal.records.some(record => record.state === "failed")) journal.append({ state: "failed", binding, hash: prepared.hash, at: new Date().toISOString() });
      throw new Error(`Deployment ${prepared.hash} reverted. This journal remains terminal; investigate before preparing another deployment`);
    }
    if (!receipt.contractAddress) throw new Error("Successful deployment receipt has no contract address");
    if ((await provider.getCode(receipt.contractAddress)).toLowerCase() !== runtime.toLowerCase()) throw new Error("Deployed runtime differs from the pinned artifact; preserve the journal");
    const contract = await confirmMirror(receipt.contractAddress);
    if (contract.deleted !== false || !/^0\.0\.[1-9]\d*$/.test(contract.contract_id ?? "") ||
        getAddress(contract.evm_address) !== getAddress(receipt.contractAddress)) throw new Error("Deployment contract is not independently confirmed by Mirror");
    const result = { network: "testnet", contractId: contract.contract_id, evmAddress: getAddress(receipt.contractAddress),
      transactionHash: prepared.hash, runtimeSha256: sha256(Buffer.from(runtime.slice(2), "hex")) };
    if (!journal.records.some(record => record.state === "confirmed")) journal.append({ state: "confirmed", binding, hash: prepared.hash, result, at: new Date().toISOString() });
    return result;
  } finally { journal.close(); }
}
