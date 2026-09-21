// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n, t as __t, tv as __tv } from ".";

// Mirrors the render pattern used across the codebase's other component
// tests (see App.test.tsx): raw react-dom + flushSync, not
// @testing-library/react (which isn't a dependency here).

function TranslatedGreeting() {
  return (
    <div>
      <h1>{__t("Search")}</h1>
      <p>{__t("Status")}</p>
      <button type="button" title={__t("Save")}>
        {__t("Cancel")}
      </button>
      {/* A string with no dictionary entry in any locale: should always
          render as the literal English text, in every language. */}
      <span>{__t("This exact sentence has never been translated anywhere.")}</span>
    </div>
  );
}

// Mirrors what the (a)/(b)/(c) wrap sites actually inject: `{__tv(dynamicVar)}`
// instead of a build-time-known literal. `dynamicVar` is a runtime value the
// component does not control (a prop, in practice); this fixture exercises
// all three shapes `tv` has to handle: a translatable string, an
// untranslated-but-still-a-string value (falls back to itself, same as
// `t()`), and a non-string value (a rendered element) that must pass through
// completely unchanged.
function DynamicGreeting({ dynamicVar }: { dynamicVar: ReactNode }) {
  return <h1>{__tv(dynamicVar)}</h1>;
}

describe("rendering with the zh-TW locale active", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    container.remove();
    // Restore English so this test doesn't leak locale state into other test
    // files sharing the same i18next singleton within the worker.
    await i18n.changeLanguage("en");
  });

  it("shows the zh-TW translations for known keys, unchanged English for unknown ones", async () => {
    await i18n.changeLanguage("zh-TW");

    const root = createRoot(container);
    flushSync(() => {
      root.render(<TranslatedGreeting />);
    });

    expect(container.querySelector("h1")?.textContent).toBe("搜尋");
    expect(container.querySelector("p")?.textContent).toBe("狀態");
    expect(container.querySelector("button")?.textContent).toBe("取消");
    expect(container.querySelector("button")?.getAttribute("title")).toBe("儲存");
    expect(container.querySelector("span")?.textContent).toBe(
      "This exact sentence has never been translated anywhere.",
    );

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows plain English for the same component when the locale is English", async () => {
    await i18n.changeLanguage("en");

    const root = createRoot(container);
    flushSync(() => {
      root.render(<TranslatedGreeting />);
    });

    expect(container.querySelector("h1")?.textContent).toBe("Search");
    expect(container.querySelector("button")?.textContent).toBe("Cancel");

    flushSync(() => {
      root.unmount();
    });
  });

  it("__tv (the (a)/(b)/(c) wrap-site helper) translates known strings, falls back on unknown strings, and passes non-strings through unchanged", async () => {
    // zh-TW, a known key: translates exactly like __t would.
    await i18n.changeLanguage("zh-TW");
    let root = createRoot(container);
    flushSync(() => {
      root.render(<DynamicGreeting dynamicVar="Search" />);
    });
    expect(container.querySelector("h1")?.textContent).toBe("搜尋");
    flushSync(() => root.unmount());

    // zh-TW, a string not in any dictionary: falls back to the literal string,
    // same keyless-mode behavior __t already has (see TranslatedGreeting above).
    root = createRoot(container);
    flushSync(() => {
      root.render(<DynamicGreeting dynamicVar="This exact sentence has never been translated anywhere." />);
    });
    expect(container.querySelector("h1")?.textContent).toBe(
      "This exact sentence has never been translated anywhere.",
    );
    flushSync(() => root.unmount());

    // zh-TW, a non-string value (a rendered element, number, etc.): tv only
    // ever inspects `typeof value === "string"`, so anything else — including
    // a child React element — renders completely untouched.
    root = createRoot(container);
    flushSync(() => {
      root.render(<DynamicGreeting dynamicVar={<span data-testid="child-element">42</span>} />);
    });
    expect(container.querySelector('[data-testid="child-element"]')?.textContent).toBe("42");
    flushSync(() => root.unmount());

    // en, the same known key: identity dictionary, so plain English.
    await i18n.changeLanguage("en");
    root = createRoot(container);
    flushSync(() => {
      root.render(<DynamicGreeting dynamicVar="Search" />);
    });
    expect(container.querySelector("h1")?.textContent).toBe("Search");
    flushSync(() => root.unmount());
  });
});
