import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales, type SupportedLocale } from "./locales";

const LOCALE_STORAGE_KEY = "paperclip.locale";

function isSupportedLocale(value: string): value is SupportedLocale {
  return (supportedLocales as readonly string[]).includes(value);
}

/** Maps a BCP-47 `navigator.language` value onto one of our bundled locale codes. */
function mapNavigatorLanguage(raw: string): SupportedLocale | null {
  const lower = raw.toLowerCase();
  if (lower === "zh-tw" || lower.startsWith("zh-hant")) return isSupportedLocale("zh-TW") ? "zh-TW" : null;
  if (lower.startsWith("zh")) return isSupportedLocale("zh-CN") ? "zh-CN" : null;
  const short = lower.slice(0, 2);
  return isSupportedLocale(short) ? (short as SupportedLocale) : null;
}

/**
 * Resolves the language to boot with, synchronously, before i18next initializes.
 * `__t` (the build-time-injected translation call) is a stateless function, not a
 * hook, so we never hot-swap the active language in place — language changes go
 * through `setLocale`, which persists the choice and reloads the page. This
 * function must stay defensive: it also runs whenever a test file transitively
 * imports `@/i18n` (which is most of them, once the build-time wrap plugin has
 * injected the import), and most test files run under vitest's default "node"
 * environment where `window`/`document`/`navigator` are undefined.
 */
function detectInitialLocale(): SupportedLocale {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && isSupportedLocale(stored)) return stored;
    }
  } catch {
    // localStorage can throw in locked-down/private-browsing contexts.
  }

  try {
    if (typeof navigator !== "undefined" && navigator.language) {
      const mapped = mapNavigatorLanguage(navigator.language);
      if (mapped) return mapped;
    }
  } catch {
    // Defensive: navigator access is unreliable across non-browser test environments.
  }

  return DEFAULT_LOCALE;
}

const resolvedLocale = detectInitialLocale();

if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.lang = resolvedLocale;
}

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: resolvedLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
  // Keyless mode: the translation KEY is the literal source-language string
  // (what the build-time wrap plugin extracts), not a dotted lookup path. This
  // avoids needing to invent and maintain ~1,600+ synthetic key names, and means
  // an untranslated locale gracefully falls back to displaying the key itself
  // (i.e. the original English text) instead of a raw "missingKey.path.here".
  keySeparator: false,
  nsSeparator: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/**
 * Translate-value: for use at the `(a)(b)(c)` wrap sites the build-time plugin
 * injects around non-literal JSX children and attribute expressions (e.g.
 * `{__tv(pageTitle)}`, `title={__tv(cond ? "A" : "B")}`). Unlike `t`, which is
 * only ever called on a literal string constant known at build time, `tv` runs
 * on values whose type is not statically known (a variable, a prop, a `.data`
 * field, a rendered element, a number, `null`/`undefined`). It is deliberately
 * permissive: non-string values pass through untouched (an element/array/
 * number/null keeps rendering exactly as it did before wrapping), and only
 * non-empty strings go through the same keyless `t()` lookup as everything
 * else. A miss in the dictionary falls back to the original string, same as
 * `t()` — see the keyless-mode note in `i18nextOptions` above.
 */
export function tv<T>(value: T): T {
  if (typeof value === "string" && value.length > 0) {
    return t(value) as unknown as T;
  }
  return value;
}

/** Reads the currently active UI locale (defaults to `DEFAULT_LOCALE` before init resolves). */
export function getCurrentLocale(): SupportedLocale {
  const current = i18n.language;
  return isSupportedLocale(current) ? current : DEFAULT_LOCALE;
}

/**
 * Persists the chosen locale and reloads the page. `t`/`__t` are plain functions
 * (not subscribed to a React context), so there is no in-place way to re-render
 * every already-rendered string — a reload is the simple, correct way to apply it
 * everywhere at once.
 */
export function setLocale(locale: SupportedLocale) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures; the reload will just fall back to navigator.language.
  }
  if (typeof window !== "undefined") window.location.reload();
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
export type { SupportedLocale };
