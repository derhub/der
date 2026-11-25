import type { OxlintConfig } from "vite-plus/lint";

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

/** SQLite stays inside @der/storage; every other layer depends on narrow domain ports. */
const SQLITE_IMPORT = {
  name: "bun:sqlite",
  message: "Keep bun:sqlite inside packages/storage; use the domain storage ports elsewhere.",
};

const STORAGE_PACKAGE_IMPORT = {
  regex: "^@der/storage(/|$)",
  message:
    "Depend on narrow storage ports from @der/domain here; keep concrete @der/storage wiring in packages/storage and apps/server/src/main.ts.",
};

export const lintConfig: OxlintConfig = {
  ignorePatterns: ["dist/**", "**/dist/**", "node_modules/**"],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    "typescript/no-require-imports": "error",
    "typescript/no-restricted-imports": [
      "error",
      {
        paths: [SQLITE_IMPORT],
        patterns: [SRC_PATH_IMPORT, RUN_LIFECYCLE_IMPORT, STORAGE_PACKAGE_IMPORT],
      },
    ],
  },
  overrides: [
    {
      // SQLite implementation and storage migration tests own bun:sqlite directly.
      files: ["packages/storage/**"],
      rules: {
        "typescript/no-restricted-imports": [
          "error",
          { patterns: [SRC_PATH_IMPORT, RUN_LIFECYCLE_IMPORT] },
        ],
      },
    },
    {
      // The storage modules that expose the Run lifecycle through the store's own methods.
      files: [
        "packages/storage/src/runs.ts",
        "packages/storage/src/sqlite-store.ts",
        "packages/storage/src/approvals-effects.ts",
        "packages/storage/src/script-store.ts",
      ],
      rules: {
        "typescript/no-restricted-imports": ["error", { patterns: [SRC_PATH_IMPORT] }],
      },
    },
    {
      // Only the server bootstrap module and server tests wire concrete SQLite stores.
      files: ["apps/server/src/main.ts", "apps/server/test/**"],
      rules: {
        "typescript/no-restricted-imports": [
          "error",
          {
            paths: [SQLITE_IMPORT],
            patterns: [SRC_PATH_IMPORT, RUN_LIFECYCLE_IMPORT],
          },
        ],
      },
    },
  ],
};
