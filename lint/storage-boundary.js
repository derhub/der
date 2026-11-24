import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const STORAGE_SPECIFIER = /^@der\/storage(\/|$)/;

function staticStringValue(node) {
  if (!node) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

const noDynamicStorageImport = defineRule({
  meta: {
    type: "problem",
    messages: {
      forbidden:
        "Do not load @der/storage dynamically or via require(). Use static named imports of canonicalizeJson or fingerprintJson in workflows/scripts, or depend on @der/domain ports.",
    },
  },
  create(context) {
    function checkSpecifier(node, specifierNode) {
      const value = staticStringValue(specifierNode);
      if (value !== null && STORAGE_SPECIFIER.test(value)) {
        context.report({ node, messageId: "forbidden" });
      }
    }

    return {
      ImportExpression(node) {
        checkSpecifier(node, node.source);
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length > 0
        ) {
          checkSpecifier(node, node.arguments[0]);
        }
      },
      TSExternalModuleReference(node) {
        checkSpecifier(node, node.expression);
      },
      TSImportType(node) {
        const source =
          node.source ??
          (node.argument?.type === "TSLiteralType" ? node.argument.literal : node.argument);
        checkSpecifier(node, source);
      },
    };
  },
});

export default definePlugin({
  meta: { name: "der" },
  rules: {
    "no-dynamic-storage-import": noDynamicStorageImport,
  },
});
