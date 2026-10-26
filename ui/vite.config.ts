import path from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";
import { serviceWorkerBuildIdPlugin } from "./src/lib/vite-sw-build-id";
import { readBrowserBuildCommit } from "./src/lib/vite-build-commit";
import { createI18nWrapVitePlugin } from "./i18n-tools/babel-plugin-i18n-wrap.mjs";

const apiProxy = createApiProxy();

function preloadIssueDetail(): Plugin {
  return {
    name: "paperclip-preload-issue-detail",
    apply: "build",
    transformIndexHtml(_html, { bundle }) {
      const issueDetail = Object.values(bundle ?? {}).find((chunk) =>
        chunk.type === "chunk" && chunk.moduleIds.some((id) => id.endsWith("/src/pages/IssueDetail.tsx")),
      );
      return issueDetail ? [{ tag: "link", attrs: { rel: "modulepreload", href: `/${issueDetail.fileName}`, crossorigin: "" }, injectTo: "head" }] : [];
    },
  };
}

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
    preloadIssueDetail(),
  ],
  build: {
    minify: "esbuild",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "board-startup", tags: ["$initial"], priority: 10 },
            { name: "issue-detail", test: /\/src\/pages\/IssueDetail\.tsx$/, priority: 5 },
          ],
        },
      },
    },
  },
  esbuild:
    mode === "production"
      ? {
          // React's component trace uses function names. Keep those useful in
          // error reports without publishing source maps or page context.
          keepNames: true,
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
