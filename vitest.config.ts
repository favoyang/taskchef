import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/dashboard/react/**/*.test.{ts,tsx}"],
    setupFiles: ["src/dashboard/react/test-setup.ts"],
  },
});
