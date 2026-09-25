// ui/i18n-tools/babel-plugin-i18n-wrap.mjs
//
// Build-time string-wrapping engine for the繁中化 (Traditional Chinese) i18n system.
//
// IMPORTANT DEVIATION FROM THE ORIGINAL SPEC — read this before touching anything:
//
// The original design called for this to be a real "Babel plugin" (`api(babel)` /
// visitor object) wired into `@vitejs/plugin-react`'s `babel.plugins` option. That
// design does not work in this repo as of `@vitejs/plugin-react@6.1.1`:
//
//   - `@vitejs/plugin-react@6.1.1` dropped Babel entirely. Its JSX/TSX transform is
//     now OXC-based (`oxc-transform-react`); `@babel/core` only appears in ITS
//     `devDependencies` (used to build the plugin itself), never as a runtime dep.
//     Its `Options` type has no `babel` field at all — confirmed by reading
//     `node_modules/@vitejs/plugin-react/dist/index.d.ts` after install.
//   - `typescript@7.0.2` (this repo's pinned TS) is the native/Go-rewrite preview.
//     It has no classic `ts.createSourceFile` / `ts.transform` / `ts.createPrinter`
//     API — only an "unstable" RPC-based AST surface meant for language-service
//     tooling, unsuitable for a synchronous single-file source transform.
//   - No package in this workspace declares `@babel/core`, `@babel/parser`,
//     `@babel/types`, or `@babel/generator` as an explicit dependency, so plain
//     `require("@babel/parser")` fails from `ui/` (pnpm's strict phantom-dependency
//     isolation). They DO exist deep in the workspace's `.pnpm` virtual store as
//     transitive dependencies of Storybook's toolchain (`react-docgen`, the legacy
//     `@vitejs/plugin-react@4.7.0` Storybook pins internally, etc.) — real, resolved
//     packages, just not directly reachable via normal module resolution from `ui/`.
//
// Adding `@babel/parser` etc. as explicit devDependencies was out of scope (task
// rule: no new dependencies). So this module resolves `@babel/parser` defensively
// from the pnpm store at runtime (see `resolveBabelParser` below) instead of adding
// a dependency or hand-rolling a full JS/TSX tokenizer. It only needs the parser —
// no `@babel/traverse`/`@babel/types`/`@babel/generator` — because the transform is
// span-based source splicing (parse → collect `{start, end, replacement}` edits from
// accurate node offsets → splice the ORIGINAL source text), not AST regeneration.
// This has the added benefit of leaving untouched code byte-for-byte identical
// (no reformatting risk from a printer).
//
// KNOWN RISK (documented in README too): if a future `pnpm install` removes Babel
// from the dependency graph entirely (e.g. Storybook migrates off `react-docgen`),
// `resolveBabelParser()` will throw a clear, actionable error. The fix at that point
// is to add `@babel/parser` as an explicit `ui/package.json` devDependency.

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// Babel parser resolution (see module doc comment above for why this is needed).
// -----------------------------------------------------------------------------

let cachedParse;

function findWorkspaceRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `i18n-wrap: could not find workspace root (pnpm-workspace.yaml) walking up from ${startDir}`,
  );
}

function resolveFromPnpmStore(packageName) {
  const root = findWorkspaceRoot(__dirname);
  const storeDir = path.join(root, "node_modules", ".pnpm");
  if (!existsSync(storeDir)) {
    throw new Error(`i18n-wrap: no pnpm store at ${storeDir}; run pnpm install first`);
  }
  // pnpm store folder names look like "@babel+parser@7.29.8" (scope slash -> "+"),
  // optionally suffixed with "_<peerDep>@<version>_..." for packages with peer deps.
  // We don't care which peer-suffixed variant we get — any resolved copy of the
  // package works for pure parsing, so pick the shortest (least peer-suffixed,
  // most "canonical") match.
  const prefix = `${packageName.replace(/\//g, "+")}@`;
  const candidates = readdirSync(storeDir).filter((entry) => entry.startsWith(prefix));
  if (candidates.length === 0) {
    throw new Error(
      `i18n-wrap: could not find "${packageName}" anywhere in the pnpm store (${storeDir}). ` +
        `It is normally pulled in transitively via Storybook's toolchain (react-docgen). ` +
        `If that chain changed, add "${packageName}" as an explicit ui/package.json devDependency ` +
        `and update this resolver.`,
    );
  }
  candidates.sort((a, b) => a.length - b.length);
  const pkgDir = path.join(storeDir, candidates[0], "node_modules", packageName);
  const pkgJson = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJson)) {
    throw new Error(`i18n-wrap: resolved candidate ${pkgDir} has no package.json`);
  }
  return createRequire(pkgJson)(packageName);
}

