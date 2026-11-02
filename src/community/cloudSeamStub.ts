/*
 * Empty stub for community edition: aliases for the several "cloud extension packages" on the
 * browser side point here when no closed source directory exists.
 *
 * Why it is needed: call sites on the browser side reference **alias specifiers**
 * (`#promptcut-cloud-*`), resolved at build time by `server/vite-plugin-cloud-seams.ts`. The community
 * edition has no closed source directory, but aliases must still resolve to a real module; otherwise
 * `vite build` would immediately report "Failed to resolve import": a build-time failure, not a
 * graceful runtime downgrade. Therefore, an empty module exporting nothing is provided here.
 *
 * Call sites determine "whether installed" by checking presence of `register` / `registerUi` /
 * `manifest` exports. This file exports none of them, so they all fall back to default implementations
 * included on the open side (LAN member source, cloud closed, codeVersion as null, etc.), which is
 * exactly what the community edition should be.
 */
export {};
