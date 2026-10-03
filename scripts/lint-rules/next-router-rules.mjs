// Adapted from @next/eslint-plugin-next 16.3.8; types/build wrappers removed.
// Router checks use paths relative to this Next workspace: an ancestor named
// "neuron-app" or "app" must not turn a Pages Router file into an App Router file.
// Copyright (c) 2025 Vercel, Inc. MIT; see next-rule-LICENSE.txt.
// https://github.com/vercel/next.js/blob/v16.3.8/packages/eslint-plugin-next/src/rules/no-head-element.ts
// https://github.com/vercel/next.js/blob/v16.3.8/packages/eslint-plugin-next/src/rules/no-before-interactive-script-outside-document.ts
import { relative, resolve, sep } from "node:path";

function workspacePath(context) {
  const workspace = resolve(context.cwd, context.settings.next.rootDir);
  return relative(workspace, context.filename).split(sep).join("/");
}

function inAppRouter(file) {
  return file.startsWith("app/") || file.startsWith("src/app/");
}

const headUrl = "https://nextjs.org/docs/messages/no-head-element";
export const noHeadElement = {
  meta: {
    docs: { description: "Prevent usage of `<head>` outside the App Router.", url: headUrl },
    type: "problem",
    schema: [],
  },
  create(context) {
    if (inAppRouter(workspacePath(context))) return {};
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "head") return;
        context.report({
          node,
          message:
            "Do not use `<head>` element. Use `<Head />` from `next/head` instead. See: " + headUrl,
        });
      },
    };
  },
};

const scriptUrl = "https://nextjs.org/docs/messages/no-before-interactive-script-outside-document";
export const noBeforeInteractiveScriptOutsideDocument = {
  meta: {
    docs: {
      description: "Restrict beforeInteractive scripts to the App Router or custom Document.",
      url: scriptUrl,
    },
    type: "problem",
    schema: [],
  },
  create(context) {
    const file = workspacePath(context);
    if (inAppRouter(file) || /^(?:src\/)?pages\/_document\.[cm]?[jt]sx?$/.test(file)) return {};
    let scriptImportName;
    return {
      'ImportDeclaration[source.value="next/script"] > ImportDefaultSpecifier'(node) {
        scriptImportName = node.local.name;
      },
      JSXOpeningElement(node) {
        if (
          !scriptImportName ||
          node.name.type !== "JSXIdentifier" ||
          node.name.name !== scriptImportName
        )
          return;
        const strategy = node.attributes.find(
          (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === "strategy",
        );
        if (strategy?.value?.value !== "beforeInteractive") return;
        context.report({
          node,
          message:
            "`next/script`'s `beforeInteractive` strategy should not be used outside of `pages/_document.js`. See: " +
            scriptUrl,
        });
      },
    };
  },
};
