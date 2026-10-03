import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/sessions/selection.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = { exports: {}, URLSearchParams };
vm.runInNewContext(compiled, context);
const { selectedSeller, assertSelectedSeller } = context.exports;

test("absent selection retains configured gateway and exact selection matches", () => {
  assert.equal(selectedSeller(""), null);
  assert.equal(selectedSeller("?other=value"), null);
  assert.doesNotThrow(() => assertSelectedSeller(null, "0.0.4318411"));
  assert.equal(selectedSeller("?seller=0.0.4318411"), "0.0.4318411");
  assert.doesNotThrow(() => assertSelectedSeller("0.0.4318411", "0.0.4318411"));
});
test("malformed and duplicate seller query parameters fail closed", () => {
  for (const query of [
    "?seller=",
    "?seller=0.0.0",
    "?seller=0.0.01",
    "?seller=mainnet",
    "?seller=0.0.1%20",
    "?seller=0.0.1&seller=0.0.1",
    "?seller=0.0.1&seller=0.0.2",
    "?seller=0.0.12345678901234567890",
  ]) {
    assert.throws(() => selectedSeller(query), /Invalid seller selection/);
  }
});
test("different or malformed ticket sellers cannot satisfy navigation intent", () => {
  assert.throws(() => assertSelectedSeller("0.0.1", "0.0.2"), /another seller/);
  assert.throws(() => assertSelectedSeller(null, "0.0.02"), /malformed/);
});
