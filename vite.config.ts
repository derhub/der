import { defineConfig } from "vite-plus";
import { lintConfig } from "./lint.config";

export default defineConfig({
  fmt: {
    singleQuote: false,
    semi: true,
    ignorePatterns: ["dist/**", "**/dist/**", "bun.lock"],
  },
  lint: lintConfig,
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
