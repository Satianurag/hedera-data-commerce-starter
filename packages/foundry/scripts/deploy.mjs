import { createPrivateKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { deployWithJournal } from "./deployment-journal.mjs";

const network = {
  chainId: 296n,
  mirror: "https://testnet.mirrornode.hedera.com",
  rpc: "https://testnet.hashio.io/api",
};

function rpcUrl() {
  const configured = process.env.HEDERA_RPC_URL;
  const value = configured ?? network.rpc;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HEDERA_RPC_URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0
  ) {
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
  if (process.env.HEDERA_NETWORK !== "testnet")
    throw new Error("Deployment is testnet-only; mainnet writes require a separate release");
  const accountId = process.env.HEDERA_OPERATOR_ACCOUNT_ID;
  if (!/^\d+\.\d+\.\d+$/.test(accountId ?? ""))
    throw new Error("HEDERA_OPERATOR_ACCOUNT_ID must be numeric");
  const maxFee = positiveEnv("HEDERA_MAX_FEE_TINYBAR") * 10_000_000_000n;
  if (maxFee > 100_000_000n * 10_000_000_000n) throw new Error("Deployment fee cap exceeds 1 HBAR");
  const gasLimit = positiveEnv("HEDERA_CONTRACT_GAS");
  if (gasLimit > 2_000_000n) throw new Error("HEDERA_CONTRACT_GAS exceeds 2000000");
  const keyPath = process.env.HEDERA_OPERATOR_KEY_FILE;
  if (!keyPath || !isAbsolute(keyPath))
    throw new Error("HEDERA_OPERATOR_KEY_FILE requires an absolute path");
  const [keyInfo, parent] = await Promise.all([lstat(keyPath), lstat(dirname(keyPath))]);
  if (
    !keyInfo.isFile() ||
    keyInfo.isSymbolicLink() ||
    (keyInfo.mode & 0o077) !== 0 ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid && (keyInfo.uid !== process.getuid() || parent.uid !== process.getuid()))
  ) {
    throw new Error("operator key and parent directory must be owner-only");
  }
  const der = Buffer.from((await readFile(keyPath, "utf8")).trim(), "hex");
  let keyObject;
  for (const type of ["pkcs8", "sec1"]) {
    try {
      keyObject = createPrivateKey({ key: der, format: "der", type });
      break;
    } catch {
      /* Try the other DER format. */
    }
  }
  if (!keyObject) throw new Error("invalid DER private key");
  const jwk = keyObject.export({ format: "jwk" });
  if (jwk.crv !== "secp256k1" || !jwk.d || !jwk.x || !jwk.y)
    throw new Error("operator key must be ECDSA secp256k1");
  const wallet = new ethers.Wallet(`0x${Buffer.from(jwk.d, "base64url").toString("hex")}`);
  const mirrorAccount = await mirrorJson(`${network.mirror}/api/v1/accounts/${accountId}`);
  const compressedPublicKey = `${Buffer.from(jwk.y, "base64url").at(-1) & 1 ? "03" : "02"}${Buffer.from(jwk.x, "base64url").toString("hex")}`;
  if (
    mirrorAccount.account !== accountId ||
    mirrorAccount.deleted !== false ||
    mirrorAccount.key?._type !== "ECDSA_SECP256K1" ||
    mirrorAccount.key.key?.toLowerCase() !== compressedPublicKey.toLowerCase() ||
    mirrorAccount.evm_address?.toLowerCase() !== wallet.address.toLowerCase()
  ) {
    throw new Error("operator key/account/EVM address mismatch on selected network");
  }

  const selectedRpc = rpcUrl();
  const provider = new ethers.JsonRpcProvider(selectedRpc);
  if ((await provider.getNetwork()).chainId !== network.chainId)
    throw new Error("RPC chain ID mismatch");
  const artifact = JSON.parse(
    await readFile(new URL("../out/BuyerEscrow.sol/BuyerEscrow.json", import.meta.url), "utf8"),
  );
  const bytecode = artifact.bytecode?.object;
  const runtime = artifact.deployedBytecode?.object;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtime)) {
    throw new Error("invalid compiled BuyerEscrow artifact");
  }
  try {
    const result = await deployWithJournal({
      journalFile: process.env.HEDERA_DEPLOYMENT_JOURNAL_FILE,
      checkoutRoot: fileURLToPath(new URL("../../..", import.meta.url)),
      wallet,
      provider,
      accountId,
      rpcUrl: selectedRpc,
      bytecode,
      runtime,
      gasLimit,
      maxFeeWei: maxFee,
      onStatus: (message) => console.error(message),
      confirmMirror: async (address) => {
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const contract = await mirrorJson(`${network.mirror}/api/v1/contracts/${address}`);
            if (
              contract.deleted === false &&
              contract.contract_id &&
              contract.evm_address?.toLowerCase() === address.toLowerCase()
            )
              return contract;
          } catch {
            /* Mirror indexing may lag consensus; no new deployment. */
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        throw new Error(
          "RPC deployment is confirmed but Mirror indexing is delayed. Resume the same deployment journal",
        );
      },
    });
    console.log(JSON.stringify(result));
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "contract deployment failed");
  process.exitCode = 1;
});
