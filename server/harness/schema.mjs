// Corresponds to claude-quickstarts/agents/utils/schema.py

/**
 * Clean schema to meet requirements of different vendors
 */
/**
 * @param opts.compat "Parameter compatibility mode": cleans according to Gemini's `Schema` type.
 *   If omitted, inferred from vendor: enabled for Gemini, disabled for others.
 *   Why separate from vendor: routing through OpenAI-compatible endpoints (routers, third-party gateways)
 *   might also connect to Gemini models, where the vendor field says openai, but schema must follow
 *   Gemini rules: decided by caller based on model name or user toggle.
 */

/**
 * What fields Gemini's `Schema` actually has: taken from the v1beta discovery contract
 * (the Schema definition in `$discovery/rest?version=v1beta`), not guessed:
 *
 *   type format title description default example nullable enum
 *   minLength maxLength pattern minimum maximum minItems maxItems
 *   minProperties maxProperties required properties items anyOf propertyOrdering
 *
 * Therefore, the claim that "Gemini only recognizes the narrowest subset" is itself **outdated**.
 * Here we only delete those truly not in the manifest, keeping everything else: the cost of
 * over-deleting is not "insurance", but a real loss of capability; see the KEEP notes below.
 */
const GEMINI_UNKNOWN_KEYS = [
  '$schema',
  // This is the only true hard limit, and the exact root cause of "free-form objects cannot be expressed"
  // (see the section below)
  'additionalProperties',
  // Manifest only has singular example; rewrite plural into singular instead of dropping
  'examples',
  // Manifest only has minimum / maximum; rewrite open intervals to closed interval approximations, do not drop
  'exclusiveMinimum',
  'exclusiveMaximum',
];

/**
 * Previously deleted as well, but actually recognized by Gemini: `title` `default` `minItems`
 * `maxItems`.
 *
 * Deleting `title` caused real damage: `card-params-schema.mjs` expands the free-form object "card
 * parameters" into a series of `anyOf` branches, each labeled with `title: card.id` to indicate
 * which card it is: that was the model's **only clue** to recognize "which card's parameters to
 * fill in", and it was deleted here. In other words, compatibility mode claimed that "Gemini cannot
 * pass parameters" while tearing down the solution already built in this project.
 *
 * Keep `format` as well, but filter its values: Gemini only recognizes float/double for NUMBER,
 * int32/int64 for INTEGER, and enum/date-time for STRING. Passing types like `uri` / `email` /
 * `uuid` returns 400, so filter them against an allowlist.
 */
const GEMINI_FORMATS = new Set(['float', 'double', 'int32', 'int64', 'enum', 'date-time']);

export function sanitizeSchema(schema, vendor, opts = {}) {
  const clone = JSON.parse(JSON.stringify(schema || {}));
  const compat = typeof opts.compat === 'boolean' ? opts.compat : vendor === 'gemini';

  function processNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    if (compat) {
      // Rewrite plural examples to singular example; do not needlessly drop a few-shot prompt
      if (node.examples !== undefined && node.example === undefined && Array.isArray(node.examples) && node.examples.length) {
        node.example = node.examples[0];
      }
      // Open intervals have no corresponding fields, fall back to closed intervals:
      // a looser constraint is better than the entire constraint disappearing
      if (node.exclusiveMinimum !== undefined && node.minimum === undefined) node.minimum = node.exclusiveMinimum;
      if (node.exclusiveMaximum !== undefined && node.maximum === undefined) node.maximum = node.exclusiveMaximum;
      for (const k of GEMINI_UNKNOWN_KEYS) delete node[k];
      // Keep format, but only keep the values recognized by Gemini
      if (node.format !== undefined && !GEMINI_FORMATS.has(node.format)) delete node.format;
    }

    /*
     * Nested free-form objects (without properties) must stay free-form.
     * Previously, an empty properties was added here, which was equivalent to rewriting "any object"
     * into "an object without any fields": following this schema, the model could only return {}.
     * Adding additionalProperties: true makes "fill in anything" clear.
     *
     * **No equivalent syntax in compatibility mode**: Gemini's Schema lacks additionalProperties,
     * and it requires object to have properties, so it can only fall back to an empty object.
     *
     * This degradation is practically never reached on the actual execution path, because the real
     * solution lies elsewhere: `card-params-schema.mjs` expands "card parameters" into a series of
     * `anyOf` branches at the moment the request is sent (one per card, with actual fields inside
     * the branch), without any need to express "objects with unfixed fields". Reaching this line
     * leaves only one case: a fallback when the card list cannot be retrieved and expansion fails.
     * So keep the explanation, but stop using it as an argument that "Gemini cannot pass parameters".
     */
    if (node.type === 'object' && !node.properties && !node.anyOf && !node.oneOf) {
      if (compat) node.properties = {};
      else node.additionalProperties = true;
    }

    if (Array.isArray(node.anyOf)) node.anyOf.forEach(processNode);
    if (Array.isArray(node.oneOf)) node.oneOf.forEach(processNode);

    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) {
        processNode(node.properties[key]);
      }
    }
    if (node.items) {
      processNode(node.items);
    }
  }

  processNode(clone);
  
  if (vendor === 'openai' || vendor === 'anthropic' || vendor === 'gemini') {
    if (clone.type !== 'object') {
      clone.type = 'object';
    }
    if (!clone.properties) {
      clone.properties = {};
    }
  }
  
  return clone;
}

/**
 * Convert internal Tool shapes into tool declarations for the three provider APIs
 */
export function toolToVendor(tool, vendor, opts = {}) {
  const { name, description, inputSchema } = tool;
  const sanitizedSchema = sanitizeSchema(inputSchema, vendor, opts);

  if (vendor === 'anthropic') {
    return {
      name,
      description,
      input_schema: sanitizedSchema
    };
  } else if (vendor === 'openai') {
    return {
      type: 'function',
      function: {
        name,
        description,
        parameters: sanitizedSchema
      }
    };
  } else if (vendor === 'gemini') {
    return {
      name,
      description,
      parameters: sanitizedSchema
    };
  }
  
  return { name, description, inputSchema: sanitizedSchema };
}
