/**
 * No-op server-side half of the trajectory-counter plugin.
 *
 * The package must be a LOADER ENTRY for the host's client-module scanner to
 * discover its `dsh.client` declaration and serve the browser bundle. The
 * server half intentionally does nothing — all behavior lives in
 * `client/client.js` (the `exports["./client"]` bundle).
 *
 * @module dsh-trajectory-counter
 */

/** Stable Cordis plugin name for this row. */
export const name = "trajectory-counter";

/** No-op plugin body: nothing to configure on the node side. */
export function apply() {}
