// Independent read-only verifier: deliberately imports no application or shared verification code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Interface, Signature, SigningKey, computeAddress, hexlify, keccak256 } from "ethers";

const MIRROR = "https://testnet.mirrornode.hedera.com";
const RPC = "https://testnet.hashio.io/api";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equalAddress = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const abi = new Interface([
  "event Funded(uint256 indexed id,address indexed buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 indexed termsHash)",
  "event Approved(uint256 indexed id,address indexed buyer)",
  "event Released(uint256 indexed id,address indexed seller,address to,uint256 amount)",
  "event Refunded(uint256 indexed id,address indexed buyer,address to,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
  "function escrows(uint256) view returns(address buyer,address seller,uint256 amount,uint64 quoteExpiresAt,uint64 refundAfter,bytes32 termsHash,uint8 state)",
  "function decimals() view returns(uint8)",
  "function symbol() view returns(string)",
]);

export async function readPublicJSON(url, options = {}) {
  const parsed = new URL(url);
  assert([MIRROR, new URL(RPC).origin].includes(parsed.origin), "Unapproved public origin");
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `HTTP ${response.status}: ${url}`);
  assert(response.body, "Empty HTTP body");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2_000_000) {
      await reader.cancel();
      throw Error("Oversized public response");
    }
    parts.push(value);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function transactionKey(id) {
  assert(
    id &&
      typeof id.account_id === "string" &&
      typeof id.transaction_valid_start === "string" &&
      Number.isSafeInteger(id.nonce) &&
      typeof id.scheduled === "boolean",
    "Invalid chunk transaction identity",
  );
  return `${id.account_id}@${id.transaction_valid_start}/${id.nonce}/${id.scheduled}`;
}

export function reconstructHistoricalHCS(selected, candidates, expected) {
  assert.equal(selected.topic_id, expected.topic);
  assert.equal(selected.sequence_number, expected.sequence);
  let chunks = [selected];
  if (selected.chunk_info) {
    const info = selected.chunk_info;
    assert(
      Number.isSafeInteger(info.total) && info.total > 0 && info.total <= 20,
      "Invalid chunk count",
    );
    assert.equal(info.number, info.total, "Expected the final chunk, not a partial message");
    const key = transactionKey(info.initial_transaction_id);
    chunks = candidates
      .filter(
        (row) => row.chunk_info && transactionKey(row.chunk_info.initial_transaction_id) === key,
      )
      .sort((a, b) => a.chunk_info.number - b.chunk_info.number);
    assert.equal(chunks.length, info.total, "Incomplete or duplicate chunk set");
    chunks.forEach((row, index) => {
      assert.equal(row.chunk_info.number, index + 1, "Duplicate or missing chunk number");
      assert.equal(row.chunk_info.total, info.total);
      if (index)
        assert(row.sequence_number > chunks[index - 1].sequence_number, "Invalid chunk ordering");
    });
    assert.equal(chunks.at(-1).sequence_number, expected.sequence);
    assert.deepEqual(chunks.at(-1), selected, "Selected chunk differs from page");
  }
  const bytes = Buffer.concat(
    chunks.map((row) => {
      assert.equal(row.topic_id, expected.topic);
      assert.equal(row.payer_account_id, expected.payer);
      assert(
        Number.isSafeInteger(row.sequence_number) &&
          row.sequence_number > 0 &&
          row.sequence_number <= expected.sequence,
      );
      assert(typeof row.message === "string", "Missing HCS bytes");
      const decoded = Buffer.from(row.message, "base64");
      assert(
        decoded.length <= 1024 && decoded.toString("base64") === row.message,
        "Noncanonical HCS base64",
      );
      return decoded;
    }),
  );
  assert.equal(bytes.length, expected.bytes, "Unexpected byte length");
  assert.equal(digest(bytes), expected.sha256, "Historical HCS bytes changed");
  return bytes;
}

