import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transaction, Wallet } from "ethers";
import { deployWithJournal } from "../scripts/deployment-journal.mjs";

// These providers simulate RPC outcomes. They do not establish live Hedera deployment.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "deployment-recovery-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(),
    contractAddress = Wallet.createRandom().address;
  const state = {
    broadcasts: [],
    nonce: 3,
    pending: 3,
    receipt: null,
    known: null,
    fault: "",
    mirrorFault: false,
  };
  const options = {
    journalFile: join(dir, "deployment.jsonl"),
    checkoutRoot: process.cwd(),
    wallet,
    accountId: "0.0.123",
    rpcUrl: "https://testnet.hashio.io/api",
    bytecode: "0x60006000",
    runtime: "0x6000",
    gasLimit: 100_000n,
    maxFeeWei: 10_000_000_000n,
    confirmMirror: async (address) => {
      if (state.mirrorFault) throw new Error("Mirror indexing delayed");
      assert.equal(address, contractAddress);
      return { deleted: false, contract_id: "0.0.456", evm_address: contractAddress };
    },
  };
  options.provider = {
    getNetwork: async () => ({ chainId: 296n }),
    getTransactionCount: async (_address, tag) => (tag === "pending" ? state.pending : state.nonce),
    send: async (method) => {
      assert.equal(method, "eth_gasPrice");
      return "0x10";
    },
    getTransactionReceipt: async () => state.receipt,
    getTransaction: async () => state.known,
    broadcastTransaction: async (raw) => {
      const tx = Transaction.from(raw);
      const records = readFileSync(options.journalFile, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(
        records[0].signedTransaction,
        raw,
        "exact signed bytes must be durable before sending",
      );
      assert.equal(records[0].hash, tx.hash);
      assert.equal(records[0].nonce, tx.nonce);
      assert.equal(records.at(-1).state, "broadcast-attempt");
      state.broadcasts.push(raw);
      if (state.fault === "not accepted") throw new Error(`RPC secret packet ${raw}`);
      state.known = { hash: tx.hash };
      state.receipt = {
        hash: tx.hash,
        status: state.fault === "revert" ? 0 : 1,
        from: wallet.address,
        to: null,
        contractAddress,
      };
      state.nonce++;
      state.pending++;
      if (state.fault === "lost response") throw new Error(`RPC secret packet ${raw}`);
      return { hash: tx.hash };
    },
    waitForTransaction: async () => (state.fault === "timeout" ? null : state.receipt),
    getCode: async () => options.runtime,
  };
  return { options, state, dir, contractAddress };
}

test("deployment is signed and journaled before broadcasting, then resumes without a second send", async (t) => {
  const { options, state } = setup(t);
  const first = await deployWithJournal(options),
    second = await deployWithJournal(options);
  assert.deepEqual(second, first);
  assert.equal(state.broadcasts.length, 1);
  assert.equal(Transaction.from(state.broadcasts[0]).nonce, 3);
  assert.equal(Transaction.from(state.broadcasts[0]).chainId, 296n);
  assert.equal(readFileSync(options.journalFile, "utf8").includes('"confirmed"'), true);
});

test("accepted transaction with a lost RPC response recovers its receipt and never redeploys", async (t) => {
  const { options, state } = setup(t);
  state.fault = "lost response";
  await assert.rejects(deployWithJournal(options), (error) => {
    assert.match(error.message, /outcome is unknown/);
    assert.equal(
      error.message.includes(state.broadcasts[0]),
      false,
      "signed transaction must not enter errors",
    );
    return true;
  });
  state.fault = "";
  const result = await deployWithJournal(options);
  assert.equal(result.transactionHash, Transaction.from(state.broadcasts[0]).hash);
  assert.equal(state.broadcasts.length, 1);
});

test("unaccepted unknown broadcast reuses exactly the same signed bytes and nonce", async (t) => {
  const { options, state } = setup(t);
  state.fault = "not accepted";
  await assert.rejects(deployWithJournal(options), /unknown/);
  state.fault = "";
  await deployWithJournal(options);
  assert.equal(state.broadcasts.length, 2);
  assert.equal(state.broadcasts[0], state.broadcasts[1]);
});

test("confirmation timeout and delayed Mirror indexing recover without additional broadcast", async (t) => {
  for (const fault of ["timeout", "mirror"]) {
    const { options, state } = setup(t);
    state.fault = fault;
    state.mirrorFault = fault === "mirror";
    await assert.rejects(deployWithJournal(options), /pending|Mirror/);
    state.fault = "";
    state.mirrorFault = false;
    await deployWithJournal(options);
    assert.equal(state.broadcasts.length, 1);
  }
});

