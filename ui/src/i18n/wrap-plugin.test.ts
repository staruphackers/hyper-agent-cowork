import { describe, expect, it } from "vitest";
import {
  transformSource,
  createI18nWrapVitePlugin,
  classifyFile,
  collectDynStrings,
  collectSharedStrings,
  parseSource,
} from "../../i18n-tools/babel-plugin-i18n-wrap.mjs";

// NOTE on scope: the original design for this suite called for driving a real
// "Babel plugin" through @babel/core directly. As documented at length in
// ui/i18n-tools/babel-plugin-i18n-wrap.mjs's header comment, this repo's
// @vitejs/plugin-react@6 no longer supports Babel plugins at all (it's
// OXC-based), and @babel/core is not a declared dependency anywhere in the
// workspace — so this file exercises the actual engine (`transformSource`)
// directly instead. It's the same code path the Vite plugin, extract.mjs, and
// check.mjs all call.

const FIXTURE_ONE = `
export function Example({ items }: { items: string[] }) {
  return (
    <div className="wrap-container" id="example" title="Save changes">
      <h1>Hello world</h1>
      <p>
        {items.length}
      </p>
    </div>
  );
}
`;

const FIXTURE_TWO = `
export function LinkRow() {
  return (
    <a href="/settings" className="link" data-testid="settings-link" aria-label="Open settings">
      Open settings
    </a>
  );
}
`;

const FIXTURE_THREE = `
export const dialogConfig = {
  label: "Confirm deletion of this project",
  slug: "confirm_delete_project",
  key: "confirm-delete",
};
`;

// Fixtures for the (a)/(b)/(c) dynamic-value wrap extension: variables,
// ternaries, and other non-literal expressions in JSX-child / whitelisted-
// attribute position get wrapped in __tv(...) instead of __t("...").

const FIXTURE_DYN_CHILD = `
export function Title({ pageTitle }: { pageTitle: string }) {
  return <h1>{pageTitle}</h1>;
}
`;

const FIXTURE_DYN_ATTR = `
export function FilterButton({ cond }: { cond: boolean }) {
  return <button title={cond ? "A" : "B"}>Filter</button>;
}
`;

const FIXTURE_DYN_MAP_EXCLUDED = `
export function List({ items }: { items: { id: string; label: string }[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  );
}
`;

const FIXTURE_DYN_CODE_EXCLUDED = `
export function Snippet({ x }: { x: string }) {
  return <code>{x}</code>;
}
`;

const FIXTURE_COLLECT_DYN = `
export function pick(cond: boolean, createIssueLabel?: string) {
  const createButtonLabel = createIssueLabel ? \`New \${createIssueLabel}\` : "New Task";
  return createButtonLabel;
}
`;

const SHARED_APP_DEFINITION_JSON = JSON.stringify({
  slug: "asana",
  name: "Asana",
  description: "Connect Asana's provider-hosted MCP server.",
  methods: [{ key: "mcp-own-oauth", label: "Use your own OAuth app" }],
});

