import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      obsidian: new URL("./test/stubs/obsidian.ts", import.meta.url).pathname,
    },
  },
});
