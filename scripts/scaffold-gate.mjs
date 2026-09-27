import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Reproduces the bounty gate: scaffold with the published CLI, then install,
// lint, build, boot and request the core routes of the generated project.
// Pass --remote to scaffold from GitHub instead of this working tree.
const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this with: npm run check:scaffold");
const remote = process.argv.includes("--remote");
const keep = process.argv.includes("--keep");
const cliVersion = process.env.SCAFFOLD_HBAR_CLI_VERSION ?? "0.4.0";
const templateRepo = process.env.SCAFFOLD_HBAR_TEMPLATE ?? "Satianurag/neuron-customer-app-scaffold-hbar";
const port = Number(process.env.SCAFFOLD_GATE_PORT ?? 3310);

const work = mkdtempSync(join(tmpdir(), "scaffold-gate-"));
const templateDir = join(work, "template");
const app = join(work, "neuron-app");

class GateFailure extends Error {}

function step(label, command, args, options = {}) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new GateFailure(`${label} failed`);
  console.log(`✔ ${label}`);
}

// Documented CLI post-processing: it consumes template.json, pins packageManager
// in package manifests and points Foundry at the submodules it adds under lib/.
function expectedChange(file, source, generated) {
  if (file === "template.json") return generated === undefined;
  if (generated === undefined) return false;
  if (file === "package.json" || /^packages\/[^/]+\/package\.json$/.test(file)) {
    const { packageManager, ...rest } = JSON.parse(generated.toString("utf8"));
    return packageManager?.startsWith("npm@") && JSON.stringify(rest) === JSON.stringify(JSON.parse(source.toString("utf8")));
  }
  if (file === "packages/foundry/foundry.toml") {
    return generated.toString("utf8") === source.toString("utf8").replace('libs = []', 'libs = ["lib"]');
  }
  return false;
}

function runNpm(label, args, cwd = app, env = process.env) {
  step(label, process.execPath, [npm, ...args], { cwd, env });
}

function forgeOnPath() {
  const require = createRequire(join(root, "packages", "foundry", "package.json"));
  const platform = { darwin: "darwin", linux: "linux", win32: "win32" }[process.platform];
  const arch = { arm64: "arm64", x64: "amd64" }[process.arch];
  const name = process.platform === "win32" ? "forge.exe" : "forge";
  const binary = require.resolve(`@foundry-rs/forge-${platform}-${arch}/bin/${name}`);
  const bin = join(work, "bin");
  mkdirSync(bin);
  symlinkSync(binary, join(bin, name));
  return bin;
}

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(file => file && existsSync(join(root, file)));

try {
  if (!remote) {
    for (const file of tracked) {
      mkdirSync(dirname(join(templateDir, file)), { recursive: true });
      cpSync(join(root, file), join(templateDir, file));
    }
  }
  const env = {
    ...process.env,
    PATH: `${forgeOnPath()}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    ...(remote ? {} : { CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR: templateDir }),
  };
  // The CLI refuses to run without a Git identity; CI runners have none.
  const identity = [["user.name", "Scaffold Gate"], ["user.email", "scaffold-gate@example.invalid"]]
    .filter(([key]) => spawnSync("git", ["config", key], { encoding: "utf8" }).stdout.trim() === "");
  if (identity.length) {
    const offset = Number(env.GIT_CONFIG_COUNT ?? 0);
    identity.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${offset + index}`] = key;
      env[`GIT_CONFIG_VALUE_${offset + index}`] = value;
    });
    env.GIT_CONFIG_COUNT = String(offset + identity.length);
  }
  runNpm(`scaffold with create-scaffold-hbar@${cliVersion}${remote ? ` from ${templateRepo}` : " from this checkout"}`, [
    "exec", "--yes", `--package=create-scaffold-hbar@${cliVersion}`, "--", "create-scaffold-hbar", "neuron-app",
    "--template", templateRepo, "--frontend", "nextjs-app", "--solidity-framework", "foundry",
    "--package-manager", "npm", "--network", "testnet", "--skip-install", "--skip-hedera-skills", "--yes", "--ci",
  ], work, env);

  if (!remote) {
    const changed = tracked.filter(file => {
      const source = readFileSync(join(root, file));
      const generated = existsSync(join(app, file)) ? readFileSync(join(app, file)) : undefined;
      return !generated?.equals(source) && !expectedChange(file, source, generated);
    });
    if (changed.length) throw new GateFailure(`The CLI changed or dropped ${changed.length} template file(s):\n  ${changed.join("\n  ")}`);
    console.log(`✔ All ${tracked.length} template files reached the project intact`);
  }

  runNpm("fresh install", ["ci", "--engine-strict", "--no-audit", "--no-fund"]);
  runNpm("lint", ["run", "lint"]);
  runNpm("build", ["run", "build"]);

  console.log("\n▶ boot and core routes");
  const server = spawn(process.execPath, [npm, "run", "start"], {
    cwd: app,
    env: { ...process.env, PORT: String(port), HEDERA_NETWORK: "testnet", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  const origin = `http://127.0.0.1:${port}`;
  let failures = 0;
  try {
    const deadline = Date.now() + 60_000;
    while (true) {
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(2_000) })).ok) break; } catch { /* booting */ }
      if (Date.now() > deadline) throw new Error("The generated app did not boot within 60 seconds");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const expectations = [
      ...["/", "/services", "/evidence", "/evidence?topic=0.0.10725147", "/sessions", "/reference", "/commerce"].map(path => [path, 200]),
      ...["/api/customer-auth/session", "/api/customer-funding", "/api/reference"].map(path => [path, 404]),
    ];
    for (const [path, expected] of expectations) {
      const status = (await fetch(origin + path, { signal: AbortSignal.timeout(30_000) })).status;
      const ok = status === expected;
      if (!ok) failures++;
      console.log(`${ok ? "✔" : "✖"} GET ${path} → ${status}${ok ? "" : ` (expected ${expected})`}`);
    }
  } finally {
    if (process.platform === "win32") server.kill();
    else process.kill(-server.pid, "SIGTERM");
  }
  if (failures) throw new GateFailure(`${failures} route check(s) failed`);
  console.log("\nScaffold gate passed.");
} catch (error) {
  if (!(error instanceof GateFailure)) throw error;
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
} finally {
  if (keep) console.log(`Generated project kept at ${app}`);
  else rmSync(work, { recursive: true, force: true });
}
