import { Languages } from "lucide-react";

import { cn } from "@/lib/utils";
import { getCurrentLocale, setLocale, type SupportedLocale } from "@/i18n";

interface LanguageSwitcherProps {
  className?: string;
  /** Called after `setLocale` runs (before the page reloads). Surfaces like a
   * popover menu use this to dismiss the menu once the user has acted. */
  onAfterSwitch?: () => void;
}

// Only the two locales that currently have translated content are offered.
// The other 38 bundled locale files (see ui/src/i18n/locales/) are empty
// placeholders for future translation work — listing them here would just
// switch the app to a locale that silently falls back to English everywhere.
const AVAILABLE_LOCALES: readonly SupportedLocale[] = ["en", "zh-TW"];
const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  "zh-TW": "繁體中文",
};

/**
 * Compact menu-action row that switches the UI language. Mirrors
 * ThemeToggle's "compact-menu-action" styling (see ThemeToggle.tsx) so it
 * sits naturally alongside it in SidebarAccountMenu.
 *
 * `t`/`__t` are stateless functions, not hooks subscribed to a React
 * context, so there's no in-place way to re-render every already-rendered
 * string when the language changes — `setLocale` persists the choice and
 * reloads the page instead.
 */
export function LanguageSwitcher({ className, onAfterSwitch }: LanguageSwitcherProps) {
  const current = getCurrentLocale();
  const currentIndex = AVAILABLE_LOCALES.indexOf(current);
  const next = AVAILABLE_LOCALES[(currentIndex + 1) % AVAILABLE_LOCALES.length] ?? AVAILABLE_LOCALES[0];

  function handleClick() {
    setLocale(next);
    onAfterSwitch?.();
  }

  return (
    <button
      type="button"
      className={cn(
        "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent",
        className,
      )}
      onClick={handleClick}
      aria-label={`Switch language to ${LOCALE_LABELS[next]}`}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Languages className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{LOCALE_LABELS[next]}</span>
    </button>
  );
}
