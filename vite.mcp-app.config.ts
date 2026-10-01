import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("./src/mcp-app/react", import.meta.url));
export default defineConfig({
  root,
  plugins: [react(), viteSingleFile()],
  build: { outDir: path.resolve(root, "../dist"), emptyOutDir: true, cssCodeSplit: false },
});
