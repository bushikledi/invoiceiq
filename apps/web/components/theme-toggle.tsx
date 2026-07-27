'use client';

import { useTheme, type ThemePreference } from '../lib/theme';

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'system', label: 'System', icon: '◐' },
  { value: 'dark', label: 'Dark', icon: '☾' },
];

/**
 * A three-way segmented control, not a two-state switch.
 *
 * A toggle can only say "dark: on/off", which silently discards the "follow my
 * machine" option — and once discarded it cannot be chosen again, because there
 * is no gesture for it. Someone who wants their laptop's sunset switch to keep
 * working has no way back.
 *
 * Implemented as radios rather than buttons: the three are mutually exclusive
 * and one is always selected, which is what a radio group *means*. Screen
 * readers announce it as "Theme, 2 of 3", and arrow keys move between options,
 * both for free.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <fieldset className="flex items-center rounded-lg border border-line bg-surface-muted p-0.5">
      <legend className="sr-only">Theme</legend>

      {OPTIONS.map((option) => {
        const active = preference === option.value;
        return (
          <label
            key={option.value}
            title={option.label}
            className={`cursor-pointer rounded-md px-2 py-1 text-xs leading-none transition ${
              active ? 'bg-surface text-ink shadow-sm' : 'text-ink-subtle hover:text-ink'
            }`}
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={active}
              onChange={() => setPreference(option.value)}
              className="sr-only"
            />
            <span aria-hidden className="text-sm">
              {option.icon}
            </span>
            <span className="sr-only">{option.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