function getBabelParse() {
  if (cachedParse) return cachedParse;
  // Try plain resolution first (works if a future refactor makes @babel/parser a
  // first-class dependency; the pnpm-store fallback keeps working either way).
  let parserModule;
  try {
    parserModule = createRequire(import.meta.url)("@babel/parser");
  } catch {
    parserModule = resolveFromPnpmStore("@babel/parser");
  }
  cachedParse = parserModule.parse;
  return cachedParse;
}

export function parseSource(code, isJsx) {
  const parse = getBabelParse();
  return parse(code, {
    sourceType: "module",
    allowImportExportEverywhere: false,
    // Deliberately no "decorators-legacy"/"classProperties"/etc: this repo's tsconfig
    // targets ES2023 with isolatedModules, and scanning ~1,675 files should stay on
    // the well-trodden path. A parse failure on an unusual file is caught by the
    // caller and that single file is skipped (with a warning), not fatal.
    plugins: isJsx ? ["jsx", "typescript"] : ["typescript"],
  });
}

// -----------------------------------------------------------------------------
// File selection (shared by the Vite plugin, extract.mjs, and check.mjs).
// -----------------------------------------------------------------------------

const EXCLUDE_RELATIVE_PREFIXES = ["i18n/", "lib/vite-"];

export function classifyFile(absPath, srcRoot) {
  if (!absPath.endsWith(".ts") && !absPath.endsWith(".tsx")) return null;
  if (absPath.endsWith(".d.ts")) return null;
  const rel = path.relative(srcRoot, absPath).split(path.sep).join("/");
  if (rel.startsWith("..")) return null; // outside src/
  if (/\.test\./.test(rel)) return null;
  if (/\.stories\./.test(rel)) return null;
  if (rel.split("/").includes("__tests__")) return null;
  if (EXCLUDE_RELATIVE_PREFIXES.some((prefix) => rel.startsWith(prefix))) return null;
  return absPath.endsWith(".tsx") ? "tsx" : "ts";
}

// -----------------------------------------------------------------------------
// Matching rules.
// -----------------------------------------------------------------------------

export const ATTR_WHITELIST = new Set([
  "title",
  "placeholder",
  "label",
  "description",
  "aria-label",
  "aria-description",
  "alt",
  "tooltip",
  "helperText",
  "emptyMessage",
  "emptyText",
  "confirmText",
  "cancelText",
  "heading",
  "subtitle",
  "caption",
  "message",
  "hint",
  "summary",
]);

export const OBJ_KEY_WHITELIST = new Set([
  "label",
  "title",
  "description",
  "placeholder",
  "tooltip",
  "heading",
  "subtitle",
  "helperText",
  "emptyMessage",
  "confirmText",
  "cancelText",
]);

function countLetters(text) {
  const matches = text.match(/[A-Za-z]/g);
  return matches ? matches.length : 0;
}

function qualifiesAsTranslatable(text) {
  if (text.length === 0 || countLetters(text) < 2) return false;
  // Guard against two classes of real false positives found scanning this
  // codebase: multi-line embedded content (almost always a JSON/code example
  // living in a `placeholder`, not UI copy) and `{{double-brace}}` template
  // tokens (naming-pattern defaults like "{{issue.identifier}}-{{slug}}",
  // not natural language).
  if (text.includes("\n") || text.includes("{{")) return false;
  return true;
}

function qualifiesAsObjectValue(text) {
  if (!/^[A-Z]/.test(text)) return false;
  if (text.includes("/") || text.includes("_") || text.includes("{")) return false;
  if (text.includes("\n")) return false;
  // A single capitalized word (`label: "Unread"`, `label: "Images"`) is how
  // tab/filter/segment labels are written in option arrays. Identifier-ish
  // values under the same keys are lowercase (`value: "mine"`) or contain
  // `_`/`/`, so this stays selective.
  if (qualifiesAsShortLabel(text)) return true;
  if (!(text.includes(" ") || text.length >= 12)) return false;
  return true;
}

// One capitalized English word, 3+ letters: "Connect", "Reconnect", "Mine".
// Used for object-literal display keys and for the literal branches of
// ternary / `||` / `??` expressions sitting in a JSX child or whitelisted
// attribute position (those are wrapped at runtime with __tv(...), so the
// literal only needs to reach the string inventory to become translatable).
function qualifiesAsShortLabel(text) {
  return /^[A-Z][a-z]{2,}$/.test(text);
}

