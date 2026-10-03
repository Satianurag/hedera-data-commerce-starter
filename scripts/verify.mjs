import { spawnSync } from "node:child_process";

// Argument arrays keep these commands intact when the Scaffold-HBAR CLI rewrites text files.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this check with: npm run verify");

const steps = [
  { label: "toolchain regressions", args: ["run", "test:tooling"] },
  { label: "formatting", args: ["run", "format:check"] },
  { label: "build and test", args: ["test"] },
  { label: "typecheck", args: ["run", "typecheck"] },
  { label: "lint", args: ["run", "lint"] },
  { label: "dependency tree", args: ["ls", "--all"], quiet: true },
  { label: "dependency audit", args: ["audit", "--audit-level=low"] },
];

for (const { label, args, quiet } of steps) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(process.execPath, [npm, ...args], {
    stdio: quiet ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (quiet && result.stdout) process.stdout.write(result.stdout);
    console.error(`✖ ${label} failed`);
    process.exit(result.status ?? 1);
  }
  console.log(`✔ ${label}`);
}
console.log("\nAll verification steps passed.");
