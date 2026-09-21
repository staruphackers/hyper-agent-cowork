#!/usr/bin/env node
// ui/i18n-tools/extract.mjs
//
// Walks ui/src/**/*.{ts,tsx} (excluding i18n internals / tests / stories, same
// rules the Vite plugin uses) in "collect" mode — no files are modified — and
// writes:
//   - ui/src/i18n/source/strings.json: every translatable string found, with its
//     occurrence count, kind (jsx | attr | obj | manual | dyn | shared), and
//     first occurrence location.
//   - ui/src/i18n/source/stats.json: aggregate counts for a quick sync-drift check.
//
// As of the (a)/(b)/(c)/(d) dynamic-value wrap extension, "collect" mode on a
// ui/src file also surfaces kind "dyn" entries (see collectDynStrings in
// babel-plugin-i18n-wrap.mjs) — string/template literals anywhere in the file
// that look like UI copy, not just ones sitting in JSX-child/attribute/object-
// key position. On top of the ui/src walk, this script ALSO scans
// packages/shared/src/app-definitions/*.json (case (d): third-party app
// display copy rendered via `{app.description}` etc., wrapped at its point of
// use by the "expr" wrap machinery but never visible to a plain ui/src walk)
// and merges those in as kind "shared".
//
// Run after every upstream sync (or any time you want to see what's newly
// translatable): `node ui/i18n-tools/extract.mjs`.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFile, transformSource, collectSharedStrings } from "./babel-plugin-i18n-wrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(uiRoot, "..");
const srcRoot = path.join(uiRoot, "src");
const outDir = path.join(srcRoot, "i18n", "source");
const sharedAppDefsDir = path.join(repoRoot, "packages", "shared", "src", "app-definitions");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const allFiles = walk(srcRoot);
  const files = allFiles
    .map((f) => ({ path: f, scriptType: classifyFile(f, srcRoot) }))
    .filter((f) => f.scriptType !== null);

  const strings = new Map();
  const byKind = { jsx: 0, attr: 0, obj: 0 };
  const byDir = new Map();
  const byFile = new Map();
  const parseErrors = [];

  for (const { path: filePath, scriptType } of files) {
    const code = readFileSync(filePath, "utf8");
    const result = transformSource(code, filePath, { mode: "collect", scriptType });
    if (result.parseError) {
      parseErrors.push({ file: path.relative(uiRoot, filePath), error: result.parseError });
      continue;
    }
    if (result.matches.length === 0) continue;

    const rel = path.relative(uiRoot, filePath).split(path.sep).join("/");
    const topDir = path.relative(srcRoot, filePath).split(path.sep)[0];
    byFile.set(rel, (byFile.get(rel) ?? 0) + result.matches.length);
    byDir.set(topDir, (byDir.get(topDir) ?? 0) + result.matches.length);

    for (const match of result.matches) {
      byKind[match.kind] = (byKind[match.kind] ?? 0) + 1;
      // "expr" (case a/b/c wrap sites) has no static text — it's a runtime
      // __tv(<expression>) call, not a dictionary entry. Everything else
      // (jsx/attr/obj/manual/dyn) has a known literal value and belongs in
      // strings.json.
      if (typeof match.text !== "string") continue;
      const existing = strings.get(match.text);
      if (existing) {
        existing.count += 1;
      } else {
        strings.set(match.text, {
          count: 1,
          kind: match.kind,
          first: `${rel}:${match.line}`,
        });
      }
    }
  }

  // Case (d): third-party app-definition catalog. These live in plain JSON
  // files (packages/shared/src/app-definitions/*.json), not TS source, so
  // they're scanned separately from the ui/src walk above — see the
  // DEVIATION note on collectSharedStrings in babel-plugin-i18n-wrap.mjs.
  let sharedFilesScanned = 0;
  const sharedParseErrors = [];
  if (existsSync(sharedAppDefsDir)) {
    const sharedFiles = readdirSync(sharedAppDefsDir).filter((f) => f.endsWith(".json"));
    for (const fileName of sharedFiles) {
      const filePath = path.join(sharedAppDefsDir, fileName);
      const jsonText = readFileSync(filePath, "utf8");
      const { matches, parseError } = collectSharedStrings(jsonText);
      sharedFilesScanned += 1;
      if (parseError) {
        sharedParseErrors.push({ file: path.relative(repoRoot, filePath), error: parseError });
        continue;
      }
      if (matches.length === 0) continue;

      const rel = path.relative(uiRoot, filePath).split(path.sep).join("/");
      for (const match of matches) {
        byKind[match.kind] = (byKind[match.kind] ?? 0) + 1;
        const existing = strings.get(match.text);
        if (existing) {
          existing.count += 1;
        } else {
          // JSON has no source-position info once parsed — see the
          // collectSharedStrings deviation note for why "first" here is
          // file-only (no ":line" suffix beyond the fixed 0 collectSharedStrings
          // always reports).
          strings.set(match.text, { count: 1, kind: match.kind, first: `${rel}:${match.line}` });
        }
      }
    }
  }

  const sortedEntries = [...strings.entries()].sort(([a], [b]) => a.localeCompare(b));
  const stringsOut = Object.fromEntries(sortedEntries);

  const topFiles = [...byFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([file, count]) => ({ file, count }));

  const stats = {
    generatedAt: new Date().toISOString(),
    filesScanned: files.length,
    filesWithParseErrors: parseErrors.length,
    parseErrors,
    sharedFilesScanned,
    sharedFilesWithParseErrors: sharedParseErrors.length,
    sharedParseErrors,
    totalUniqueStrings: strings.size,
    totalOccurrences: [...strings.values()].reduce((sum, v) => sum + v.count, 0),
    byKind,
    byTopLevelDir: Object.fromEntries([...byDir.entries()].sort((a, b) => b[1] - a[1])),
    top20FilesByOccurrenceCount: topFiles,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "strings.json"), `${JSON.stringify(stringsOut, null, 2)}\n`);
  writeFileSync(path.join(outDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);

  // Keyless catalog: en.json is the identity map of every source string (key === value).
  // It is the reference `locale-validation.ts` checks other locales against (placeholder
  // parity, blocked payloads, length), so it must be regenerated together with strings.json.
  // Manual legacy entries (e.g. pre-keyless keys still referenced by App.tsx) are kept.
  const enPath = path.join(path.dirname(outDir), "locales", "en.json");
  const existingEn = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};
  const enOut = {};
  for (const [key, value] of Object.entries(existingEn)) {
    if (!(key in stringsOut)) enOut[key] = value; // legacy/manual entry, keep
  }
  for (const key of Object.keys(stringsOut)) enOut[key] = key;
  const enSorted = Object.fromEntries(Object.entries(enOut).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(enPath, `${JSON.stringify(enSorted, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(enSorted).length} entries to locales/en.json (identity catalog).`);

  console.log(`Scanned ${files.length} files (${parseErrors.length} parse errors).`);
  console.log(
    `Scanned ${sharedFilesScanned} shared app-definition files (${sharedParseErrors.length} parse errors).`,
  );
  console.log(`Found ${strings.size} unique translatable strings (${stats.totalOccurrences} occurrences).`);
  console.log("By kind:", byKind);
  console.log("By top-level src/ dir (top 10):");
  for (const [dir, count] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${dir}: ${count}`);
  }
  if (parseErrors.length > 0) {
    console.log("Parse errors (file skipped, not fatal):");
    for (const e of parseErrors) console.log(`  ${e.file}: ${e.error}`);
  }
  if (sharedParseErrors.length > 0) {
    console.log("Shared app-definition parse errors (file skipped, not fatal):");
    for (const e of sharedParseErrors) console.log(`  ${e.file}: ${e.error}`);
  }
}

main();
