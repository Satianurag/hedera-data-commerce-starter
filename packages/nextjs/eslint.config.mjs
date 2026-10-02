import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Oxlint preserves React, accessibility and import checks without ESLint 9-only plugins.
export default [
  { ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"] },
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      // React 19 removed these APIs. TypeScript also checks imported names.
      "no-restricted-imports": ["error", { paths: [
        { name: "react-dom", importNames: ["render", "hydrate", "unmountComponentAtNode", "findDOMNode"], message: "Use React 19 root APIs and refs." },
        { name: "react", importNames: ["createClass", "PropTypes", "DOM"], message: "Use current React component APIs." },
        { name: "react-dom/server", importNames: ["renderToNodeStream"], message: "Use renderToPipeableStream." },
      ] }],
      "no-restricted-properties": ["error",
        ...["render", "hydrate", "unmountComponentAtNode", "findDOMNode"].map(property => ({ object: "ReactDOM", property, message: "Use React 19 root APIs and refs." })),
        ...["createClass", "PropTypes", "DOM", "render", "renderComponent", "isValidComponent", "isValidClass", "findDOMNode", "unmountComponentAtNode", "renderComponentToString", "renderComponentToStaticMarkup", "renderToString", "renderToStaticMarkup", "addons"].map(property => ({ object: "React", property, message: "Use current React component APIs." })),
        { object: "ReactDOMServer", property: "renderToNodeStream", message: "Use renderToPipeableStream." },
      ],
    },
  },
];