export function verifyEnvelope(bytes, sender, payerAccount, requireCurrentKey) {
  const envelope = JSON.parse(bytes.toString("utf8"));
  assert(equalAddress(envelope.senderAddress, sender), "Unexpected envelope sender");
  for (const value of [envelope.timestamp, envelope.sequenceNumber]) {
    assert(
      typeof value === "string" &&
        /^(0|[1-9][0-9]*)$/.test(value) &&
        BigInt(value) <= 0xffffffffffffffffn,
      "Invalid uint64 signature field",
    );
  }
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  assert.equal(payload.toString("base64"), envelope.payload);
  assert.equal(signature.length, 65);
  assert.equal(signature.toString("base64"), envelope.signature);
  const preimage = Buffer.alloc(16 + payload.length);
  preimage.writeBigUInt64BE(BigInt(envelope.timestamp));
  preimage.writeBigUInt64BE(BigInt(envelope.sequenceNumber), 8);
  payload.copy(preimage, 16);
  const recovered = SigningKey.recoverPublicKey(
    keccak256(preimage),
    Signature.from({
      r: hexlify(signature.subarray(0, 32)),
      s: hexlify(signature.subarray(32, 64)),
      v: signature[64],
    }),
  );
  assert(equalAddress(computeAddress(recovered), sender), "Invalid protocol signature");
  const currentPayerKeyMatches =
    payerAccount.key?._type === "ECDSA_SECP256K1" &&
    payerAccount.key.key.toLowerCase() ===
      SigningKey.computePublicKey(recovered, true).slice(2).toLowerCase();
  if (requireCurrentKey)
    assert(currentPayerKeyMatches, "Current payer key no longer matches pinned signer");
  return { signatureVerified: true, sender, currentPayerKeyMatches };
}

export function verifyReceipt(receipt, expected, actions = []) {
  assert.equal(receipt.hash?.toLowerCase(), expected.hash.toLowerCase(), "Wrong transaction hash");
  assert.equal(receipt.contract_id, expected.contractId, "Wrong contract");
  assert.equal(receipt.result, expected.result, "Unexpected transaction outcome");
  assert.equal(String(receipt.amount), expected.amountTinybar, "Wrong attached tinybar amount");
  const events = (receipt.logs ?? []).flatMap((log) => {
    let decoded;
    try {
      decoded = abi.parseLog(log);
    } catch {
      return [];
    }
    if (!decoded) return [];
    return [
      {
        event: decoded.name,
        address: log.address.toLowerCase(),
        args: Object.fromEntries(
          decoded.fragment.inputs.map((input, index) => [
            input.name,
            decoded.args[index].toString(),
          ]),
        ),
      },
    ];
  });
  const normalize = (rows) =>
    rows.map((row) => ({
      ...row,
      address: row.address.toLowerCase(),
      args: Object.fromEntries(
        Object.entries(row.args).map(([key, value]) => [
          key,
          /^0x/i.test(value) ? value.toLowerCase() : value,
        ]),
      ),
    }));
  assert.deepEqual(
    normalize(events),
    normalize(expected.events),
    "Unexpected receipt event fields",
  );
  assert.deepEqual(
    actions
      .filter((row) => row.value > 0)
      .map((row) => ({ from: row.caller, to: row.recipient, tinybar: String(row.value) })),
    expected.nativeTransfers,
    "Incorrect native transfer recipient or tinybar amount",
  );
  return {
    hash: expected.hash,
    observedResult: receipt.result,
    expectedFailure: expected.result !== "SUCCESS",
    eventsVerified: events.length,
    nativeTransfersVerified: expected.nativeTransfers.length,
  };
}

