import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { ESLint } from "eslint";
import ts from "typescript";
import { assertScaffoldOutput } from "../scaffold-output.mjs";
import { assertPortAvailable, watchServer } from "../scaffold-server.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd: root });

test("scaffold gate rejects the CLI's nonfatal format/install errors", () => {
  assertScaffoldOutput(
    "Dependencies installed\nFormatting completed\nProject created successfully",
  );
  for (const output of [
    "Format step failed. Run npm run format",
    '\u001b[31mMissing script: "format"\u001b[0m',
    "Dependency installation failed",
  ]) {
    assert.throws(() => assertScaffoldOutput(output), /reported a failure/);
  }
});

test("scaffold gate refuses an occupied port and a child that exited or failed", async () => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = occupied.address().port;
  try {
    await assert.rejects(assertPortAvailable(port), /unavailable.*EADDRINUSE/);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
  await assertPortAvailable(port);
  for (const event of ["error", "exit"]) {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const alive = watchServer(child);
    alive();
    if (event === "error") child.emit("error", new Error("spawn failed"));
    else child.emit("exit", 1, null);
    assert.throws(alive, /spawn failed|Generated server exited/);
  }
});

test("compiler runner selects TypeScript7 while API consumers retain compatible TypeScript6", () => {
  const compiler = join(root, "scripts/tsc.mjs");
  const version = spawnSync(process.execPath, [compiler, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /Version 7\.0\.2/);
  assert.match(ts.version, /^6\./);
  assert.equal(typeof ts.transpileModule, "function");
  const work = mkdtempSync(join(tmpdir(), "neuron-compiler-test-"));
  try {
    writeFileSync(join(work, "good.ts"), "export const value: number = 42;\n");
    const good = spawnSync(process.execPath, [compiler, "good.ts", "--outDir", "dist"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(readFileSync(join(work, "dist/good.js"), "utf8"), /42/);
    writeFileSync(join(work, "bad.ts"), 'export const value: number = "bad";\n');
    const bad = spawnSync(process.execPath, [compiler, "bad.ts", "--noEmit"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /TS2322/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("default formatter writes source, preserves byte fixtures and is idempotent", () => {
  const work = mkdtempSync(join(tmpdir(), "neuron-format-test-"));
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(
      join(work, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          format: manifest.scripts.format,
          "format:check": manifest.scripts["format:check"],
        },
      }),
    );
    for (const file of [".prettierignore", ".prettierrc.json"])
      writeFileSync(join(work, file), readFileSync(join(root, file)));
    symlinkSync(join(root, "node_modules"), join(work, "node_modules"), "dir");
    const before = 'export const value={a:1,b:"two"}\n';
    writeFileSync(join(work, "example.mjs"), before);
    mkdirSync(join(work, "fixtures"));
    const exactBytes = '{ "signed":  "keep whitespace" }\n';
    writeFileSync(join(work, "fixtures", "signed.json"), exactBytes);
    mkdirSync(join(work, "testdata"));
    writeFileSync(join(work, "testdata", "signed.json"), exactBytes);
    for (const script of ["format", "format:check"]) {
      const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", script], {
        cwd: work,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    assert.notEqual(readFileSync(join(work, "example.mjs"), "utf8"), before);
    assert.equal(readFileSync(join(work, "fixtures", "signed.json"), "utf8"), exactBytes);
    assert.equal(readFileSync(join(work, "testdata", "signed.json"), "utf8"), exactBytes);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Next navigation rule retains global, computed, static-prefix and scope behavior", async () => {
  const cases = [
    ['location.assign("/services")', true],
    ['window.location["assign"]("../services")', true],
    ['globalThis.location.href = "/services"', true],
    ['document.location["href"] = `/${id}`', true],
    ['const p = "/services"; self.location.assign(p)', true],
    ['let p = "https://example.test"; p = "/" + id; location.assign(p)', true],
    ['location.assign("https://example.test/services")', false],
    ['location.href = "//example.test/services"', false],
    ['location.assign("mailto:hello@example.test")', false],
    ['function local(location) { location.assign("/services"); }', false],
    ['function local(window) { window.location.href = "/services"; }', false],
    ["location.assign(unknownDestination)", false],
    ['let p; p = p + "x"; location.assign(p)', false],
    ["let a; let b; a = b; b = a; location.assign(a)", false],
  ];
  for (const [source, expected] of cases) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/nextjs/app/lint-fixture.ts",
    });
    assert.equal(
      result.messages.some((m) => m.ruleId === "next-navigation/no-relative-location"),
      expected,
      source,
    );
  }
});

test("React Hooks and removed React19 API checks remain enabled", async () => {
  for (const [source, rule] of [
    [
      'import { useState } from "react"; export function Widget({ on }) { if (on) useState(0); return null; }',
      "react-hooks/rules-of-hooks",
    ],
    ['import { render } from "react-dom"; render(null, document.body)', "no-restricted-imports"],
    ["ReactDOM.findDOMNode(value)", "no-restricted-properties"],
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/nextjs/app/lint-fixture.tsx",
    });
    assert.ok(
      result.messages.some((m) => m.ruleId === rule),
      JSON.stringify(result.messages),
    );
  }
});

test("Oxlint checks new scopes and keeps rule exceptions local", () => {
  const work = mkdtempSync(join(root, "packages/nextjs/.lint-fixture-"));
  try {
    const cases = [
      ["shared.ts", "export const used = 1; function unused() {}", "no-unused-vars"],
      ["tooling.mjs", "export const value = /[\\x00]/;", "no-control-regex"],
      [
        "fetch.mjs",
        'fetch("https://example.test", { method: "GET", body: "payload" });',
        "no-invalid-fetch-options",
      ],
      [
        "next-script.tsx",
        'export default function Page(){return <script src="/sync.js" />}',
        "no-sync-scripts",
      ],
      [
        "next-document.tsx",
        'import Document from "next/document"; export default Document;',
        "no-document-import-in-page",
      ],
      ["accessible.tsx", "export default function Page(){return <img />}", "alt-text"],
    ];
    for (const [name, code, rule] of cases) {
      const file = join(work, name);
      writeFileSync(file, code);
      const result = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/oxlint/bin/oxlint"),
          "--disable-nested-config",
          "--config",
          join(root, ".oxlintrc.json"),
          "--format",
          "json",
          file,
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.ok(result.stdout.includes(rule), `${name}: ${result.stdout}${result.stderr}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the root lint command rejects unused code in every authored JS/TS surface", () => {
  const directories = [
    "packages/neuron-hedera/src",
    "packages/nextjs/lib",
    "scripts",
    "packages/foundry/scripts",
    "packages/neuron-reference/scripts",
    "deploy/testnet",
    "e2e",
  ];
  const files = directories.map((dir) => join(dir, `lint-negative-${process.pid}.mjs`));
  try {
    for (const file of files)
      writeFileSync(join(root, file), "function unusedRegressionSentinel() {}\n");
    const result = spawnSync(process.execPath, [join(root, "scripts/lint.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "all negative sentinels were ignored");
    for (const file of files)
      assert.ok(
        (result.stdout + result.stderr).includes(file),
        `${file} was not checked:\n${result.stdout}${result.stderr}`,
      );
  } finally {
    for (const file of files) rmSync(join(root, file), { force: true });
  }
});

test("root lint applies Hooks rules in newly added Next component directories", () => {
  const components = join(root, "packages/nextjs/components");
  mkdirSync(components, { recursive: true });
  const work = mkdtempSync(join(components, "lint-hooks-"));
  try {
    writeFileSync(
      join(work, "Bad.tsx"),
      'import { useState } from "react"; export function Widget({ enabled }) { if (enabled) useState(0); return null; }',
    );
    const result = spawnSync(process.execPath, [join(root, "scripts/lint.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "conditional Hook in components/ was ignored");
    assert.match(result.stdout + result.stderr, /react-hooks\/rules-of-hooks/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("all 21 supported Next recommended/core-web-vitals rules detect concrete violations", async () => {
  const work = mkdtempSync(join(root, "packages/nextjs/.lint-next-rules-"));
  const cases = [
    [
      "google-font-display",
      "pages/display.tsx",
      '<link href="https://fonts.googleapis.com/css?family=Open+Sans" />',
    ],
    ["google-font-preconnect", "pages/preconnect.tsx", '<link href="https://fonts.gstatic.com" />'],
    [
      "next-script-for-ga",
      "pages/ga.tsx",
      '<script src="https://www.googletagmanager.com/gtag/js?id=GA_ID" />',
    ],
    [
      "no-async-client-component",
      "app/async.tsx",
      '"use client"; export default async function Page() { return null; }',
    ],
    [
      "no-before-interactive-script-outside-document",
      "pages/before.tsx",
      'import Script from "next/script"; export default function Page() { return <Script src="/script.js" strategy="beforeInteractive" />; }',
    ],
    ["no-css-tags", "pages/css.tsx", '<link href="/style.css" rel="stylesheet" />'],
    ["no-head-element", "pages/head.tsx", "<head />"],
    ["no-html-link-for-pages", "pages/link.tsx", '<a href="/services">Services</a>'],
    ["no-img-element", "pages/img.tsx", '<img src="/x.png" alt="x" />'],
    [
      "no-page-custom-font",
      "pages/font.tsx",
      '<link href="https://fonts.googleapis.com/css?family=Open+Sans&display=swap" rel="stylesheet" />',
    ],
    [
      "no-styled-jsx-in-document",
      "styled/pages/_document.tsx",
      "<style jsx>{`body { color: red; }`}</style>",
    ],
    ["no-sync-scripts", "pages/sync.tsx", '<script src="/sync.js" />'],
    [
      "no-title-in-document-head",
      "title/pages/_document.tsx",
      'import { Head } from "next/document"; export default function Page() { return <Head><title>Wrong</title></Head>; }',
    ],
    [
      "no-typos",
      "pages/typo.tsx",
      "export const getStaticProp = () => ({}); export default function Page() { return null; }",
    ],
    [
      "no-unwanted-polyfillio",
      "pages/polyfill.tsx",
      '<script src="https://polyfill.io/v3/polyfill.min.js?features=WeakSet" />',
    ],
    [
      "inline-script-id",
      "pages/inline.tsx",
      'import Script from "next/script"; export default function Page() { return <Script>{`console.log("x")`}</Script>; }',
    ],
    ["no-assign-module-variable", "pages/module.tsx", "let module = {}; export default module;"],
    [
      "no-document-import-in-page",
      "pages/document.tsx",
      'import Document from "next/document"; export default Document;',
    ],
    [
      "no-duplicate-head",
      "duplicate/pages/_document.tsx",
      'import { Head } from "next/document"; export default function Page() { return <><Head /><Head /></>; }',
    ],
    [
      "no-head-import-in-document",
      "head-import/pages/_document.tsx",
      'import Head from "next/head"; export default Head;',
    ],
    [
      "no-script-component-in-head",
      "pages/script-head.tsx",
      'import Head from "next/head"; import Script from "next/script"; export default function Page() { return <Head><Script src="/script.js" /></Head>; }',
    ],
  ];
  try {
    for (const [rule, name, source] of cases) {
      const file = join(work, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        source.startsWith("<") ? `export default function Page(){ return (${source}); }` : source,
      );
      if (["no-head-element", "no-before-interactive-script-outside-document"].includes(rule)) {
        const [result] = await eslint.lintFiles(file);
        assert.ok(
          result.messages.some((message) => message.ruleId === `next-routing/${rule}`),
          `${rule}: ${JSON.stringify(result.messages)}`,
        );
        continue;
      }
      const result = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/oxlint/bin/oxlint"),
          "--disable-nested-config",
          "--config",
          join(root, ".oxlintrc.json"),
          "--format",
          "json",
          file,
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.ok(
        result.stdout.includes(`next(${rule})`),
        `${rule}: ${result.stdout}${result.stderr}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Next router checks ignore ancestor project names and recognize actual router paths", async () => {
  const work = mkdtempSync(join(tmpdir(), "neuron-router-test-"));
  try {
    for (const projectName of ["neuron-app", "app", "pages-project"]) {
      const project = join(work, projectName);
      mkdirSync(project);
      const checker = new ESLint({
        cwd: project,
        overrideConfigFile: join(root, "eslint.config.mjs"),
      });
      for (const [file, headFails, scriptFails] of [
        ["pages/index.tsx", true, true],
        ["src/pages/index.tsx", true, true],
        ["components/widget.tsx", true, true],
        ["components/app/widget.tsx", true, true],
        ["pages/_document.tsx", true, false],
        ["src/pages/_document.tsx", true, false],
        ["app/layout.tsx", false, false],
        ["src/app/layout.tsx", false, false],
      ]) {
        const source =
          'import Loader from "next/script"; export default function Page() { return <><head /><Loader strategy="beforeInteractive" src="/script.js" /></>; }';
        const [result] = await checker.lintText(source, {
          filePath: join(project, "packages/nextjs", file),
        });
        for (const [rule, expected] of [
          ["no-head-element", headFails],
          ["no-before-interactive-script-outside-document", scriptFails],
        ]) {
          assert.equal(
            result.messages.some((message) => message.ruleId === `next-routing/${rule}`),
            expected,
            `${projectName}/${file}: ${rule}: ${JSON.stringify(result.messages)}`,
          );
        }
      }
      for (const source of [
        'export default function Page() { return <Script strategy="beforeInteractive" />; }',
        'import Loader from "next/script"; export default function Page() { return <Loader strategy="afterInteractive" />; }',
      ]) {
        const [result] = await checker.lintText(source, {
          filePath: join(project, "packages/nextjs/pages/index.tsx"),
        });
        assert.ok(
          !result.messages.some(
            (message) =>
              message.ruleId === "next-routing/no-before-interactive-script-outside-document",
          ),
          JSON.stringify(result.messages),
        );
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
