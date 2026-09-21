import { describe, expect, it } from "vitest";
import { t } from ".";
import en from "./locales/en.json";
import { localeMessages } from "./locales";
import { validateLocaleMessages } from "./locale-validation";

describe("locale validation", () => {
  it("resolves messages using the source string as a keyless lookup", () => {
    // Keyless mode: the key IS the English text. A key that exists in the active
    // locale's resource bundle resolves to its translation...
    expect(t("Create your first organization")).toBe(en["Create your first organization"]);
    // ...and a key with no entry anywhere falls back to being displayed as-is,
    // which for keyless mode means the original English text renders unchanged.
    expect(t("Some untranslated string nobody wrapped yet")).toBe(
      "Some untranslated string nobody wrapped yet",
    );
    expect(t("app.missing", { defaultValue: "Fallback" })).toBe("Fallback");
  });

  it("accepts registered locale files", () => {
    expect(Object.keys(localeMessages)).toContain("en");
    expect(Object.keys(localeMessages)).toContain("zh-TW");
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(validateLocaleMessages(messages), locale).toEqual([]);
    }
  });

  it("allows a locale to translate only a subset of English keys (progressive translation)", () => {
    expect(
      validateLocaleMessages({
        "Create your first organization": "建立您的第一家公司",
        // "Get started by creating an organization." intentionally omitted.
      }),
    ).toEqual([]);
  });

  it("allows an empty object (untranslated placeholder locale)", () => {
    expect(validateLocaleMessages({})).toEqual([]);
  });

  it("rejects keys not defined in English", () => {
    expect(
      validateLocaleMessages({
        "Create your first organization": en["Create your first organization"],
        "Some string that does not exist in English": "不存在",
      }),
    ).toEqual(
      expect.arrayContaining(["Some string that does not exist in English is not defined in English"]),
    );
  });

  it("rejects non-string leaves", () => {
    expect(
      validateLocaleMessages({
        "Create your first organization": ["Create your first organization"],
      }),
    ).toEqual(expect.arrayContaining(["Create your first organization must be a string"]));
  });

  it("requires interpolation placeholders to match English", () => {
    const reference = {
      message: "Invite {{name}} to {{company}}",
    };

    expect(validateLocaleMessages({ message: "Invite {{name}}" }, reference)).toEqual([
      'message interpolation placeholders must match English exactly: expected ["company","name"], received ["name"]',
    ]);
  });

  it("rejects executable, raw HTML, and unexpected link payloads not present in English", () => {
    const reference = {
      script: "Create company",
      handler: "Create company",
      js: "Create company",
      data: "Create company",
      url: "Create company",
      html: "Create company",
    };

    expect(
      validateLocaleMessages(
        {
          script: "<script>alert(1)</script>",
          handler: '<span ONCLICK="alert(1)">Create</span>',
          js: "javascript:alert(1)",
          data: "data:text/html,hello",
          url: "https://example.test",
          html: "<strong>Create company</strong>",
        },
        reference,
      ),
    ).toEqual(
      expect.arrayContaining([
        "script contains disallowed <script",
        "handler contains disallowed event-handler attribute",
        "js contains disallowed javascript:",
        "data contains disallowed data:",
        "url contains disallowed unexpected URL",
        "html contains disallowed raw HTML tag",
      ]),
    );
  });

  it("caps localized string length relative to English", () => {
    expect(validateLocaleMessages({ message: "x".repeat(200) }, { message: "Short" })).toEqual([
      "message is too long: 200 characters exceeds 133",
    ]);
  });
});