export async function verifyEvidence({ read = readPublicJSON, manifest } = {}) {
  manifest ??= JSON.parse(
    await readFile(new URL("./testnet-evidence.json", import.meta.url), "utf8"),
  );
  const checks = [];
  const check = async (name, operation) => {
    try {
      checks.push({ name, passed: true, ...(await operation()) });
    } catch (error) {
      checks.push({ name, passed: false, error: error.message });
    }
  };
  const mirror = (path) => read(`${MIRROR}/api/v1${path}`);
  const rpc = async (method, params) => {
    assert(
      ["eth_chainId", "eth_getCode", "eth_getBalance", "eth_blockNumber", "eth_call"].includes(
        method,
      ),
    );
    const result = await read(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert(!result.error, `RPC error: ${JSON.stringify(result.error)}`);
    assert.equal(result.id, 1);
    return result.result;
  };
  await check("testnet chain", async () => {
    assert.equal(await rpc("eth_chainId", []), manifest.chainId);
    return {};
  });
  for (const expected of manifest.hcs)
    await check(`HCS ${expected.topic}/${expected.sequence}`, async () => {
      const selected = await mirror(`/topics/${expected.topic}/messages/${expected.sequence}`);
      let candidates = [selected];
      if (selected.chunk_info) {
        let next = `/api/v1/topics/${expected.topic}/messages?limit=100&order=desc&sequencenumber=lte:${expected.sequence}`;
        candidates = [];
        for (let page = 0; next && page < 5; page++) {
          assert(
            next.startsWith(`/api/v1/topics/${expected.topic}/messages?`),
            "Pagination escaped topic",
          );
          const result = await read(`${MIRROR}${next}`);
          assert(Array.isArray(result.messages) && result.messages.length <= 100);
          candidates.push(...result.messages);
          const total = selected.chunk_info.total;
          if (
            candidates.filter(
              (row) =>
                row.chunk_info &&
                transactionKey(row.chunk_info.initial_transaction_id) ===
                  transactionKey(selected.chunk_info.initial_transaction_id),
            ).length >= total
          )
            break;
          next = result.links?.next;
        }
      }
      const bytes = reconstructHistoricalHCS(selected, candidates, expected);
      let signature = {};
      if (expected.sender) {
        const account = await mirror(`/accounts/${expected.payer}`);
        assert.equal(account.account, expected.payer, "Wrong current payer account response");
        assert.equal(account.deleted, false, "Current payer account is deleted");
        signature = verifyEnvelope(
          bytes,
          expected.sender,
          account,
          expected.currentPayerKeyMustMatch,
        );
      }
      return { sha256: digest(bytes), bytes: bytes.length, payer: expected.payer, ...signature };
    });
  for (const expected of manifest.receipts)
    await check(`receipt ${expected.hash}`, async () => {
      const receipt = await mirror(`/contracts/results/${expected.hash}`);
      const actions = expected.nativeTransfers.length
        ? await mirror(`/contracts/results/${expected.hash}/actions?limit=100`)
        : { actions: [] };
      assert(
        !actions.links?.next,
        "Transfer actions require pagination; cannot prove complete transfer set",
      );
      return verifyReceipt(receipt, expected, actions.actions);
    });
  await check("current runtime and escrow states", async () => {
    const block = await rpc("eth_blockNumber", []);
    const code = await rpc("eth_getCode", [manifest.runtime.address, block]);
    assert.equal(digest(Buffer.from(code.slice(2), "hex")), manifest.runtime.sha256);
    const states = {};
    for (const [id, expected] of Object.entries(manifest.escrows)) {
      const values = abi.decodeFunctionResult(
        "escrows",
        await rpc("eth_call", [
          { to: manifest.runtime.address, data: abi.encodeFunctionData("escrows", [id]) },
          block,
        ]),
      );
      const actual = Object.fromEntries(
        abi
          .getFunction("escrows")
          .outputs.map((field, index) => [field.name, values[index].toString()]),
      );
      assert.deepEqual(actual, expected, `Escrow ${id} state changed`);
      states[id] = actual;
    }
    // Other users can fund a public contract later. Report current balance; never require historical zero forever.
    return {
      block,
      runtimeSHA256: manifest.runtime.sha256,
      escrows: states,
      currentContractBalanceWei: BigInt(
        await rpc("eth_getBalance", [manifest.runtime.address, block]),
      ).toString(),
    };
  });
  await check("reference ERC20 token units", async () => {
    for (const field of ["decimals", "symbol"]) {
      const value = abi.decodeFunctionResult(
        field,
        await rpc("eth_call", [
          { to: manifest.token.address, data: abi.encodeFunctionData(field) },
          "latest",
        ]),
      )[0];
      assert.equal(value.toString(), manifest.token[field]);
    }
    return { ...manifest.token };
  });
  return {
    schema: manifest.schema,
    checkedAt: new Date().toISOString(),
    network: manifest.network,
    recordedSourceCommit: manifest.recordedSourceCommit,
    passed: checks.every((row) => row.passed),
    checks,
    scope:
      "Read-only historical receipts plus current state/key checks. No new payment, current seller availability, third-party interoperability, browser delivery or service-quality claim.",
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assert.equal(process.argv.length, 2, `Usage: node ${fileURLToPath(import.meta.url)}`);
  const result = await verifyEvidence();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}
