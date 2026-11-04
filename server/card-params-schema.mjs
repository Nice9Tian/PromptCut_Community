/**
 * Generates real JSON Schema for `params` of add_clip / update_clip.
 *
 * Why it is needed: valid fields of `params` depend on cardId and cannot be written statically.
 * The original code was `params: { type: "object" }`: a free-form object without any property
 * descriptions. When the MCP server goes through tools/list, it dynamically replaces this with the
 * anyOf below, but **direct API has never done this step**. Consequently, what the model receives
 * is `{ type:"object", properties:{} }` normalized by sanitizeSchema, which means "this object has
 * no properties": the model is therefore **completely unable to pass any card parameters**,
 * and created cards always have params: {}. Caption cards lack lines, motion graphics cards are all
 * default values: the root cause is right here.
 *
 * Both paths now share this logic, eliminating the asymmetry where "CLI can pass them, but API cannot".
 */

import { PARAMS_PATCH_DESC } from "./tools/clips.mjs";

/** Control type → JSON Schema type */
function typeOf(control) {
  if (control.type === "number") return { type: "number" };
  if (control.type === "select") {
    return { type: "string", enum: control.options?.map((o) => o.value) ?? [] };
  }
  return { type: "string" };
}

function describe(control) {
  const bits = [control.label].filter(Boolean);
  if (control.required) bits.push("required");
  if (control.hint) bits.push(control.hint);
  // Asset catalog: lists candidate URLs, but does not use enum: URLs outside the catalog /
  // inline JSON are also valid
  if (control.type === "asset" && Array.isArray(control.options) && control.options.length) {
    bits.push("Media catalog:" + control.options.map((o) => `${o.value}(${o.label})`).join(";"));
  }
  return bits.join(" · ") || undefined;
}

/**
 * @param cards Return value of list_cards({ detail: 'full' }), each item must have id / controls
 * @param opts.patch true: "delta patch" version for update_clip. params is a patch there, only
 *        writing keys to change, so it omits `required` (required keys are already on the clip, no
 *        need to retransmit every time) and the description explicitly states "unpassed keys retain
 *        current values". Production 2026-10-21: when the model saw required and the full set of
 *        fields, it brought back the entire parameters from memory, writing back the color the user
 *        had just undone.
 * @returns Schema that can be plugged directly into add_clip.params / update_clip.params
 */
export function buildParamsSchema(cards, opts = {}) {
  const usable = (cards || []).filter((c) => c && typeof c.id === "string" && Array.isArray(c.controls));
  if (usable.length === 0) return null;
  const patch = opts.patch === true;

  return {
    type: "object",
    description: patch
      ? `${PARAMS_PATCH_DESC}Valid fields depend on the card's current cardId (the new card's fields apply only when the card is switched); each branch below corresponds to one card.`
      : "Card parameters; valid fields depend on cardId. Each branch below corresponds to one card; first use list_cards({cardId}) to check that card's controls, then fill them in.",
    anyOf: usable.map((card) => {
      const properties = {};
      const required = [];
      for (const control of card.controls) {
        properties[control.key] = { ...typeOf(control), description: describe(control) };
        if (control.required) required.push(control.key);
      }
      return {
        title: card.id,
        type: "object",
        properties,
        ...(required.length && !patch ? { required } : {}),
        // Leave an escape hatch: parameters newly added to a card can still be passed in before entering this schema
        additionalProperties: true,
      };
    }),
  };
}

/**
 * Replaces params of add_clip / update_clip in place with the real schema.
 * Returns as-is when card list cannot be retrieved: better to fall back to a free-form object
 * than make the tool completely unusable due to schema assembly failure.
 */
export function injectCardParams(tools, cards) {
  const schema = buildParamsSchema(cards);
  if (!schema) return tools;
  const patchSchema = buildParamsSchema(cards, { patch: true });
  for (const tool of tools) {
    // Touches only the two card tools: add_part / set_part also have params, but those belong to parts
    // and are managed by injectPartParams
    if (tool?.name !== "add_clip" && tool?.name !== "update_clip") continue;
    const props = tool?.inputSchema?.properties ?? tool?.parameters?.properties;
    // params of update_clip is a delta patch; use patch version (omits required, description states
    // unpassed keys retain current values)
    if (props && "params" in props) props.params = tool.name === "update_clip" ? patchSchema : schema;
  }
  return tools;
}

/* ── Parts: params of add_part / set_part, parts of add_composite ──────────── */

const FRAME_SCHEMA = {
  type: "object",
  description: "Frame relative to the parent frame: x / y anchor position (pixels), w / h size, anchor [ax, ay] (default [0,0]), scale, rotate; if omitted, the part's defaultFrame is used",
  properties: {
    x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
    anchor: { type: "array", items: { type: "number" } }, scale: { type: "number" }, rotate: { type: "number" },
  },
  required: ["x", "y"],
};

/** Schema for part parameters branched by partId; same approach as the card one */
export function buildPartParamsSchema(parts) {
  const usable = (parts || []).filter((p) => p && typeof p.id === "string" && Array.isArray(p.controls));
  if (usable.length === 0) return null;
  return {
    type: "object",
    description: "Part parameters; valid fields depend on partId; every part with text has size, and 0 = fit to the frame. First use list_parts({ partId }) to check controls.",
    anyOf: usable.map((part) => {
      const properties = {};
      const required = [];
      for (const control of part.controls) {
        properties[control.key] = { ...typeOf(control), description: describe(control) };
        if (control.required) required.push(control.key);
      }
      return { title: part.id, type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
    }),
  };
}

/**
 * Schema for add_composite.parts: each item is { partId, params, frame, enterMs, label, children }.
 * children cannot recurse infinitely (Gemini does not support $ref); expanding two levels is
 * enough; add deeper ones with add_part.
 */
export function buildPartsListSchema(parts, paramsSchema) {
  const ids = (parts || []).map((p) => p?.id).filter((id) => typeof id === "string");
  const item = (children) => ({
    type: "object",
    properties: {
      partId: { type: "string", ...(ids.length ? { enum: ids } : {}), description: "Part id from list_parts" },
      params: paramsSchema ?? { type: "object", additionalProperties: true },
      frame: FRAME_SCHEMA,
      enterMs: { type: "number", description: "Milliseconds relative to the parent's entrance" },
      label: { type: "string" },
      ...(children ? { children } : {}),
    },
    required: ["partId"],
    additionalProperties: true,
  });
  return { type: "array", items: item({ type: "array", items: item({ type: "array", items: item(null) }) }), description: "List of part instances; nest at most three levels here, use add_part for deeper ones" };
}

/** Replace params of add_part / set_part and parts of add_composite with real schemas in place; return as-is if part list cannot be obtained */
export function injectPartParams(tools, parts) {
  const schema = buildPartParamsSchema(parts);
  if (!schema) return tools;
  for (const tool of tools) {
    const props = tool?.inputSchema?.properties ?? tool?.parameters?.properties;
    if (!props) continue;
    if ((tool.name === "add_part" || tool.name === "set_part") && "params" in props) props.params = schema;
    if (tool.name === "add_composite" && "parts" in props) props.parts = buildPartsListSchema(parts, schema);
    if ((tool.name === "add_part" || tool.name === "set_part") && "frame" in props) props.frame = { ...FRAME_SCHEMA, description: props.frame?.description ?? FRAME_SCHEMA.description };
  }
  return tools;
}