// Walks a ternary / logical expression and returns its string-literal (or
// expression-free template) leaves. Only leaves that `collectDynStrings`
// would NOT already harvest (single words without spaces/punctuation) are
// returned, so extract.mjs never double-counts an occurrence.
function collectBranchLiterals(expr, out = []) {
  if (!expr) return out;
  switch (expr.type) {
    case "ConditionalExpression":
      collectBranchLiterals(expr.consequent, out);
      collectBranchLiterals(expr.alternate, out);
      break;
    case "LogicalExpression":
      collectBranchLiterals(expr.left, out);
      collectBranchLiterals(expr.right, out);
      break;
    case "StringLiteral":
      if (qualifiesAsShortLabel(expr.value) && !looksLikeUiCopyText(expr.value)) {
        out.push({ text: expr.value, start: expr.start, end: expr.end, line: expr.loc?.start.line ?? 0 });
      }
      break;
    case "TemplateLiteral": {
      if (expr.expressions.length === 0 && expr.quasis.length === 1) {
        const raw = expr.quasis[0].value.cooked ?? expr.quasis[0].value.raw;
        if (typeof raw === "string" && qualifiesAsShortLabel(raw) && !looksLikeUiCopyText(raw)) {
          out.push({ text: raw, start: expr.start, end: expr.end, line: expr.loc?.start.line ?? 0 });
        }
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Dynamic-value wrap heuristics (cases a/b/c: variables, ternaries, and other
// non-literal expressions in JSX-child / whitelisted-attribute position).
// These sites cannot be wrapped with `__t("...")` (the value isn't a literal
// string known at build time) — they get wrapped with `__tv(<expression>)`
// instead, a runtime-safe pass-through translate (see ui/src/i18n/index.ts).
// -----------------------------------------------------------------------------

// Elements whose children are never natural-language UI copy (code samples,
// raw markup, form controls that echo user input) — skip wrapping expression
// children anywhere under these tags.
const DYN_EXCLUDED_PARENT_TAGS = new Set(["code", "pre", "kbd", "samp", "script", "style", "textarea"]);

// Callees that clearly already return a rendered/formatted value (or ARE the
// translation call itself) — wrapping their result a second time is either
// redundant (`t`/`__t`/`__tv`/`String`/`formatX`) or actively wrong (`.map`/
// `.filter`/`.join`, which return an array or an already-joined string of
// OTHER things, not a single piece of UI copy).
const DYN_EXCLUDED_CALLEE_NAMES = new Set(["t", "__t", "__tv", "String"]);
const DYN_EXCLUDED_CALLEE_PROPERTIES = new Set(["map", "filter", "join"]);

function isFormatterName(name) {
  return typeof name === "string" && /^format/i.test(name);
}

function calleeIsExcludedForDyn(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier") {
    return DYN_EXCLUDED_CALLEE_NAMES.has(callee.name) || isFormatterName(callee.name);
  }
  if (
    (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    const propName = callee.property.name;
    return (
      DYN_EXCLUDED_CALLEE_PROPERTIES.has(propName) ||
      DYN_EXCLUDED_CALLEE_NAMES.has(propName) ||
      isFormatterName(propName)
    );
  }
  return false;
}

/**
 * Decides whether a non-literal JSX-child or attribute expression is worth
 * wrapping in `__tv(...)`. Deliberately permissive by design (see the task
 * note in the module this ships with): `__tv` is an identity function for
 * every non-string value, so wrapping an expression that never evaluates to
 * a string is harmless — just a few extra bytes and a no-op function call at
 * runtime. Only a few shapes are excluded outright: things that plainly
 * return further JSX/render output (`<Foo/>`, `<>...</>`, an inline
 * arrow/function render-prop, `.map`/`.filter`/`.join` list-rendering calls),
 * already-wrapped translation calls, and bare string literals (kept
 * deliberately untouched in child position — see the README's documented
 * `{"already wrapped"}` limitation, which this does not change).
 */
function qualifiesForDynWrap(expr) {
  switch (expr.type) {
    case "JSXElement":
    case "JSXFragment":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "StringLiteral":
      return false;
    case "CallExpression":
    case "OptionalCallExpression":
      return !calleeIsExcludedForDyn(expr.callee);
    default:
      return true;
  }
}

function jsxOpeningTagName(jsxElement) {
  const name = jsxElement.openingElement && jsxElement.openingElement.name;
  if (!name) return null;
  return name.type === "JSXIdentifier" ? name.name : null;
}

// Port of the well-known JSX text normalization algorithm (the same one Babel's
// `cleanJSXElementLiteralChild` and the JSX runtime itself use): whitespace-only
// lines collapse away, interior line breaks + their surrounding indentation
// collapse to a single space, and a genuinely single-line run keeps its literal
// leading/trailing spaces exactly as written. This makes the extracted string
// identical to what React would have rendered as a literal JSX text child, so
// wrapping with `{__t(sameString)}` cannot change layout.
export function normalizeJsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmptyLine = i;
  }
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, " ");
    const isFirstLine = i === 0;
    const isLastLine = i === lines.length - 1;
    const isLastNonEmptyLine = i === lastNonEmptyLine;
    if (!isFirstLine) line = line.replace(/^ +/, "");
    if (!isLastLine) line = line.replace(/ +$/, "");
    if (line) {
      if (!isLastNonEmptyLine) line += " ";
      out += line;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Core walk: collect matches (+ edits when mode === "wrap") from a parsed AST.
// -----------------------------------------------------------------------------

function jsxAttrName(nameNode) {
  if (nameNode.type === "JSXIdentifier") return nameNode.name;
  if (nameNode.type === "JSXNamespacedName") {
    return `${nameNode.namespace.name}:${nameNode.name.name}`;
  }
  return null;
}

function propKeyName(keyNode) {
  if (keyNode.type === "Identifier") return keyNode.name;
  if (keyNode.type === "StringLiteral") return keyNode.value;
  return null;
}

/**
 * Walks the AST once, calling `onMatch({ text, kind, start, end, line })` for every
 * string that qualifies for wrapping. `kind` is one of "jsx" | "attr" | "obj".
 * `start`/`end` are the byte offsets of the SOURCE SPAN to replace (the whole
 * JSXText node, the attribute's value node, or the property's value node) — NOT
 * necessarily the same as the raw text bounds (e.g. a StringLiteral's start/end
 * includes the quotes, which is exactly what we want to splice over).
 */
function walk(ast, { objectKeys, onMatch }) {
  const seenAlready = new WeakSet();

  function visit(node, parent) {
    if (!node || typeof node.type !== "string" || seenAlready.has(node)) return;

    switch (node.type) {
      case "JSXText": {
        const normalized = normalizeJsxText(node.value);
        if (qualifiesAsTranslatable(normalized)) {
          onMatch({
            text: normalized,
            kind: "jsx",
            start: node.start,
            end: node.end,
            line: node.loc?.start.line ?? 0,
            // A JSXText child becomes a JSXExpressionContainer child when replaced —
            // JSX requires braces around any non-literal-text child expression.
            wrapInBraces: true,
          });
        }
        break;
      }
      case "JSXAttribute": {
        const attrName = jsxAttrName(node.name);
        if (attrName && ATTR_WHITELIST.has(attrName) && node.value) {
          let literal = null;
          let wrapInBraces = false;
          if (node.value.type === "StringLiteral") {
            // Bare form: title="Save changes". __t(...) is not valid JSX attribute
            // syntax without braces, so the replacement must add them: title={__t(...)}.
            literal = node.value;
            wrapInBraces = true;
          } else if (
            node.value.type === "JSXExpressionContainer" &&
            node.value.expression.type === "StringLiteral"
          ) {
            // Already-braced form: title={"Save changes"}. Braces already exist in the
            // source outside this span, so only the inner literal is replaced.
            literal = node.value.expression;
            wrapInBraces = false;
          }
          if (literal && qualifiesAsTranslatable(literal.value)) {
            onMatch({
              text: literal.value,
              kind: "attr",
              start: literal.start,
              end: literal.end,
              line: literal.loc?.start.line ?? 0,
              wrapInBraces,
            });
            seenAlready.add(literal);
          } else if (
            node.value.type === "JSXExpressionContainer" &&
            node.value.expression.type !== "StringLiteral" &&
            node.value.expression.type !== "JSXEmptyExpression" &&
            qualifiesForDynWrap(node.value.expression)
          ) {
            // Case (b): a whitelisted attribute holding a non-literal expression,
            // e.g. title={iconOnly ? (n > 0 ? `Filters: ${n}` : "Filter") : undefined}.
            // Wrapped at runtime with __tv(...) instead of build-time __t("...") —
            // braces already exist in the source, so this only inserts the call
            // around the expression, it does not add/move any braces.
            //
            // Deliberately NOT added to seenAlready: unlike a StringLiteral
            // literal (a leaf with nothing further to explore), this expr can
            // be an arbitrarily deep subtree (a ternary whose branches render
            // JSX elements with their own translatable text/attributes, for
            // instance). seenAlready short-circuits visit()'s recursion into
            // a node entirely, so marking it here would silently stop the
            // walk from ever finding jsx/attr/obj/manual/expr matches nested
            // inside it — the two insertion edits (around expr.start/expr.end)
            // and any nested edits compose correctly via the same span-splice
            // pass regardless, so there is no double-wrap risk to guard against.
            const expr = node.value.expression;
            onMatch({
              kind: "expr",
              start: expr.start,
              end: expr.end,
              line: expr.loc?.start.line ?? 0,
            });
            for (const leaf of collectBranchLiterals(expr)) onMatch({ kind: "dyn", ...leaf });
          }
        }
        break;
      }
      case "JSXExpressionContainer": {
        // Case (c): a JSX child that is an expression, e.g. `<h1>{pageTitle}</h1>`
        // or `{connector.description}`. Only handled when this container is a
        // direct CHILD of a JSXElement/JSXFragment (not an attribute value — those
        // are handled above, in the JSXAttribute case, which requires the attr
        // name to be whitelisted; a plain JSXExpressionContainer visited here has
        // no such name to check, so attribute containers are deliberately left to
        // fall through this guard untouched).
        if (!parent || (parent.type !== "JSXElement" && parent.type !== "JSXFragment")) break;
        const expr = node.expression;
        if (!expr || expr.type === "JSXEmptyExpression") break;
        if (parent.type === "JSXElement") {
          const tagName = jsxOpeningTagName(parent);
          if (tagName && DYN_EXCLUDED_PARENT_TAGS.has(tagName)) break;
        }
        if (!qualifiesForDynWrap(expr)) break;
        onMatch({
          kind: "expr",
          start: expr.start,
          end: expr.end,
          line: expr.loc?.start.line ?? 0,
        });
        // `{prev ? "Reconnect" : "Connect"}`: the ternary is __tv-wrapped at
        // runtime; its single-word literal branches would otherwise never reach
        // the inventory (collectDynStrings requires a space or punctuation).
        for (const leaf of collectBranchLiterals(expr)) onMatch({ kind: "dyn", ...leaf });
        // Deliberately NOT added to seenAlready — see the matching comment in
        // the JSXAttribute case above; the walk must still descend into this
        // expression to find nested matches (e.g. `{cond ? <div title="X">Y</div> : null}`
        // wraps the whole ternary in __tv(...) AND still wraps "X"/"Y" with __t(...)).
        break;
      }
      case "CallExpression": {
        // Not a wrap target — these are already-correct manual `t("...")` /
        // `__t("...")` calls (e.g. the 4 pre-existing legacy calls in App.tsx).
        // Recorded as kind "manual" purely so extract.mjs's coverage stats and
        // check.mjs's "stale key" detection don't misreport them as unused —
        // never turned into an edit (see transformSource below), so re-running
        // wrap mode can never double-wrap one of these into `t(t("..."))`.
        const callee = node.callee;
        if (
          callee &&
          callee.type === "Identifier" &&
          (callee.name === "t" || callee.name === "__t") &&
          node.arguments.length > 0 &&
          node.arguments[0].type === "StringLiteral" &&
          qualifiesAsTranslatable(node.arguments[0].value)
        ) {
          onMatch({
            text: node.arguments[0].value,
            kind: "manual",
            start: node.arguments[0].start,
            end: node.arguments[0].end,
            line: node.arguments[0].loc?.start.line ?? 0,
          });
        }
        break;
      }
      case "ObjectProperty": {
        if (
          objectKeys &&
          !node.computed &&
          node.value.type === "StringLiteral"
        ) {
          const keyName = propKeyName(node.key);
          if (keyName && OBJ_KEY_WHITELIST.has(keyName) && qualifiesAsObjectValue(node.value.value)) {
            onMatch({
              text: node.value.value,
              kind: "obj",
              start: node.value.start,
              end: node.value.end,
              line: node.value.loc?.start.line ?? 0,
            });
            seenAlready.add(node.value);
          }
        }
        break;
      }
      default:
        break;
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item.type === "string") visit(item, node);
        }
      } else if (value && typeof value.type === "string") {
        visit(value, node);
      }
    }
  }

  visit(ast.program, null);
}

// -----------------------------------------------------------------------------
// Collect-mode extra passes: kind "dyn" and kind "shared".
//
// These do NOT feed the wrap transform (nothing about them ever produces an
// edit) — they exist purely to seed src/i18n/source/strings.json (and, via
// extract.mjs, locales/en.json) with values that a `tv()` call might see at
// RUNTIME but that transformSource's normal jsx/attr/obj walk can never see
// at BUILD time, because the value isn't sitting in JSX-child or whitelisted-
// attribute position in ui/src at all:
//   - "dyn": any other string-shaped literal in ui/src that looks like UI
//     copy (e.g. a ternary branch assigned to a variable that later flows
//     into a wrapped `{__tv(...)}` site — see case (a) in the module this
//     ships with).
//   - "shared": display copy inside the third-party app-definition catalog
//     (case (d)) that later gets rendered via `{app.description}` etc. and
//     therefore gets wrapped by the "shared" appearance in wrap-mode.
// -----------------------------------------------------------------------------

// Deliberately loose: over-collecting here is harmless (an entry nothing ever
// renders is just a few unused bytes in the dictionary); under-collecting is
// the failure mode that actually matters, because a value with no dictionary
// entry silently falls back to English forever. See the module header for
// the exact rule this implements.
const DYN_MIN_LENGTH = 3;

function isAllUppercaseIdentifierish(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function looksLikeUiCopyText(text) {
  if (text.length < DYN_MIN_LENGTH) return false;
  if (text.includes("\n")) return false;
  if (!/^[A-Z0-9]/.test(text)) return false;
  const endsWithTerminalPunctuation = /[.?!:…]$/.test(text);
  if (!(text.includes(" ") || endsWithTerminalPunctuation)) return false;
  // "://" is already excluded by the bare "/" check below; called out
  // separately in the design note only for clarity, not as extra logic.
  if (text.includes("/") || text.includes("_") || text.includes("{") || text.includes("=")) return false;
  if (isAllUppercaseIdentifierish(text)) return false;
  return true;
}

// Call/new-expression callees whose string arguments are never UI copy
// (module specifiers, log/error payloads, technical helpers) — a string
// literal passed to one of these is excluded from "dyn" collection.
const DYN_CONTEXT_EXCLUDED_CALLEES = new Set(["require", "fetch", "classNames", "cn", "URL", "Error"]);
const DYN_CONTEXT_EXCLUDED_TEST_FNS = new Set(["test", "describe", "it"]);

/**
 * Decides whether a string/template literal sits in a position that can
 * never be UI copy, based on its immediate parent node — import/export
 * specifiers, `className`/`data-*` attribute or object-property values,
 * and arguments to the callees above (including `console.*` and
 * `it.only(...)`/`describe.skip(...)`-style member-call test helpers).
 */
function isExcludedDynContext(parent) {
  if (!parent) return false;
  switch (parent.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      return true;
    case "JSXAttribute": {
      const name = jsxAttrName(parent.name);
      if (!name) return false;
      return name === "className" || name.startsWith("data-");
    }
    case "ObjectProperty":
      return propKeyName(parent.key) === "className";
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression": {
      const callee = parent.callee;
      if (callee?.type === "Identifier") {
        return DYN_CONTEXT_EXCLUDED_CALLEES.has(callee.name) || DYN_CONTEXT_EXCLUDED_TEST_FNS.has(callee.name);
      }
      if (
        (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
        !callee.computed
      ) {
        const objName = callee.object.type === "Identifier" ? callee.object.name : null;
        const propName = callee.property.type === "Identifier" ? callee.property.name : null;
        if (objName === "console") return true;
        if (propName && (DYN_CONTEXT_EXCLUDED_CALLEES.has(propName) || DYN_CONTEXT_EXCLUDED_TEST_FNS.has(propName))) {
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Walks the WHOLE AST (not gated by any wrap-target node type — this is the
 * "not limited to position" collection pass in the module doc comment) and
 * returns every StringLiteral / no-interpolation single-quasi TemplateLiteral
 * that looks like UI copy per `looksLikeUiCopyText` and is not sitting in one
 * of the excluded syntactic positions above.
 */
export function collectDynStrings(ast) {
  const results = [];

  function visit(node, parent) {
    if (!node || typeof node.type !== "string") return;

    if (node.type === "StringLiteral") {
      if (!isExcludedDynContext(parent) && looksLikeUiCopyText(node.value)) {
        results.push({
          text: node.value,
          kind: "dyn",
          start: node.start,
          end: node.end,
          line: node.loc?.start.line ?? 0,
        });
      }
    } else if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
      const raw = node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
      if (typeof raw === "string" && !isExcludedDynContext(parent) && looksLikeUiCopyText(raw)) {
        results.push({ text: raw, kind: "dyn", start: node.start, end: node.end, line: node.loc?.start.line ?? 0 });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item.type === "string") visit(item, node);
        }
      } else if (value && typeof value.type === "string") {
        visit(value, node);
      }
    }
  }

  visit(ast.program, null);
  return results;
}

// Object keys treated as display copy inside the app-definition catalog
// (case (d)). Deliberately the exact whitelist given in the task, not the
// full set of string fields the real JSON files happen to contain (e.g.
// `guidanceMd`/`whenToUse`/`warnings[]` are NOT in scope here) — extend this
// set if a future field needs it.
export const SHARED_OBJ_KEY_WHITELIST = new Set([
  "name",
  "label",
  "title",
  "description",
  "summary",
  "tagline",
  "subtitle",
  "placeholder",
  "helpText",
  "help",
  "hint",
  "heading",
  "cta",
  "ctaLabel",
  "buttonLabel",
  "emptyMessage",
  "category",
  "categoryLabel",
]);

/**
 * Collects "shared" kind strings from a `packages/shared/src/app-definitions/
 * *.json` app-definition file.
 *
 * DEVIATION FROM THE TASK BRIEF — the brief describes this as scanning
 * `app-definitions/**\/*.ts` ObjectProperty nodes via the Babel parser. That
 * does not match reality: every file directly under
 * `packages/shared/src/app-definitions/` is plain `.json` (72 files, verified
 * by listing the directory), imported into `app-definitions.generated.ts` via
 * `import a0 from "./app-definitions/agentmail.json" with { type: "json" }`
 * aggregator statements that contain no literal display copy themselves — all
 * of it lives in the JSON. Parsing that generated file with `@babel/parser`
 * would find nothing. So this walks `JSON.parse(jsonText)` as a plain object
 * tree instead of going through the Babel/TSX code path the rest of this
 * module uses; it never needs to (JSON has no computed keys, template
 * literals, or JSX to worry about). Positions are meaningless for JSON
 * source text parsed this way, so `start`/`end`/`line` are always 0 — callers
 * (extract.mjs) fall back to the file path alone for the "first occurrence"
 * field on these entries.
 */
export function collectSharedStrings(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    return { matches: [], parseError: error instanceof Error ? error.message : String(error) };
  }

  const matches = [];

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, val] of Object.entries(value)) {
      if (SHARED_OBJ_KEY_WHITELIST.has(key) && typeof val === "string" && countLetters(val) >= 2) {
        matches.push({ text: val, kind: "shared", start: 0, end: 0, line: 0 });
      }
      visit(val);
    }
  }

  visit(data);
  return { matches, parseError: null };
}

