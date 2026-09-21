// Hand-written type declarations for babel-plugin-i18n-wrap.mjs.
//
// This tsconfig has no `allowJs`, so TypeScript won't infer types for a plain
// .mjs module on its own — but it WILL pick up a sibling .d.mts file to type
// an import ending in .mjs, independent of allowJs (that's just declaration
// lookup, not JS type-checking). This file exists so ui/vite.config.ts,
// ui/vitest.config.ts, and ui/src/i18n/wrap-plugin.test.ts get real types
// instead of implicit `any` when importing the engine.

import type { Plugin } from "vite";

export type MatchKind = "jsx" | "attr" | "obj" | "manual" | "expr" | "dyn" | "shared";
export type ScriptType = "ts" | "tsx";

export interface TranslatableMatch {
  // Absent for kind "expr" (a case (a)/(b)/(c) wrap site around a non-literal
  // expression — there is no single static string value to record, only the
  // span to wrap in __tv(...)). Present for every other kind.
  text?: string;
  kind: MatchKind;
  start: number;
  end: number;
  line: number;
  wrapInBraces?: boolean;
}

export interface TransformResult {
  code: string;
  changed: boolean;
  matches: TranslatableMatch[];
  parseError: string | null;
}

export interface TransformOptions {
  mode?: "wrap" | "collect";
  objectKeys?: boolean;
  scriptType?: ScriptType;
}

export interface I18nWrapPluginOptions {
  objectKeys?: boolean;
  srcRoot: string;
}

export declare const ATTR_WHITELIST: Set<string>;
export declare const OBJ_KEY_WHITELIST: Set<string>;

export declare function normalizeJsxText(raw: string): string;
export declare function parseSource(code: string, isJsx: boolean): unknown;
export declare function classifyFile(absPath: string, srcRoot: string): ScriptType | null;
export declare function transformSource(
  code: string,
  absPath: string,
  options?: TransformOptions,
): TransformResult;
export declare function createI18nWrapVitePlugin(options: I18nWrapPluginOptions): Plugin;

export declare const SHARED_OBJ_KEY_WHITELIST: Set<string>;

/**
 * Case (a): every other string/no-interpolation-template literal in a ui/src
 * file that looks like UI copy, regardless of position — see the doc comment
 * on the .mjs implementation. Only ever produced by transformSource in
 * "collect" mode; exported separately for callers that already hold a parsed
 * AST (from `parseSource`) and want just this pass.
 */
export declare function collectDynStrings(ast: unknown): TranslatableMatch[];

export interface CollectSharedStringsResult {
  matches: TranslatableMatch[];
  parseError: string | null;
}

/**
 * Case (d): display copy inside a packages/shared/src/app-definitions/*.json
 * app-definition file (SHARED_OBJ_KEY_WHITELIST keys). Parses `jsonText` with
 * `JSON.parse`, not the Babel/TSX code path the rest of this module uses —
 * see the DEVIATION note on the .mjs implementation.
 */
export declare function collectSharedStrings(jsonText: string): CollectSharedStringsResult;
