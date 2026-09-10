/**
 * Inkstone host half.
 *
 * A pure colour theme lives entirely in the browser: the palette reaches the
 * DOM through `ctx.theme.overrideTokens` inside the client bundle. The Loader
 * still needs a host-side row for the package before `dsh-client-modules` will
 * compose that bundle into the boot graph, so this export exists to give it an
 * empty, side-effect-free anchor.
 */
export function apply() {}