// -----------------------------------------------------------------------------
// Import injection helpers.
// -----------------------------------------------------------------------------

function findI18nImport(program) {
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration" && stmt.source.value === "@/i18n") {
      return stmt;
    }
  }
  return null;
}

function hasImportSpecifier(importDecl, localName) {
  return importDecl.specifiers.some(
    (spec) => spec.type === "ImportSpecifier" && spec.local.name === localName,
  );
}

/**
 * Builds (at most) one edit that adds whichever of `t as __t` / `tv as __tv`
 * this file's wrap edits actually need, reusing an existing `import ... from
 * "@/i18n"` statement if one is already there (including a bare side-effect
 * `import "@/i18n"`, which gets turned into a named import) and otherwise
 * inserting a new import after the last existing import (or at the top of
 * the file if there are none).
 *
 * @param {{t: boolean, tv: boolean}} needs
 */
function buildImportEdit(program, needs) {
  const wanted = [];
  if (needs.t) wanted.push({ imported: "t", local: "__t" });
  if (needs.tv) wanted.push({ imported: "tv", local: "__tv" });
  if (wanted.length === 0) return null;

  const existing = findI18nImport(program);
  if (existing) {
    const missing = wanted.filter((w) => !hasImportSpecifier(existing, w.local));
    if (missing.length === 0) return null;
    const clause = missing.map((w) => `${w.imported} as ${w.local}`).join(", ");
    if (existing.specifiers.length === 0) {
      // `import "@/i18n"` (side-effect only) — turn it into a named import.
      return { start: existing.source.start, end: existing.source.start, replacement: `{ ${clause} } from ` };
    }
    const last = existing.specifiers[existing.specifiers.length - 1];
    return { start: last.end, end: last.end, replacement: `, ${clause}` };
  }
  const lastImport = [...program.body].reverse().find((s) => s.type === "ImportDeclaration");
  const insertAt = lastImport ? lastImport.end : 0;
  const prefix = lastImport ? "\n" : "";
  const clause = wanted.map((w) => `${w.imported} as ${w.local}`).join(", ");
  return { start: insertAt, end: insertAt, replacement: `${prefix}import { ${clause} } from "@/i18n";` };
}

