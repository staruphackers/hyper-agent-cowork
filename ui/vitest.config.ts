import path from "path";
import { defineConfig } from "vitest/config";
import { createI18nWrapVitePlugin } from "./i18n-tools/babel-plugin-i18n-wrap.mjs";

export default defineConfig({
  // Applies the same build-time string-wrapping the real Vite build gets (see
  // vite.config.ts). This means existing component tests exercise the exact
  // wrapped source, not a pristine copy that happens to diverge — and they
  // stay green because __t(x) === x for every string under the default "en"
  // locale (nothing in en.json overrides a key to a different value).
  plugins: [createI18nWrapVitePlugin({ srcRoot: path.resolve(__dirname, "./src") })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    css: { include: [/motion-tokens\.css/] },
    setupFiles: ["./vitest.setup.ts"],
  },
});
