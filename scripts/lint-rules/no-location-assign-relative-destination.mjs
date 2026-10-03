// Adapted from @next/eslint-plugin-next 16.3.8; types/build wrapper removed and
// static-prefix traversal bounded to tolerate self-referential assignments.
// Copyright (c) 2025 Vercel, Inc. MIT; see next-rule-LICENSE.txt.
// https://github.com/vercel/next.js/blob/v16.3.8/packages/eslint-plugin-next/src/rules/no-location-assign-relative-destination.ts
import { getStringIfConstant, findVariable } from "@eslint-community/eslint-utils";

const url = "https://nextjs.org/docs/messages/no-location-assign-relative-destination";
const navigationRule = {
  meta: {
    docs: {
      description: "Prevent location navigation to internal Next.js pages.",
      recommended: true,
      url,
    },
    type: "problem",
    schema: [],
    messages: {
      noLocationAssign:
        "Do not use `{{expression}}` to navigate to internal Next.js pages. Use `redirect()` in the render phase, or `useRouter().push()` in Client Components' event handlers instead. See: " +
        url,
    },
  },
  create(context) {
    const { sourceCode } = context;
    if (!sourceCode.scopeManager) return {};
    return {
      CallExpression(node) {
        const { callee, arguments: args } = node;
        if (!isMemberExprWithNamedProperty(callee, "assign")) return;
        const root = getLocationRootIdentifier(callee.object);
        if (!root || !isGlobalReference(sourceCode, root) || args.length < 1) return;
        if (args[0].type === "SpreadElement") return;
        const value = getStaticStringPrefix(args[0], sourceCode);
        if (value !== null && !ABSOLUTE_URL_RE.test(value)) {
          context.report({
            node,
            messageId: "noLocationAssign",
            data: { expression: sourceCode.getText(callee) + "()" },
          });
        }
      },
      AssignmentExpression(node) {
        const { left, right } = node;
        if (!isMemberExprWithNamedProperty(left, "href")) return;
        const root = getLocationRootIdentifier(left.object);
        if (!root || !isGlobalReference(sourceCode, root)) return;
        const value = getStaticStringPrefix(right, sourceCode);
        if (value !== null && !ABSOLUTE_URL_RE.test(value)) {
          context.report({
            node,
            messageId: "noLocationAssign",
            data: { expression: sourceCode.getText(left) },
          });
        }
      },
    };
  },
};

const ABSOLUTE_URL_RE = /^(?:[a-z][\d+.a-z-]*:|\/\/)/i;
const GLOBAL_PREFIXES = new Set(["window", "globalThis", "document", "self"]);
function isMemberExprWithNamedProperty(expr, name) {
  if (expr.type !== "MemberExpression") return false;
  return expr.computed
    ? expr.property.type === "Literal" && expr.property.value === name
    : expr.property.type === "Identifier" && expr.property.name === name;
}
function getLocationRootIdentifier(node) {
  if (node.type === "Identifier" && node.name === "location") return node;
  if (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    GLOBAL_PREFIXES.has(node.object.name) &&
    isMemberExprWithNamedProperty(node, "location")
  )
    return node.object;
  return null;
}
function isGlobalReference(sourceCode, node) {
  const variable = sourceCode.scopeManager.scopes[0].set.get(node.name);
  if (!variable || variable.defs.length > 0) return false;
  return variable.references.some(({ identifier }) => identifier === node);
}
function getStaticStringPrefix(node, sourceCode, seen = new Set()) {
  if (seen.has(node) || seen.size >= 128) return null;
  seen.add(node);
  const constant = getStringIfConstant(node, sourceCode.getScope(node));
  if (constant !== null) return constant;
  if (node.type === "TemplateLiteral" && node.quasis.length > 0)
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  if (node.type === "BinaryExpression" && node.operator === "+")
    return getStaticStringPrefix(node.left, sourceCode, seen);
  if (node.type === "Identifier") {
    const variable = findVariable(sourceCode.getScope(node), node);
    if (!variable || variable.defs.length < 1) return null;
    const def = variable.defs[variable.defs.length - 1];
    if (def.type !== "Variable") return null;
    const readPos = node.range[0];
    let lastWriteExpr = def.node.init ?? null;
    for (const ref of variable.references) {
      if (ref.identifier.range[0] >= readPos) break;
      if (ref.isWrite() && ref.writeExpr && ref.writeExpr !== def.node.init)
        lastWriteExpr = ref.writeExpr;
    }
    if (!lastWriteExpr) return null;
    return getStaticStringPrefix(lastWriteExpr, sourceCode, seen);
  }
  return null;
}

export default navigationRule;
