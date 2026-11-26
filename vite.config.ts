import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = Number(env.API_PORT ?? 3001);
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: "dist/client",
      emptyOutDir: true,
      // Three.js is intentionally lazy-loaded with the scene. Split its large ESM
      // graph into cacheable chunks so no single deferred file crosses Vite's
      // default 500 kB warning threshold.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "three-core",
                test: /node_modules[\\/]three[\\/]/,
                maxSize: 380_000,
                minSize: 40_000,
                includeDependenciesRecursively: false,
                priority: 20
              },
              {
                name: "react-three",
                test: /node_modules[\\/](@react-three|three-stdlib|zustand|suspend-react|its-fine)[\\/]/,
                maxSize: 380_000,
                minSize: 40_000,
                includeDependenciesRecursively: false,
                priority: 10
              }
            ]
          }
        }
      }
    }
  };
});
