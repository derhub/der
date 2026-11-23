import path from "node:path";
import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const webRoot = import.meta.dirname;

export default defineConfig(() => {
  const apiProxyTarget = process.env["DER_API_PROXY_TARGET"] ?? "http://127.0.0.1:3000";

  return {
    plugins: [
      stylex.vite({
        useCSSLayers: true,
        dev: process.env.NODE_ENV === "development",
        runtimeInjection: false,
      }),
      react(),
    ],
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
    test: {
      environment: "happy-dom",
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
