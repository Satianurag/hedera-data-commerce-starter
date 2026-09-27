import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

// Mirrors the text rewrite create-scaffold-hbar applies to projects that use npm, so
// tracked files reach a new project byte-for-byte unchanged.
const textExtensions = new Set([
  ".md", ".txt", ".json", ".js", ".cjs", ".mjs", ".ts", ".mts", ".cts",
  ".yml", ".yaml", ".env", ".example", ".rc",
]);
const extraNames = new Set([".lintstagedrc.js", ".gitignore", ".prettierignore"]);
const keptSubcommands = new Set(["run", "install", "exec", "ci"]);

function rewrite(content) {
  return content
    .replace(/https:\/\/yarnpkg\.com\/?/gi, "https://www.npmjs.com/")
    .replace(/\bYarn\b/g, "npm")
    .replace(/\byarn\b/g, "npm")
    .replace(/\bnpm\s+workspace\s+(@sh\/[a-zA-Z0-9_-]+)\s+([a-zA-Z0-9:_-]+)\b/g, "npm run $2 -w $1 --")
    .replace(/\bnpm\s+install\s+--immutable\b/g, "npm install")
    .replace(/\bnpm\s+([a-zA-Z0-9:_-]+)\b/g, (match, word) => (keptSubcommands.has(word) ? match : `npm run ${word}`));
}

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];
for (const file of files) {
  if (file === ".harness" || file.startsWith(".harness/")) continue;
  if (!textExtensions.has(extname(file)) && !extraNames.has(basename(file))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const changed = rewrite(line);
    if (changed !== line) problems.push(`${file}:${index + 1}\n  - ${line.trim()}\n  + ${changed.trim()}`);
  });
}

if (problems.length) {
  console.error(`Scaffold-HBAR would rewrite ${problems.length} line(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`Scaffold text check passed for ${files.length} tracked files.`);