describe("babel-plugin-i18n-wrap: wrap mode", () => {
  it("wraps JSXText and whitelisted attribute strings, leaving structural attributes untouched", () => {
    const result = transformSource(FIXTURE_ONE, "/fake/src/Example.tsx", { mode: "wrap" });
    expect(result.parseError).toBeNull();
    expect(result.changed).toBe(true);

    // Wrapped: the JSXText child and the whitelisted `title` attribute.
    expect(result.code).toContain('{__t("Hello world")}');
    expect(result.code).toContain('title={__t("Save changes")}');

    // Also wrapped, via the (c) dynamic-value extension: `{items.length}` is
    // a JSX child expression (a MemberExpression, not excluded by any of the
    // JSXElement/JSXFragment/ArrowFunctionExpression/FunctionExpression/
    // .map|.filter|.join rules), so it gets __tv(...)'d too.
    expect(result.code).toContain("{__tv(items.length)}");

    // Untouched: className / id are never in the attribute whitelist.
    expect(result.code).toContain('className="wrap-container"');
    expect(result.code).toContain('id="example"');
    expect(result.code).not.toMatch(/className=\{__t/);
    expect(result.code).not.toMatch(/id=\{__t/);

    // The import gets injected exactly once, pulling in both __t (for the
    // literal-string wraps above) and __tv (for the {items.length} wrap).
    expect(result.code.match(/import \{ t as __t, tv as __tv \} from "@\/i18n";/g)).toHaveLength(1);
  });

  it("wraps aria-label but never href/className/data-*", () => {
    const result = transformSource(FIXTURE_TWO, "/fake/src/LinkRow.tsx", { mode: "wrap" });
    expect(result.changed).toBe(true);
    expect(result.code).toContain('aria-label={__t("Open settings")}');
    expect(result.code).toContain('{__t("Open settings")}'); // the JSXText child too
    expect(result.code).toContain('href="/settings"');
    expect(result.code).toContain('className="link"');
    expect(result.code).toContain('data-testid="settings-link"');
    expect(result.code).not.toMatch(/href=\{__t/);
    expect(result.code).not.toMatch(/className=\{__t/);
    expect(result.code).not.toMatch(/data-testid=\{__t/);
  });

  it("wraps whitelisted object-literal keys only when the heuristic qualifies, leaving slug/key alone", () => {
    const result = transformSource(FIXTURE_THREE, "/fake/src/config.ts", { mode: "wrap", scriptType: "ts" });
    expect(result.changed).toBe(true);
    expect(result.code).toContain('label: __t("Confirm deletion of this project")');
    expect(result.code).toContain('slug: "confirm_delete_project"');
    expect(result.code).toContain('key: "confirm-delete"');
  });

  it("produces valid syntax that round-trips through the parser", () => {
    for (const [fixture, id] of [
      [FIXTURE_ONE, "/fake/src/Example.tsx"],
      [FIXTURE_TWO, "/fake/src/LinkRow.tsx"],
    ] as const) {
      const result = transformSource(fixture, id, { mode: "wrap" });
      expect(() => transformSource(result.code, id, { mode: "collect" })).not.toThrow();
      const reparsed = transformSource(result.code, id, { mode: "collect" });
      expect(reparsed.parseError).toBeNull();
    }
  });
});

describe("babel-plugin-i18n-wrap: dynamic-value wrap (cases a/b/c/d)", () => {
  it("(i) wraps a plain JSX-child identifier: {pageTitle} -> {__tv(pageTitle)}", () => {
    const result = transformSource(FIXTURE_DYN_CHILD, "/fake/src/Title.tsx", { mode: "wrap" });
    expect(result.parseError).toBeNull();
    expect(result.changed).toBe(true);
    expect(result.code).toContain("{__tv(pageTitle)}");
    expect(result.code).toContain('import { tv as __tv } from "@/i18n";');
    // No literal strings anywhere in this fixture, so __t must not be pulled in.
    expect(result.code).not.toContain("__t(");
  });

  it("(ii) wraps a ternary attribute value: title={cond ? \"A\" : \"B\"} gets __tv-wrapped", () => {
    const result = transformSource(FIXTURE_DYN_ATTR, "/fake/src/FilterButton.tsx", { mode: "wrap" });
    expect(result.changed).toBe(true);
    // The braces already present in the source are reused; only the call is inserted.
    expect(result.code).toContain('title={__tv(cond ? "A" : "B")}');
    // The individual ternary branches are NOT separately __t-wrapped — the whole
    // expression is handed to __tv as one runtime value.
    expect(result.code).not.toContain('__t("A")');
    expect(result.code).not.toContain('__t("B")');
  });

  it("(iii) does not wrap {items.map(...)} — a list-rendering call is excluded", () => {
    const result = transformSource(FIXTURE_DYN_MAP_EXCLUDED, "/fake/src/List.tsx", { mode: "wrap" });
    expect(result.changed).toBe(true);
    // The map(...) call itself is left alone.
    expect(result.code).not.toMatch(/\{__tv\(items\.map/);
    // But an eligible expression child rendered INSIDE the map callback still
    // gets its own independent wrap — exclusion only applies to the call
    // expression that returns the list, not to everything nested inside it.
    expect(result.code).toContain("{__tv(item.label)}");
  });

  it("(iv) does not wrap expression children under <code>/<pre>/<kbd>/<samp>/<script>/<style>/<textarea>", () => {
    const result = transformSource(FIXTURE_DYN_CODE_EXCLUDED, "/fake/src/Snippet.tsx", { mode: "wrap" });
    // <code>{x}</code>: the only expression in the whole fixture is excluded by
    // parent-tag, so nothing changes at all.
    expect(result.changed).toBe(false);
    expect(result.code).toBe(FIXTURE_DYN_CODE_EXCLUDED);
  });

  it("(v) collect mode harvests a loose string literal that looks like UI copy: \"New Task\"", () => {
    const result = transformSource(FIXTURE_COLLECT_DYN, "/fake/src/pick.ts", {
      mode: "collect",
      scriptType: "ts",
    });
    expect(result.changed).toBe(false); // collect mode never edits source
    const dynMatches = result.matches.filter((m) => m.kind === "dyn");
    expect(dynMatches.map((m) => m.text)).toContain("New Task");
    // "Create" (the other ternary branch) has neither a space nor terminal
    // punctuation, so it does not qualify under looksLikeUiCopyText — this is
    // the deliberately loose-but-bounded heuristic, not a bug.
    expect(dynMatches.map((m) => m.text)).not.toContain("Create");
  });

  it("(vi) collectSharedStrings harvests app-definition JSON display copy, e.g. description", () => {
    const { matches, parseError } = collectSharedStrings(SHARED_APP_DEFINITION_JSON);
    expect(parseError).toBeNull();
    const texts = matches.map((m) => ({ text: m.text, kind: m.kind }));
    expect(texts).toContainEqual({ text: "Connect Asana's provider-hosted MCP server.", kind: "shared" });
    expect(texts).toContainEqual({ text: "Asana", kind: "shared" });
    expect(texts).toContainEqual({ text: "Use your own OAuth app", kind: "shared" });
    // "slug" and "key" are not in SHARED_OBJ_KEY_WHITELIST.
    expect(texts.some((m) => m.text === "asana")).toBe(false);
    expect(texts.some((m) => m.text === "mcp-own-oauth")).toBe(false);
  });

  it("collectDynStrings is directly exported and usable standalone off a parsed AST", () => {
    const ast = parseSource(FIXTURE_COLLECT_DYN, false);
    const dynMatches = collectDynStrings(ast);
    expect(dynMatches.some((m) => m.kind === "dyn" && m.text === "New Task")).toBe(true);
  });
});

const FIXTURE_OBJ_SHORT_LABEL = `
export const inboxTabs = [
  { value: "mine", label: "Mine" },
  { value: "recent", label: "Recent" },
  { value: "unread", label: "Unread", key: "Unread" },
];
`;

const FIXTURE_BRANCH_LITERALS = `
export function ConnectButton({ previous, name }: { previous: boolean; name?: string }) {
  return (
    <div>
      <button title={previous ? "Reconnect" : "Connect"}>{previous ? "Reconnect" : "Connect"}</button>
      <span>{name || "Untitled"}</span>
    </div>
  );
}
`;

describe("babel-plugin-i18n-wrap: short single-word labels", () => {
  it("wraps a single capitalized word under a whitelisted object key, but not under `key`/`value`", () => {
    const result = transformSource(FIXTURE_OBJ_SHORT_LABEL, "/fake/src/tabs.ts", { mode: "wrap", scriptType: "ts" });
    expect(result.changed).toBe(true);
    expect(result.code).toContain('label: __t("Mine")');
    expect(result.code).toContain('label: __t("Recent")');
    expect(result.code).toContain('label: __t("Unread")');
    expect(result.code).toContain('value: "mine"');
    expect(result.code).toContain('key: "Unread"');
  });

  it("harvests a single-word object-property value (id-keyed label maps), but not a lone word elsewhere", () => {
    const fixture = `
export const KIND_LABELS = { request_confirmation: "Confirmations", suggest_tasks: "Suggested tasks" };
export const method = "Bearer";
export function f() { return "Standalone"; }
`;
    const result = transformSource(fixture, "/fake/src/labels.ts", { mode: "collect", scriptType: "ts" });
    const dyn = result.matches.filter((m) => m.kind === "dyn").map((m) => m.text);
    expect(dyn).toContain("Confirmations");
    expect(dyn).toContain("Suggested tasks");
    expect(dyn).not.toContain("Standalone");
    // "Bearer" is a variable initializer, not an object property value.
    expect(dyn).not.toContain("Bearer");
    expect(result.changed).toBe(false);
  });

  it("harvests the single-word literal branches of a ternary / || in JSX child and attribute position", () => {
    const result = transformSource(FIXTURE_BRANCH_LITERALS, "/fake/src/ConnectButton.tsx", { mode: "collect" });
    const dyn = result.matches.filter((m) => m.kind === "dyn").map((m) => m.text);
    expect(dyn).toContain("Connect");
    expect(dyn).toContain("Reconnect");
    expect(dyn).toContain("Untitled");
    // Both the attribute ternary and the child ternary contribute an occurrence.
    expect(dyn.filter((text) => text === "Connect")).toHaveLength(2);
    // Collect mode never edits the source; wrap mode still only inserts __tv(...) around the expression.
    expect(result.changed).toBe(false);
    const wrapped = transformSource(FIXTURE_BRANCH_LITERALS, "/fake/src/ConnectButton.tsx", { mode: "wrap" });
    expect(wrapped.code).toContain('{__tv(previous ? "Reconnect" : "Connect")}');
    expect(wrapped.code).toContain('title={__tv(previous ? "Reconnect" : "Connect")}');
    expect(wrapped.code).not.toContain('__t("Connect")');
  });
});

describe("babel-plugin-i18n-wrap: collect mode (extraction)", () => {
  it("reports every match without modifying the source", () => {
    const result = transformSource(FIXTURE_ONE, "/fake/src/Example.tsx", { mode: "collect" });
    expect(result.changed).toBe(false);
    expect(result.code).toBe(FIXTURE_ONE);

    const texts = result.matches.map((m) => ({ text: m.text, kind: m.kind }));
    expect(texts).toContainEqual({ text: "Hello world", kind: "jsx" });
    expect(texts).toContainEqual({ text: "Save changes", kind: "attr" });
    // className/id never appear as matches at all.
    expect(texts.some((m) => m.text === "wrap-container")).toBe(false);
    expect(texts.some((m) => m.text === "example")).toBe(false);
  });

  it("collect mode on the object-literal fixture matches exactly the same set wrap mode would act on", () => {
    const result = transformSource(FIXTURE_THREE, "/fake/src/config.ts", { mode: "collect", scriptType: "ts" });
    // Collect mode in "wrap"-equivalent kinds (jsx/attr/obj/manual) matches
    // exactly what wrap mode would act on. It additionally surfaces a "dyn"
    // entry for the SAME string here — collectDynStrings scans every string
    // literal in the file "not limited to position" (see its doc comment),
    // so a value the obj rule already caught also gets picked up by the loose
    // scan. That duplication is intentional and harmless for the dictionary
    // (strings.json dedupes by text — see extract.mjs), so it's asserted
    // separately below rather than folded into the "wrap targets" set.
    const wrapTargetMatches = result.matches.filter((m) => m.kind !== "dyn");
    expect(wrapTargetMatches).toEqual([
      expect.objectContaining({ text: "Confirm deletion of this project", kind: "obj" }),
    ]);
    expect(result.matches).toContainEqual(
      expect.objectContaining({ text: "Confirm deletion of this project", kind: "dyn" }),
    );
  });
});

describe("babel-plugin-i18n-wrap: reverse control (the plugin is what does the wrapping)", () => {
  it("source that was never run through the plugin has no __t(...) calls at all", () => {
    // This is the negative control the task asked for: without the plugin,
    // there is nothing in the fixtures that would spontaneously produce
    // `__t(...)`. If this test ever fails, it means the fixture text itself
    // changed to include `__t(`, not that the plugin regressed.
    for (const fixture of [FIXTURE_ONE, FIXTURE_TWO, FIXTURE_THREE]) {
      expect(fixture).not.toContain("__t(");
    }
  });
});

describe("classifyFile", () => {
  const srcRoot = "/fake/ui/src";

  it("processes ordinary .tsx/.ts files under src/", () => {
    expect(classifyFile(`${srcRoot}/components/Foo.tsx`, srcRoot)).toBe("tsx");
    expect(classifyFile(`${srcRoot}/lib/util.ts`, srcRoot)).toBe("ts");
  });

  it("excludes the i18n system itself, tests, stories, vite-* helpers, and declaration files", () => {
    expect(classifyFile(`${srcRoot}/i18n/index.ts`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/i18n/locale-validation.ts`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/components/Foo.test.tsx`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/stories/Foo.stories.tsx`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/lib/vite-watch.ts`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/lib/__tests__/helpers.ts`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/types/global.d.ts`, srcRoot)).toBeNull();
    expect(classifyFile(`${srcRoot}/components/Foo.css`, srcRoot)).toBeNull();
  });
});

describe("createI18nWrapVitePlugin", () => {
  it("returns a pre-enforced transform plugin that skips query-suffixed and node_modules ids", async () => {
    const plugin = createI18nWrapVitePlugin({ srcRoot: "/fake/ui/src" });
    expect(plugin.name).toBe("i18n-wrap");
    expect(plugin.enforce).toBe("pre");

    // Vite's Plugin["transform"] type allows either a plain function or the
    // extended `{ handler, order, ... }` object form; this plugin only ever
    // uses the plain-function form, so normalize to that for the test.
    const transformHook = plugin.transform;
    if (!transformHook) throw new Error("i18n-wrap plugin has no transform hook");
    const handler = typeof transformHook === "function" ? transformHook : transformHook.handler;

    const ctx = { warn: () => {} } as unknown as ThisParameterType<typeof handler>;

    async function run(code: string, id: string) {
      return await handler.call(ctx, code, id, undefined);
    }

    expect(await run(FIXTURE_ONE, "/fake/ui/src/Example.tsx?raw")).toBeNull();
    expect(await run(FIXTURE_ONE, "/fake/ui/node_modules/x/Example.tsx")).toBeNull();

    const result = await run(FIXTURE_ONE, "/fake/ui/src/Example.tsx");
    expect(result).not.toBeNull();
    expect((result as { code: string } | null)?.code).toContain('{__t("Hello world")}');
  });
});
