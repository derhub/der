import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type PluginOption } from "vite-plus";

const repoRoot = import.meta.dirname;
const webRoot = path.resolve(repoRoot, "apps/web");

function isWebWorkspace(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return resolved === webRoot || resolved.startsWith(`${webRoot}${path.sep}`);
}

async function loadWebPlugins(): Promise<PluginOption[]> {
  const webRequire = createRequire(path.resolve(webRoot, "package.json"));
  const reactUrl = pathToFileURL(webRequire.resolve("@vitejs/plugin-react")).href;
  const tailwindUrl = pathToFileURL(webRequire.resolve("@tailwindcss/vite")).href;
  const [reactMod, tailwindMod] = (await Promise.all([import(reactUrl), import(tailwindUrl)])) as [
    { readonly default: () => PluginOption },
    { readonly default: () => PluginOption },
  ];
  return [reactMod.default(), tailwindMod.default()];
}

export default defineConfig(async () => {
  const inWeb = isWebWorkspace(process.cwd());
  const apiProxyTarget = process.env["DER_API_PROXY_TARGET"] ?? "http://127.0.0.1:3000";
  const webPlugins = inWeb ? await loadWebPlugins() : [];

  return {
    ...(inWeb
      ? {
          plugins: webPlugins,
          resolve: {
            alias: {
              "@": path.resolve(webRoot, "src"),
            },
          },
          server: {
            host: "127.0.0.1",
            port: 5173,
            strictPort: true,
            proxy: {
              "/api": {
                target: apiProxyTarget,
                changeOrigin: false,
              },
              "/healthz": {
                target: apiProxyTarget,
                changeOrigin: false,
              },
            },
          },
          build: {
            outDir: "dist",
            emptyOutDir: true,
          },
        }
      : {}),
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
    test: inWeb
      ? {
          environment: "happy-dom",
          include: ["test/**/*.test.{ts,tsx}"],
          setupFiles: ["./test/setup.ts"],
        }
      : {
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
  };
});