test("changed artifact, signer, provider or fee configuration cannot replace a prepared deployment", async (t) => {
  const { options, state } = setup(t);
  state.fault = "not accepted";
  await assert.rejects(deployWithJournal(options));
  for (const patch of [
    { bytecode: "0x60006001" },
    { runtime: "0x6001" },
    { wallet: Wallet.createRandom() },
    { accountId: "0.0.999" },
    { rpcUrl: "https://other.example" },
    { gasLimit: 99_000n },
    { maxFeeWei: 20_000_000_000n },
  ]) {
    await assert.rejects(deployWithJournal({ ...options, ...patch }), /differs|match/);
  }
  assert.equal(state.broadcasts.length, 1);
});

test("consumed nonce with no receipt is preserved, and pending unrelated nonce prevents preparation", async (t) => {
  const { options, state } = setup(t);
  state.fault = "not accepted";
  await assert.rejects(deployWithJournal(options));
  state.nonce++;
  state.pending++;
  await assert.rejects(deployWithJournal(options), /consumed or pending/);
  assert.equal(state.broadcasts.length, 1);
  const fresh = setup(t);
  fresh.state.pending++;
  await assert.rejects(deployWithJournal(fresh.options), /unresolved pending nonce/);
  assert.equal(fresh.state.broadcasts.length, 0);
});

test("reverted deployment is terminal and cannot consume another nonce on rerun", async (t) => {
  const { options, state } = setup(t);
  state.fault = "revert";
  await assert.rejects(deployWithJournal(options), /reverted/);
  await assert.rejects(deployWithJournal(options), /reverted/);
  state.receipt = null;
  await assert.rejects(deployWithJournal(options), /Previously settled/);
  assert.equal(state.broadcasts.length, 1);
});

test("concurrent deployments cannot acquire the lock during an active deployment", async (t) => {
  const { options, state } = setup(t);
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const send = options.provider.broadcastTransaction;
  options.provider.broadcastTransaction = async (raw) => {
    entered();
    await barrier;
    return send(raw);
  };
  const first = deployWithJournal(options);
  await started;
  await assert.rejects(deployWithJournal(options), /locked/);
  release();
  await first;
  assert.equal(state.broadcasts.length, 1);
});

test("real process crash releases the OS lock and preserves the exact prepared transaction", async (t) => {
  const { options, state } = setup(t);
  const moduleURL = new URL("../scripts/deployment-journal.mjs", import.meta.url).href;
  const code = `import { deployWithJournal } from ${JSON.stringify(moduleURL)};
    import { Wallet } from 'ethers';
    await deployWithJournal({ journalFile:process.env.TEST_JOURNAL, checkoutRoot:process.cwd(),
      wallet:new Wallet(process.env.TEST_KEY), accountId:'0.0.123', rpcUrl:'https://testnet.hashio.io/api',
      bytecode:'0x60006000', runtime:'0x6000', gasLimit:100000n, maxFeeWei:10000000000n,
      provider:{getNetwork:async()=>({chainId:296n}),getTransactionCount:async()=>3,
        send:async()=> '0x10',getTransactionReceipt:async()=>null,getTransaction:async()=>null,
        broadcastTransaction:async()=>{process.send('prepared');await new Promise(()=>{});}},
      confirmMirror:async()=>{throw new Error('not reached');}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_JOURNAL: options.journalFile, TEST_KEY: options.wallet.privateKey },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child did not reach durable broadcast intent")),
      5000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      assert.equal(message, "prepared");
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  await assert.rejects(deployWithJournal(options), /locked/);
  const original = JSON.parse(readFileSync(options.journalFile, "utf8").split("\n")[0]);
  child.kill("SIGKILL");
  await exit;
  await deployWithJournal(options);
  assert.equal(state.broadcasts.length, 1);
  assert.equal(state.broadcasts[0], original.signedTransaction);
  assert.equal(Transaction.from(state.broadcasts[0]).nonce, original.nonce);
});

test("wrong-chain, wrong-runtime, excessive fees and malformed private journals fail closed", async (t) => {
  const { options, state, dir } = setup(t);
  await assert.rejects(
    deployWithJournal({
      ...options,
      provider: { ...options.provider, getNetwork: async () => ({ chainId: 295n }) },
    }),
    /testnet/,
  );
  await assert.rejects(
    deployWithJournal({ ...options, maxFeeWei: 1_000_000_000_000_000_001n }),
    /bounded/,
  );
  const wrongRuntime = {
    ...options,
    provider: { ...options.provider, getCode: async () => "0xdead" },
  };
  await assert.rejects(deployWithJournal(wrongRuntime), /runtime/);
  assert.equal(state.broadcasts.length, 1);
  await deployWithJournal(options);
  assert.equal(state.broadcasts.length, 1);
  const link = join(dir, "link");
  symlinkSync(options.journalFile, link);
  await assert.rejects(deployWithJournal({ ...options, journalFile: link }), /invalid|locked/);
  chmodSync(options.journalFile, 0o640);
  await assert.rejects(deployWithJournal(options), /invalid|locked/);
  chmodSync(options.journalFile, 0o600);
  writeFileSync(options.journalFile, '{"partial":', { mode: 0o600 });
  await assert.rejects(deployWithJournal(options), /invalid|locked/);
});
