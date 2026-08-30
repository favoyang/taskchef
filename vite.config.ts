import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.join(repositoryRoot, "src/dashboard/react"),
  build: {
    outDir: path.join(repositoryRoot, "src/dashboard/dist"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunk-[hash].js",
        assetFileNames: (asset) => asset.names?.some((name) => name.endsWith(".css"))
          ? "styles.css"
          : "asset-[hash][extname]",
      },
    },
  },
});
