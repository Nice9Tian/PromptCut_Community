/**
 * Which role this process plays in the three-tier separation (Section 3 of
 * docs/archive/topics/decoupling-plan.md).
 *
 *   ui         : User's own dev server: serves editor page, MCP bridge, data mirror, interface
 *                hot standby renderer.
 *   prerender  : Prerender process: second Vite (vite.prerender.config.ts) spawned by ui side,
 *                independent process, independent port, below-normal priority. Render pool,
 *                export, and Agent image-viewing requests are all here.
 *
 * Why it must be split: Browsers open only about 6 HTTP/1.1 connections to the same origin. Render
 * requests hang for seconds to minutes; crowding onto the same origin as the editor exhausts
 * connections: in testing, lightweight requests queued for 7.7 seconds while CPU was not busy at all.
 */
export const ROLE = process.env.PROMPTCUT_ROLE === "prerender" ? "prerender" : "ui";
export const isPrerender = ROLE === "prerender";
