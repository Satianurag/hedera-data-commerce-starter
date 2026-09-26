import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { ethers } from "ethers";

const networks = {
  testnet: { chainId: 296n, mirror: "https://testnet.mirrornode.hedera.com", rpc: "https://testnet.hashio.io/api" },
  mainnet: { chainId: 295n, mirror: "https://mainnet.mirrornode.hedera.com" },
};

function rpcUrl(name, network) {
  const configured = process.env.HEDERA_RPC_URL;
  if (!configured && name === "mainnet") {
    throw new Error("mainnet deployment requires an explicit production HEDERA_RPC_URL");
  }
  const value = configured ?? network.rpc;
  let url;
  try { url = new URL(value); } catch { throw new Error("HEDERA_RPC_URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || url.search ||
      url.hostname === "localhost" || url.hostname.endsWith(".local") ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      (name === "mainnet" && url.hostname === "mainnet.hashio.io")) {
    throw new Error("HEDERA_RPC_URL must be a public HTTPS provider for the selected network");
  }
  return url.href;
}

function positiveEnv(name) {
  const value = process.env[name];
  if (!/^[1-9]\d*$/.test(value ?? "")) throw new Error(`${name} must be a positive integer`);
  return BigInt(value);
}

async function mirrorJson(url) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Mirror returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const name = process.env.HEDERA_NETWORK;
  const network = networks[name];
  if (!network) throw new Error("HEDERA_NETWORK must be explicitly set to testnet or mainnet");
  if (name === "mainnet" && process.env.HEDERA_ALLOW_MAINNET_WRITES !== "true") {
    throw new Error("mainnet writes require HEDERA_ALLOW_MAINNET_WRITES=true");
  }
  const accountId = process.env.HEDERA_OPERATOR_ACCOUNT_ID;
  if (!/^\d+\.\d+\.\d+$/.test(accountId ?? "")) throw new Error("HEDERA_OPERATOR_ACCOUNT_ID must be numeric");
  const maxFee = positiveEnv("HEDERA_MAX_FEE_TINYBAR") * 10_000_000_000n;
  const gasLimit = positiveEnv("HEDERA_CONTRACT_GAS");
  if (gasLimit > 2_000_000n) throw new Error("HEDERA_CONTRACT_GAS exceeds 2000000");
  const keyPath = process.env.HEDERA_OPERATOR_KEY_FILE;
  if (!keyPath || !isAbsolute(keyPath)) throw new Error("HEDERA_OPERATOR_KEY_FILE requires an absolute path");
  const [keyInfo, parent] = await Promise.all([lstat(keyPath), lstat(dirname(keyPath))]);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077) !== 0 ||
      !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      (process.getuid && (keyInfo.uid !== process.getuid() || parent.uid !== process.getuid()))) {
    throw new Error("operator key and parent directory must be owner-only");
  }
  const der = Buffer.from((await readFile(keyPath, "utf8")).trim(), "hex");
  let keyObject;
  for (const type of ["pkcs8", "sec1"]) {
    try { keyObject = createPrivateKey({ key: der, format: "der", type }); break; } catch { /* Try the other DER format. */ }
  }
  if (!keyObject) throw new Error("invalid DER private key");
  const jwk = keyObject.export({ format: "jwk" });
  if (jwk.crv !== "secp256k1" || !jwk.d || !jwk.x || !jwk.y) throw new Error("operator key must be ECDSA secp256k1");
  const wallet = new ethers.Wallet(`0x${Buffer.from(jwk.d, "base64url").toString("hex")}`);
  const mirrorAccount = await mirrorJson(`${network.mirror}/api/v1/accounts/${accountId}`);
  const compressedPublicKey = `${Buffer.from(jwk.y, "base64url").at(-1) & 1 ? "03" : "02"}${Buffer.from(jwk.x, "base64url").toString("hex")}`;
  if (mirrorAccount.account !== accountId || mirrorAccount.deleted !== false ||
      mirrorAccount.key?._type !== "ECDSA_SECP256K1" ||
      mirrorAccount.key.key?.toLowerCase() !== compressedPublicKey.toLowerCase() ||
      mirrorAccount.evm_address?.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("operator key/account/EVM address mismatch on selected network");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl(name, network));
  if ((await provider.getNetwork()).chainId !== network.chainId) throw new Error("RPC chain ID mismatch");
  const artifact = JSON.parse(await readFile(new URL("../out/BuyerEscrow.sol/BuyerEscrow.json", import.meta.url), "utf8"));
  const bytecode = artifact.bytecode?.object;
  const runtime = artifact.deployedBytecode?.object;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtime)) {
    throw new Error("invalid compiled BuyerEscrow artifact");
  }
  const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  if (gasPrice * gasLimit > maxFee) throw new Error("deployment gas budget exceeds HEDERA_MAX_FEE_TINYBAR");
  const transaction = await wallet.connect(provider).sendTransaction({ data: bytecode, gasLimit, gasPrice });
  console.error(`submitted ${transaction.hash}; awaiting receipt`);
  const receipt = await provider.waitForTransaction(transaction.hash, 1, 90_000);
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
    throw new Error(`deployment ${transaction.hash} has no successful receipt`);
  }
  const code = await provider.getCode(receipt.contractAddress);
  assert.equal(code.toLowerCase(), runtime.toLowerCase(), "deployed runtime bytecode differs from build artifact");
  let contract;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      contract = await mirrorJson(`${network.mirror}/api/v1/contracts/${receipt.contractAddress}`);
      if (contract.deleted === false && contract.contract_id && contract.evm_address?.toLowerCase() === receipt.contractAddress.toLowerCase()) break;
    } catch { /* Mirror indexing may lag consensus. */ }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  if (!contract?.contract_id || contract.deleted !== false || contract.evm_address?.toLowerCase() !== receipt.contractAddress.toLowerCase()) {
    throw new Error(`contract ${transaction.hash} confirmed by RPC but not by Mirror within 60 seconds`);
  }
  console.log(JSON.stringify({
    network: name,
    contractId: contract.contract_id,
    evmAddress: receipt.contractAddress,
    transactionHash: transaction.hash,
    runtimeSha256: createHash("sha256").update(Buffer.from(runtime.slice(2), "hex")).digest("hex"),
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "contract deployment failed");
  process.exitCode = 1;
});
