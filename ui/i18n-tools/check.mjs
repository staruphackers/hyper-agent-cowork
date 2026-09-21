#!/usr/bin/env node
// ui/i18n-tools/check.mjs
//
// Coverage/quality check for the zh-TW dictionary against the current source
// string inventory (run `node ui/i18n-tools/extract.mjs` first if strings.json
// is stale — this script does not re-scan the source tree itself, it only
// compares strings.json against locales/zh-TW.json).
//
// Reports:
//   - translated / untranslated / dictionary-only ("stale") counts
//   - simplified-Chinese character leakage in the zh-TW values
//   - {{placeholder}} consistency between key and value

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(__dirname, "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(uiRoot, relPath), "utf8"));
}

// A conservative set of common Simplified-only characters (i.e. characters
// that differ from their Traditional form and are common enough that seeing
// them in a zh-TW string almost certainly means simplified text leaked in,
// e.g. via a machine-translation default or a copy-paste from zh-CN.json).
const SIMPLIFIED_ONLY_CHARS =
  "个们么这为发时来会对说学过没还开关电脑网络软设备数据应该处创删规则输设连线执";

function findSimplifiedChars(text) {
  const found = new Set();
  for (const ch of text) {
    if (SIMPLIFIED_ONLY_CHARS.includes(ch)) found.add(ch);
  }
  return [...found];
}

function interpolationTokens(text) {
  return [...text.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g)].map((m) => m[1]).sort();
}

function main() {
  let strings;
  try {
    strings = readJson("src/i18n/source/strings.json");
  } catch {
    console.error("Could not read src/i18n/source/strings.json — run `node i18n-tools/extract.mjs` first.");
    process.exitCode = 1;
    return;
  }
  const zhTW = readJson("src/i18n/locales/zh-TW.json");

  const sourceKeys = new Set(Object.keys(strings));
  const zhKeys = new Set(Object.keys(zhTW));

  const translated = [...sourceKeys].filter((k) => zhKeys.has(k));
  const untranslated = [...sourceKeys].filter((k) => !zhKeys.has(k));
  const stale = [...zhKeys].filter((k) => !sourceKeys.has(k));

  // Break translated/untranslated down by kind (jsx | attr | obj | manual |
  // dyn | shared) so a coverage regression in one collection pass doesn't
  // hide behind a healthy-looking aggregate number.
  const byKindTranslated = {};
  const byKindUntranslated = {};
  for (const k of translated) {
    const kind = strings[k]?.kind ?? "unknown";
    byKindTranslated[kind] = (byKindTranslated[kind] ?? 0) + 1;
  }
  for (const k of untranslated) {
    const kind = strings[k]?.kind ?? "unknown";
    byKindUntranslated[kind] = (byKindUntranslated[kind] ?? 0) + 1;
  }

  const simplifiedHits = [];
  for (const [key, value] of Object.entries(zhTW)) {
    const hits = findSimplifiedChars(value);
    if (hits.length > 0) simplifiedHits.push({ key, value, chars: hits });
  }

  const placeholderMismatches = [];
  for (const [key, value] of Object.entries(zhTW)) {
    const keyTokens = interpolationTokens(key);
    const valueTokens = interpolationTokens(value);
    if (keyTokens.join("") !== valueTokens.join("")) {
      placeholderMismatches.push({ key, expected: keyTokens, received: valueTokens });
    }
  }

  console.log(`Source strings: ${sourceKeys.size}`);
  console.log(`zh-TW dictionary entries: ${zhKeys.size}`);
  console.log(`Translated (present in both): ${translated.length}`);
  console.log("  By kind:", byKindTranslated);
  console.log(`Untranslated (in source, missing from zh-TW): ${untranslated.length}`);
  console.log("  By kind:", byKindUntranslated);
  console.log(`Stale (in zh-TW, no longer in source): ${stale.length}`);
  if (stale.length > 0) {
    console.log("  Stale keys:");
    for (const k of stale.slice(0, 20)) console.log(`    - ${JSON.stringify(k)}`);
    if (stale.length > 20) console.log(`    ...and ${stale.length - 20} more`);
  }

  console.log(`\nSimplified-character leakage: ${simplifiedHits.length} entries`);
  for (const hit of simplifiedHits.slice(0, 20)) {
    console.log(`  ${JSON.stringify(hit.key)} -> ${JSON.stringify(hit.value)} (chars: ${hit.chars.join(", ")})`);
  }

  console.log(`\nPlaceholder mismatches: ${placeholderMismatches.length} entries`);
  for (const m of placeholderMismatches.slice(0, 20)) {
    console.log(`  ${JSON.stringify(m.key)}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.received)}`);
  }

  if (simplifiedHits.length > 0 || placeholderMismatches.length > 0) {
    process.exitCode = 1;
  }
}

main();
