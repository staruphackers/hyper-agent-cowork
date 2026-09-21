import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";
import { serviceWorkerBuildIdPlugin } from "./src/lib/vite-sw-build-id";
import { readBrowserBuildCommit } from "./src/lib/vite-build-commit";
import { createI18nWrapVitePlugin } from "./i18n-tools/babel-plugin-i18n-wrap.mjs";

const apiProxy = createApiProxy();

export default defineConfig(({ mode }) => ({
  define: {
    __PAPERCLIP_BUILD_COMMIT__: JSON.stringify(
      readBrowserBuildCommit(__dirname),
    ),
  },
  plugins: [
    // Must run BEFORE react(): both declare enforce:"pre", and Vite runs
    // same-enforce plugins in array order, so this wraps translatable strings
    // in the raw TSX text before @vitejs/plugin-react's OXC-based JSX/TSX
    // transform ever sees the file. See ui/i18n-tools/babel-plugin-i18n-wrap.mjs
    // for why this is a custom plugin instead of @vitejs/plugin-react's
    // (nonexistent, in this version) `babel` option.
    createI18nWrapVitePlugin({ srcRoot: path.resolve(__dirname, "./src") }),
    react(),
    tailwindcss(),
    serviceWorkerBuildIdPlugin(),
  ],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
}));
