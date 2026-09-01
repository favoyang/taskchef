import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    fileParallelism: false,
    include: ["src/dashboard/react/**/*.test.{ts,tsx}"],
    pool: "forks",
    setupFiles: ["src/dashboard/react/test-setup.ts"],
  },
});
