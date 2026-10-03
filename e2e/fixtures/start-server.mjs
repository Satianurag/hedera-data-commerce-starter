import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const auth = process.argv.includes("--auth");
const live = process.argv.includes("--live");
const state = mkdtempSync(join(tmpdir(), "neuron-browser-test-"));
chmodSync(state, 0o700);
const env = { ...process.env, HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "296",
  HEDERA_MIRROR_URL: "https://testnet.mirrornode.hedera.com",
  NEURON_LEGACY_DIRECTORY_URL: "https://explorer.neuron.world/api/v1/device/wip-all",
  NEXT_TELEMETRY_DISABLED: "1", NEURON_REOWN_PROJECT_ID: "",
  NEURON_APP_ORIGIN: `http://127.0.0.1:${process.env.PORT}`,
  NEURON_CUSTOMER_DB_FILE: join(state, "customer.sqlite"), NEURON_ALLOWED_CUSTOMER_ADDRESSES: "" };
for (const key of Object.keys(env)) if (key.startsWith("NEURON_ENABLE_")) env[key] = "false";
for (const feature of ["CUSTOMER_AUTH", "REFERENCE_COMMERCE", "LOCAL_STREAM", "REMOTE_STREAM", "CUSTOMER_REQUEST",
  "CUSTOMER_COMMERCE_REVIEW", "CUSTOMER_FUNDING", "CUSTOMER_APPROVAL"]) env[`NEURON_ENABLE_${feature}`] = "false";
env.NEURON_ENABLE_CUSTOMER_AUTH = auth ? "true" : "false";
if (!live) {
  const preload = fileURLToPath(new URL("./server-fetch.cjs", import.meta.url));
  env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
} else {
  // Clear inherited test preloads so live mode uses real network responses.
  delete env.NODE_OPTIONS;
}
const child = spawn(process.execPath, ["packages/nextjs/scripts/start.mjs"], { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  rmSync(state, { recursive: true, force: true });
  process.exitCode = signal ? 0 : (code ?? 1);
});
