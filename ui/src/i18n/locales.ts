import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;

const localeModules = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export const localeMessages = Object.fromEntries(
  Object.entries(localeModules).map(([path, messages]) => {
    const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
    if (!locale) {
      throw new Error(`Invalid locale file path: ${path}`);
    }
    return [locale, messages];
  }),
);

if (!(DEFAULT_LOCALE in localeMessages)) {
  throw new Error(`Missing default locale messages for ${DEFAULT_LOCALE}`);
}

for (const [locale, messages] of Object.entries(localeMessages)) {
  try {
    assertValidLocaleMessages(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
}

export const supportedLocales = Object.keys(localeMessages);

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [locale, { translation: messages }]),
) as Resource;

// `keyof typeof localeMessages` alone types as `string | number`: localeMessages
// is built from a dynamic `import.meta.glob()` result, so TS only sees it through
// an index signature, and `keyof { [k: string]: T }` includes `number` (numeric
// string keys are valid too). Intersecting with `string` drops that phantom
// `number` branch. There's no way to recover real locale-code literal types from
// a glob-built object anyway, so this is honestly just `string` — but keeping the
// `keyof` shape self-documents "this is meant to be one of the loaded locales".
export type SupportedLocale = keyof typeof localeMessages & string;
