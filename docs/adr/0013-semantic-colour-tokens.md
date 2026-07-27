# 13. Colours are named by role, not by palette

**Status:** accepted

## Context

The app shipped light-only, with a comment in `globals.css` explaining that a
real dark theme meant restyling every component. That was true. The reason it
was true was the actual problem.

Components named palette values directly — `bg-white`, `text-slate-500`,
`border-slate-200` — so "what colour is a card?" was answered in forty files.
An earlier attempt at dark mode declared `color-scheme: light dark` and a dark
body, which produced black behind white cards: not a dark theme, a broken light
one.

## Decision

Name colours by **role** and let the role resolve per theme:
`surface`, `ink`, `line`, `accent`, plus four tone families
(`positive`, `caution`, `critical`, `info`), each with a fill, a border and
readable text on that fill.

Emit them with Tailwind's `@theme inline`, so utilities reference
`var(--surface)` at runtime rather than resolving at build time. One variable
swap re-themes everything.

## Consequences

No `dark:` variants anywhere. That was the alternative and it is worse: it
doubles every class list and still leaves two hard-coded palettes to keep in
sync — the failure mode being a component someone updated in one theme and not
the other, which looks fine to whoever is not using the other one.

A card is `bg-surface`, full stop. Whether that is white or near-black is
decided in one file.

Dark is **derived, not inverted**. Surfaces get _lighter_ as they come forward,
the opposite of the light ramp, because on a dark canvas a raised element reads
as raised by emitting more light. Inverting the light ramp gives cards that look
like holes. The tone fills are desaturated and darkened well past their light
counterparts: an amber tuned to sit gently on white glows on near-black, and a
column of "needs review" badges at that intensity is the only thing anyone can
look at.

Three-way preference — light, system, dark — not a switch. A boolean cannot
express "follow my machine", and once that is discarded there is no gesture to
get it back: someone who wants their laptop's sunset switch to keep working has
no way to say so. Implemented as radios, so "Theme, 2 of 3" and arrow-key
navigation come for free.

## What this cost us

An inline script in `<head>`, applied before React hydrates, and
`suppressHydrationWarning` on `<html>`. Without it the first paint uses the CSS
default and a dark-mode user gets a white flash on every navigation — loudest
for exactly the people who chose dark to avoid being flashed at.

It also needs `'unsafe-inline'` in the script CSP, which is recorded honestly in
[`docs/security-review.md`](../security-review.md) rather than glossed over. The
alternative — nonces — means rendering every page dynamically.

## Alternatives

**A CSS-in-JS theme provider.** Runtime cost, and it puts theming behind a React
boundary, so the pre-hydration script could not use it — reintroducing the flash
this exists to prevent.

**Staying light-only.** Defensible, and it was the previous decision. It stopped
being defensible once the reason for it was "our colours are in the wrong
place", because that is a problem worth fixing on its own merits.
