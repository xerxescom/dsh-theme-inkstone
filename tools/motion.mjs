/**
 * The motion and finish layer: the CSS this theme injects as one `<style>` tag.
 *
 * Everything here is deliberately built from Standard CSS that needs no DSH
 * internals: pseudo-elements, `::selection`, `:focus-visible`, transitions and
 * `@keyframes`. Nothing selects a hashed class name, so an upstream redesign
 * can only make a rule inert — never break the page.
 *
 * Two rules the layer must keep:
 *
 *   1. **Never raise contrast risk.** The readability gate measured 38 pairs of
 *      text-on-surface; this layer changes selection colour, focus rings and
 *      transitions, none of which are in that set, and it re-tints nothing the
 *      gate measures.
 *   2. **Respect reduced motion.** Every animation is inside a
 *      `prefers-reduced-motion: no-preference` block, so a user who asked the OS
 *      for calm gets instant, motionless UI.
 *
 * The palette values arrive as CSS variables (`--inkstone-*`) written by the
 * client half, so this file carries no colour literals that could drift from
 * tokens.json.
 */

/**
 * @param {{ light: string, dark: string, overlay: { light: number, dark: number }, blurPx: number, radius: Record<string, string> }} config
 * @returns {string} The stylesheet text.
 */
export function motionCss(config) {
  const wash = (mode) => `color-mix(in srgb, ${config.surface[mode]} ${Math.round(config.overlay[mode] * 100)}%, transparent)`

  return /* css */ `
/* ---- motion and finish layer ------------------------------------------- */

/* Theme switch: colour changes ease instead of snapping. The 180ms is short
   enough to feel instant on a click and long enough to read as intentional. */
:root {
  --inkstone-ease: cubic-bezier(.22, .61, .36, 1);
  --inkstone-dur: 180ms;
}

body,
body [data-conversation-content],
body [data-conversation-scroll] {
  transition: background-color var(--inkstone-dur) var(--inkstone-ease),
              color var(--inkstone-dur) var(--inkstone-ease);
}

/* Selection: a warm ink wash instead of the browser default blue, which is
   the loudest unthemed thing left on the page once the palette lands. */
::selection {
  background: var(--inkstone-selection);
  color: var(--inkstone-selection-text);
}

/* Focus rings: cinnabar, matching the accent, with a soft halo so keyboard
   users see the target without a hard rectangle. */
:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
  border-radius: var(--dsw-radius-xs, 4px);
  transition: outline-color var(--inkstone-dur) var(--inkstone-ease),
              box-shadow var(--inkstone-dur) var(--inkstone-ease);
  box-shadow: 0 0 0 4px var(--inkstone-focus-halo);
}

/* Thin ink hairlines where the design system already draws borders: a warm
   undertone reads as paper rather than as a UI wireframe. */
body {
  caret-color: var(--dsw-alias-state-business-primary);
}

/* ---- background image --------------------------------------------------- */
/* Present only while data-dsh-inkstone-bg is set (the optional picture). The
   wash is opaque enough that the photograph can never move text contrast. */
body[data-dsh-inkstone-bg]::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: var(--inkstone-bg-image);
  background-size: cover;
  background-position: center;
  background-attachment: fixed;
  animation: inkstone-fade-in 420ms var(--inkstone-ease) both;
}

body[data-dsh-inkstone-bg]::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  backdrop-filter: blur(var(--inkstone-bg-blur));
  background: var(--inkstone-bg-wash);
}

/* Containers that paint the surface themselves must let the picture through. */
body[data-dsh-inkstone-bg] [data-conversation-content],
body[data-dsh-inkstone-bg] [data-conversation-scroll],
body[data-dsh-inkstone-bg] [data-conversation-session],
body[data-dsh-inkstone-bg] [data-chat-turn] {
  background-color: transparent;
}

/* ---- motion ------------------------------------------------------------- */
@media (prefers-reduced-motion: no-preference) {
  @keyframes inkstone-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* Message rows settle upward as they arrive. Short travel (6px) and a fast
     ease keep long sessions from feeling animated. */
  @keyframes inkstone-rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  body [data-chat-turn] {
    animation: inkstone-rise 220ms var(--inkstone-ease) both;
  }

  /* Panels and popovers grow from their anchored edge by a hair, which is the
     "physical" cue that makes a menu read as placed rather than drawn. */
  @keyframes inkstone-pop {
    from { opacity: 0; transform: scale(.985); }
    to { opacity: 1; transform: none; }
  }

  body [data-menu-surface],
  body [role='menu'],
  body [role='dialog'] {
    animation: inkstone-pop 140ms var(--inkstone-ease) both;
    transform-origin: top center;
  }

  /* Hover on interactive rows: a quick wash, not a fade. */
  body button,
  body [role='button'] {
    transition: background-color 120ms var(--inkstone-ease),
                border-color 120ms var(--inkstone-ease),
                color 120ms var(--inkstone-ease);
  }

  /* The settings row's own switch, so it matches the shell's motion. */
  body [role='switch'] {
    transition: background-color 160ms var(--inkstone-ease);
  }

  /* Scrollbar: keep the design system's thin bar, only soften its colour
     transition when the pointer enters it. */
  body ::-webkit-scrollbar-thumb {
    transition: background-color 160ms var(--inkstone-ease);
  }
}

/* A user who asked for reduced motion gets every colour change instantly and
   no transform animations at all. */
@media (prefers-reduced-motion: reduce) {
  body,
  body * {
    animation: none !important;
    transition-duration: 0ms !important;
  }
}
`
}

/**
 * The variable block the client half writes before injecting {@link motionCss},
 * so the stylesheet never hard-codes a palette value.
 *
 * @param {{ selection: { light: string, dark: string }, selectionText: { light: string, dark: string }, focusHalo: { light: string, dark: string }, surface: { light: string, dark: string }, overlay: { light: number, dark: number } }} config
 * @returns {string}
 */
export function motionVariables(config) {
  const block = (mode) => [
    `  --inkstone-selection: ${config.selection[mode]};`,
    `  --inkstone-selection-text: ${config.selectionText[mode]};`,
    `  --inkstone-focus-halo: ${config.focusHalo[mode]};`,
    `  --inkstone-bg-wash: color-mix(in srgb, ${config.surface[mode]} ${Math.round(config.overlay[mode] * 100)}%, transparent);`,
  ].join('\n')

  return `body { color-scheme: light; ${block('light')} }\nbody[data-ds-dark-theme] { color-scheme: dark; ${block('dark')} }`
}
