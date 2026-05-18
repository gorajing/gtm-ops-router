import { defineConfig } from "vitest/config";

// src/ uses NodeNext ".js" import specifiers (required by tsc + tsx at
// runtime). Vite/Vitest doesn't rewrite ".js"->".ts" by default, so strip the
// extension on relative imports and let Vitest resolve the .ts source.
// (`node:sqlite` is loaded via createRequire in src/store.ts so no bundler
// config is needed for the experimental builtin.)
export default defineConfig({
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
