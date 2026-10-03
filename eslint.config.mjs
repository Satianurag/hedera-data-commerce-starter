import navigationRule from "./scripts/lint-rules/no-location-assign-relative-destination.mjs";
import {
  noHeadElement,
  noBeforeInteractiveScriptOutsideDocument,
} from "./scripts/lint-rules/next-router-rules.mjs";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Oxlint handles correctness and Next/React/accessibility rules; ESLint retains Hooks
// and three Next checks missing or path-sensitive in Oxlint 1.86.0.
const config = [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/next-env.d.ts",
      "**/cache/**",
      "packages/foundry/lib/**",
    ],
  },
  {
    files: ["packages/nextjs/**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        location: "readonly",
        window: "readonly",
        globalThis: "readonly",
        document: "readonly",
        self: "readonly",
      },
    },
    plugins: {
      "next-navigation": { rules: { "no-relative-location": navigationRule } },
      "next-routing": {
        rules: {
          "no-head-element": noHeadElement,
          "no-before-interactive-script-outside-document": noBeforeInteractiveScriptOutsideDocument,
        },
      },
      "react-hooks": reactHooks,
    },
    settings: { next: { rootDir: "packages/nextjs" } },
    rules: {
      "next-navigation/no-relative-location": "warn",
      "next-routing/no-head-element": "warn",
      "next-routing/no-before-interactive-script-outside-document": "warn",
      ...reactHooks.configs.recommended.rules,
      // React 19 removed these APIs. TypeScript also checks imported names.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-dom",
              importNames: ["render", "hydrate", "unmountComponentAtNode", "findDOMNode"],
              message: "Use React 19 root APIs and refs.",
            },
            {
              name: "react",
              importNames: ["createClass", "PropTypes", "DOM"],
              message: "Use current React component APIs.",
            },
            {
              name: "react-dom/server",
              importNames: ["renderToNodeStream"],
              message: "Use renderToPipeableStream.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        ...["render", "hydrate", "unmountComponentAtNode", "findDOMNode"].map((property) => ({
          object: "ReactDOM",
          property,
          message: "Use React 19 root APIs and refs.",
        })),
        ...[
          "createClass",
          "PropTypes",
          "DOM",
          "render",
          "renderComponent",
          "isValidComponent",
          "isValidClass",
          "findDOMNode",
          "unmountComponentAtNode",
          "renderComponentToString",
          "renderComponentToStaticMarkup",
          "renderToString",
          "renderToStaticMarkup",
          "addons",
        ].map((property) => ({
          object: "React",
          property,
          message: "Use current React component APIs.",
        })),
        {
          object: "ReactDOMServer",
          property: "renderToNodeStream",
          message: "Use renderToPipeableStream.",
        },
      ],
    },
  },
];

export default config;