// -----------------------------------------------------------------------------
// Public API.
// -----------------------------------------------------------------------------

// Match kinds that produce an edit when mode is "wrap": jsx/attr/obj are the
// literal-string replace-with-__t(...) kinds; "expr" is the case (a)/(b)/(c)
// insert-__tv(...)-around-the-expression kind. "manual" (pre-existing __t/
// t calls, never re-wrapped) and "dyn"/"shared" (collect-only kinds that seed
// the dictionary from values transformSource's own single-file walk can never
// see at their point of use — see collectDynStrings/collectSharedStrings
// above) never produce edits.
const EDITABLE_KINDS = new Set(["jsx", "attr", "obj", "expr"]);

/**
 * Parses `code` and returns every translatable string found, plus (in "wrap" mode)
 * the transformed source text with each match replaced by `__t("...")` (literal
 * kinds) or wrapped in `__tv(...)` (the "expr" kind — non-literal JSX-child or
 * attribute expressions, cases (a)/(b)/(c)) and the `@/i18n` import injected
 * with whichever of `__t`/`__tv` this file actually ends up using.
 *
 * In "collect" mode, the returned `matches` also include "dyn" kind entries
 * (see `collectDynStrings`) — every other string/template literal in the file
 * that looks like UI copy, regardless of position. These are never wrapped;
 * mode "wrap" (the Vite plugin's actual runtime path) never runs that extra
 * pass, so ordinary builds pay no cost for it.
 *
 * @param {string} code
 * @param {string} absPath - used only to decide jsx vs plain-ts parsing; not read.
 * @param {{mode?: "wrap" | "collect", objectKeys?: boolean, scriptType?: "ts"|"tsx"}} [options]
 */
