import { defineConfig } from "vite-plus";

const SRC_PATH_IMPORT = {
  regex: "(^|/)src(/|$)",
  message:
    "Do not import through a src path. Import a package by name (@der/<pkg>[/<entry>]), apps/server by its #-prefixed imports map, and apps/web by the @/ alias.",
};

/** Only the Run lifecycle sets a Run's status or writes its terminal chunk. */
const RUN_LIFECYCLE_IMPORT = {
  regex: "(^|/)run-lifecycle(\\.ts)?$",
  message:
    "Only the Run lifecycle sets a Run's status or writes its terminal chunk. Go through the store (startRun via markRunRunning, finishRun, requestApproval, decide) instead of importing run-lifecycle.",
};

export default defineConfig({
  fmt: {
    singleQuote: false,
    semi: true,
    ignorePatterns: ["dist/**", "**/dist/**", "bun.lock"],
  },
  lint: {
    ignorePatterns: ["dist/**", "**/dist/**", "node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "no-restricted-imports": ["error", { patterns: [SRC_PATH_IMPORT, RUN_LIFECYCLE_IMPORT] }],
    },
    overrides: [
      {
        // The storage modules that expose the Run lifecycle through the store's own methods.
        files: [
          "packages/storage/src/runs.ts",
          "packages/storage/src/sqlite-store.ts",
          "packages/storage/src/approvals-effects.ts",
          "packages/storage/src/script-store.ts",
        ],
        rules: {
          "no-restricted-imports": ["error", { patterns: [SRC_PATH_IMPORT] }],
        },
      },
    ],
  },
  pack: {
    entry: {
      index: "src/index.ts",
      "schemas/index": "src/schemas/index.ts",
      "schemas/memory": "src/schemas/memory.ts",
      "interfaces/index": "src/interfaces/index.ts",
      "interfaces/memory": "src/interfaces/memory.ts",
      "protocol/index": "src/protocol/index.ts",
      "compiled/index": "src/compiled/index.ts",
    },
    format: ["esm"],
    dts: true,
    clean: true,
    platform: "neutral",
    outDir: "dist",
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
});