export function transformSource(code, absPath, options = {}) {
  const mode = options.mode ?? "wrap";
  const objectKeys = options.objectKeys ?? true;
  const scriptType = options.scriptType ?? (absPath.endsWith(".tsx") ? "tsx" : "ts");
  const isJsx = scriptType === "tsx";

  let ast;
  try {
    ast = parseSource(code, isJsx);
  } catch (error) {
    return { code, changed: false, matches: [], parseError: error instanceof Error ? error.message : String(error) };
  }

  const matches = [];
  walk(ast, {
    objectKeys,
    onMatch: (match) => matches.push(match),
  });

  if (mode === "collect") {
    matches.push(...collectDynStrings(ast));
  }

  const editable = matches.filter((m) => EDITABLE_KINDS.has(m.kind));

  if (mode !== "wrap" || editable.length === 0) {
    return { code, changed: false, matches, parseError: null };
  }

  const edits = [];
  for (const m of editable) {
    if (m.kind === "expr") {
      // Braces (JSX child) or the surrounding {...} (attribute value) already
      // exist in the source — only the call needs inserting, around the
      // ORIGINAL expression text, via two zero-width insertion edits. This
      // is span-splicing, not AST regeneration, so the expression's own
      // source text is reproduced byte-for-byte between the two insertions.
      edits.push({ start: m.start, end: m.start, replacement: "__tv(" });
      edits.push({ start: m.end, end: m.end, replacement: ")" });
    } else {
      edits.push({
        start: m.start,
        end: m.end,
        replacement: m.wrapInBraces ? `{__t(${JSON.stringify(m.text)})}` : `__t(${JSON.stringify(m.text)})`,
      });
    }
  }

  const needsT = editable.some((m) => m.kind !== "expr");
  const needsTv = editable.some((m) => m.kind === "expr");
  const importEdit = buildImportEdit(ast.program, { t: needsT, tv: needsTv });
  if (importEdit) edits.push(importEdit);

  edits.sort((a, b) => a.start - b.start || a.end - b.end);

  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += code.slice(cursor, edit.start);
    out += edit.replacement;
    cursor = edit.end;
  }
  out += code.slice(cursor);

  return { code: out, changed: true, matches, parseError: null };
}

/**
 * Vite plugin factory. Must run BEFORE `@vitejs/plugin-react` in the `plugins`
 * array — both use `enforce: "pre"`, and Vite runs same-enforce plugins in
 * registration order, so putting this one first in the array wins.
 */
export function createI18nWrapVitePlugin(options = {}) {
  const objectKeys = options.objectKeys ?? true;
  return {
    name: "i18n-wrap",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("?")) return null; // skip ?raw, ?url, ?worker, etc.
      if (id.includes("/node_modules/")) return null;
      const srcRoot = options.srcRoot;
      const scriptType = classifyFile(id, srcRoot);
      if (!scriptType) return null;
      const result = transformSource(code, id, { mode: "wrap", objectKeys, scriptType });
      if (result.parseError) {
        this.warn(`i18n-wrap: skipped ${id} (parse error: ${result.parseError})`);
        return null;
      }
      if (!result.changed) return null;
      return { code: result.code, map: null };
    },
  };
}
