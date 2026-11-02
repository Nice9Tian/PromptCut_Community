import type { AiProvider } from "./types";
import { tr } from "../i18n/index.ts";

/**
 * What each driver actually supports, and what the current run has selected.
 *
 * The capability table was not guessed; it comes from asking each CLI for --help on this machine:
 *   claude  --model / --effort low|medium|high|xhigh|max / fastMode (passed via --settings)
 *   codex   -m --model / reasoning tier only via -c model_reasoning_effort= / no fast mode
 *   agy     --model / --effort low|medium|high / no fast mode
 * What is unsupported is grayed out in the UI; no fake switches: a switch that does nothing when
 * clicked is worse than no switch.
 */

/**
 * Reasoning effort. Empty string = follow each provider's own default, no flag is passed.
 *
 * `minimal` is now **offered by no driver** (it used to be in codex's list, but upstream does not
 * recognize it, and selecting it gives a 400). It stays in the type for one reason only: the user's
 * browser may still hold this old value, and keeping it in the type is what makes that line up;
 * the UI downgrades values not in the list to the default (see ModelBar), so it cannot be sent.
 * Do not add it back to some provider's efforts just because "the type has it".
 */
export type EffortLevel = "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCapability {
  /** Supported reasoning-effort tiers; empty array = unsupported by this provider, grayed out in the UI */
  efforts: EffortLevel[];
  /** Whether "fast mode" is supported. Only Claude Code has it (fastMode in settings) */
  fast: boolean;
  /** Fallback suggestions when no model list is configured; the user can change them in the AI settings */
  suggestedModels: string;
  /** Where this provider's model list comes from */
  modelsHint: string;
}

export const CAPABILITIES: Record<AiProvider, ProviderCapability> = {
  claude: {
    efforts: ["", "low", "medium", "high", "xhigh", "max"],
    fast: true,
    suggestedModels: "opus|sonnet|haiku",
    modelsHint: tr("An alias is enough (opus / sonnet / haiku), or enter a full model name"),
  },
  codex: {
    /*
     * codex has no --effort, and can only override the config item with -c model_reasoning_effort=.
     *
     * This list must match the values upstream recognizes. A user's diagnostic report hit this once: the
     * user picked `minimal` from this dropdown and the request got a 400 right away:
     *   Unsupported value: 'minimal' is not supported with the 'gpt-5.6-terra' model.
     *   Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.
     * It was wrong at both ends: we offered `minimal`, which upstream does not recognize; and upstream
     * recognizes `none` and `max`, which we did not offer.
     * With an option in the menu that is bound to return a 400, there is no way the user could guess
     * the fault is ours.
     */
    efforts: ["", "none", "low", "medium", "high", "xhigh", "max"],
    fast: false,
    suggestedModels: "gpt-5.6-terra|gpt-5.6-sol",
    modelsHint: tr("Enter model names supported by codex, separate multiple with |"),
  },
  agy: {
    efforts: ["", "low", "medium", "high"],
    fast: false,
    suggestedModels: "",
    modelsHint: tr("You can click \"Read from CLI\" to pull the agy models list directly"),
  },
  api: {
    /*
     * low / medium / high are the values of `reasoning_effort` in the OpenAI-compatible convention, and
     * relay services accept them as well (openlux docs: "Inference model strength (such as low / medium /
     * high)").
     * minimal / xhigh / max are not offered: those tiers are each CLI's own extensions that the
     * OpenAI-compatible interface does not recognize, and listing them would only let the user pick a
     * value upstream would answer with a 400.
     *
     * When "Default" (empty) is selected, no field is sent at all: some model names carry a `-thinking`
     * suffix and the gateway injects the tier itself, so forcing one in would overwrite it.
     */
    efforts: ["", "low", "medium", "high"],
    fast: false,
    suggestedModels: "",
    modelsHint: tr("Separate multiple models with |, then you can switch between them in the panel"),
  },
};

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  "": tr("default"),
  // codex's none means "explicitly turn thinking off", which is not the same as "" (do not send the
  // parameter, let it use its own default)
  none: tr("Close"),
  minimal: tr("Minimal"),
  low: tr("Low"),
  medium: tr("Medium"),
  high: tr("High"),
  xhigh: tr("Very high"),
  max: tr("Max"),
};

/**
 * `a|b|c` → ["a","b","c"]. Empty segments and surrounding spaces are removed, so the user may write
 * it casually as `a | b`
 */
export function parseModelList(raw: string | undefined | null): string[] {
  return String(raw ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── What this run has selected ──────────────────────────────────
 * Stored in localStorage rather than ai.json: this is "which one I want to use right now on this
 * machine", so switching model should not count as changing the configuration, and it should not
 * travel with the project files either. It is recorded per provider, so switching from Claude to
 * Codex does not carry the model name over (that name does not exist on the other side at all).
 */

const KEY = (kind: string, provider: AiProvider) => `pc.ai.${kind}.${provider}`;

function read(kind: string, provider: AiProvider): string {
  try {
    return localStorage.getItem(KEY(kind, provider)) ?? "";
  } catch {
    return "";
  }
}

function write(kind: string, provider: AiProvider, value: string): void {
  try {
    if (value) localStorage.setItem(KEY(kind, provider), value);
    else localStorage.removeItem(KEY(kind, provider));
  } catch {
    /* If incognito mode cannot remember it, so be it; it still takes effect within this session */
  }
}

export interface RunChoice {
  /** Empty = use that driver's own default model */
  model: string;
  effort: EffortLevel;
  fast: boolean;
  /**
   * Parameter compatibility mode: the tool schema is sanitized down to Gemini's narrowest subset.
   * auto = inferred from the model name (on if it contains gemini); on / off are set manually by the
   * user. Claude / GPT series are locked off and Gemini is locked on; only other vendors let the user
   * adjust it (see compatPolicy).
   */
  schemaCompat: SchemaCompat;
  /**
   * Deep autonomy: raises the round limit of a run from the usual few dozen rounds to 300, and **no
   * longer puts anything about rounds into the model's hands**. Off by default: the usual limit exists
   * to stop runs that have gone astray, and turning this on hands that gate over to the user's own
   * judgment, so turn it on only when you explicitly want it to run on its own for a long time.
   */
  deepAuto: boolean;
}

export type SchemaCompat = "auto" | "on" | "off";

export function readChoice(provider: AiProvider): RunChoice {
  const compat = read("schemaCompat", provider);
  return {
    model: read("model", provider),
    effort: read("effort", provider) as EffortLevel,
    fast: read("fast", provider) === "1",
    deepAuto: read("deepAuto", provider) === "1",
    schemaCompat: compat === "on" || compat === "off" ? compat : "auto",
  };
}

export function writeChoice(provider: AiProvider, patch: Partial<RunChoice>): void {
  if (patch.model !== undefined) write("model", provider, patch.model);
  if (patch.effort !== undefined) write("effort", provider, patch.effort);
  if (patch.fast !== undefined) write("fast", provider, patch.fast ? "1" : "");
  if (patch.deepAuto !== undefined) write("deepAuto", provider, patch.deepAuto ? "1" : "");
  if (patch.schemaCompat !== undefined) write("schemaCompat", provider, patch.schemaCompat === "auto" ? "" : patch.schemaCompat);
}

/**
 * What the parameter compatibility switch should look like under this driver / model.
 *   - The two CLI routes Claude Code / Codex, and direct-API models whose name contains claude / gpt /
 *     o1~o9 / codex: locked off (they take the full schema);
 *   - Direct-API models whose name contains gemini: locked on;
 *   - The agy CLI route: **this switch is not handled at all** (see applies);
 *   - Everything else (other vendors' models reached via direct API, models whose name reveals
 *     nothing): the user adjusts it, defaulting to an inference from the vendor field.
 * When the model name carries no vendor information, fall back to vendor; a Router may put Gemini
 * behind an openai-compatible interface, so the model name takes priority.
 *
 * `applies = false` means **this switch has no effect at all on this route** and the UI should not
 * show it.
 * agy is exactly this case: its tools are exposed by the MCP service registered with
 * `agy mcp add promptcut` and go through mcp-server.mjs, never passing sanitizeSchema; in the whole
 * repository only runners/api.mjs reads `schemaCompat`.
 * It used to return "locked on" for agy here, so the panel showed a button that did nothing when
 * pressed.
 */
export function compatPolicy(provider: AiProvider, model: string, vendor: string | undefined, pref: SchemaCompat): { on: boolean; locked: boolean; reason: string; applies: boolean } {
  const m = (model || "").toLowerCase();
  if (provider === "claude" || provider === "codex") return { on: false, locked: true, applies: true, reason: "Claude Code / Codex take the full tool schema, no compatibility mode needed" };
  if (provider === "agy") return { on: true, locked: true, applies: false, reason: "Antigravity tools are registered through MCP and don't go through the schema cleanup here, so this switch has no effect on it" };
  if (/claude/.test(m) || /(^|[^a-z])(gpt|o[1-9]|codex)/.test(m)) return { on: false, locked: true, applies: true, reason: "Claude / GPT models take the full tool schema, no compatibility mode needed" };
  /*
   * Gemini is still locked on, but **the reason has changed**; stop describing it as "only accepts the
   * narrowest subset". Per the v1beta discovery contract, its Schema accepts title / default /
   * minItems / maxItems / format and so on; what it truly does not accept is only additionalProperties
   * / $schema / exclusiveMinimum / exclusiveMaximum (see harness/schema.mjs).
   * So turning this switch off would send additionalProperties as is, which really does give a 400,
   * hence it stays locked.
   */
  if (/gemini/.test(m)) return { on: true, locked: true, applies: true, reason: "Gemini doesn't recognize these additionalProperties fields and sending them returns a 400, so this tier is locked on" };
  const auto = vendor === "gemini";
  const on = pref === "on" ? true : pref === "off" ? false : auto;
  return { on, locked: false, applies: true, reason: `Can't tell the vendor from the model name: ${auto ? tr("On by default per the vendor field") : tr("Off by default")}; turn it on if tool calls fail with a schema-related 400` };
}

/**
 * The value sent with the request: a locked switch gives its fixed answer outright, an adjustable
 * one hands the user's preference to the server (auto is inferred once more by the server from the
 * model name)
 */
export function compatToSend(provider: AiProvider, model: string, vendor: string | undefined, pref: SchemaCompat): SchemaCompat {
  const pol = compatPolicy(provider, model, vendor, pref);
  if (pol.locked) return pol.on ? "on" : "off";
  return pref;
}

/**
 * If the selected model is not in the list, fall back to "Default".
 * After the user deletes a model in the settings, the panel must not keep running with a name that
 * no longer exists.
 */
export function normalizeModel(model: string, available: string[]): string {
  return model && available.includes(model) ? model : "";
}

/**
 * Which models this provider currently offers. The panel's dropdown and **the moment the request is
 * actually sent** must both use this one, and not each compute their own.
 *
 * Previously only ModelBar computed it once, to fill the dropdown; sending a request used the raw
 * value from readChoice. The result: a name no longer in the list (settings were changed, or a
 * character was mistyped by hand at the time) had long since fallen back to "Default" in the
 * dropdown, yet the request still carried it. The UI showed "Default" while the CLI received a
 * model name that does not exist and exited on the spot. The user saw everything looking normal,
 * and simply never got a reply.
 */
export function modelsFor(
  provider: AiProvider,
  config: { api?: { model?: string }; cliModels?: Partial<Record<string, string>> } | null | undefined,
): string[] {
  const raw = provider === "api"
    ? parseModelList(config?.api?.model)
    : parseModelList(config?.cliModels?.[provider]);
  // agy encodes the thinking tier in the model name; the panel lists only the base name (see agyGroups)
  return provider === "agy" ? agyGroups(raw).map((g) => g.base) : raw;
}

/* ── agy: the thinking tier is encoded in the model name ─────────────────────────────────
 *
 * `agy models` gives names like gemini-3.8-flash-low / -medium / -high, where the thinking tier is
 * **part of the name**. And agy also accepts --effort; the two **must be paired**, and it refuses
 * outright when they do not match:
 *
 *   --model gemini-3.8-flash-low  --effort low    ✓
 *   --model gemini-3.8-flash-low  --effort high   ✗ invalid model selection
 *   --model gemini-3.8-flash      --effort low    ✓ base name + tier, same as the first line
 *   --model gemini-3.8-flash                      ✗ requires --effort (available: low, medium, high)
 *   --model gemini-3.1-pro        --effort medium ✗ has no "medium" effort (available: low, high)
 *   --model claude-sonnet-4-6     --effort low    ✗ --effort is not supported for this model
 *
 * So the tiers cannot be a fixed table: **which tiers each model has must be counted from the list**
 * (gemini-3.1-pro has only low / high and no medium; claude-sonnet-4-6 has no tier at all).
 * The panel folds a suffixed name into one base name, leaves the choice of tier to the "Thinking"
 * dropdown, and puts the pair back together in the form agy accepts when the request is sent.
 */

/**
 * An agy model and which thinking tiers it actually supports (empty array = this model does not
 * take --effort)
 */
export interface AgyModelGroup {
  base: string;
  efforts: EffortLevel[];
}

/**
 * The thinking tier at the end of the name. Only these three are recognized: a suffix like
 * claude-opus-4-6-**thinking** is not a tier
 */
const AGY_EFFORT_SUFFIX = /^(.+)-(low|medium|high)$/;

/** From low to high. Used to step down one tier when the stored tier does not match this model */
const AGY_EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high"];

/**
 * Folds the list of names from `agy models` into "base name + the tiers it supports".
 * The order follows first appearance in the list, and the tiers are sorted low → medium → high (in
 * the UI it reads naturally only from light to heavy).
 */
export function agyGroups(models: string[]): AgyModelGroup[] {
  const byBase = new Map<string, Set<string>>();
  for (const name of models) {
    const m = AGY_EFFORT_SUFFIX.exec(name);
    const base = m ? m[1] : name;
    if (!byBase.has(base)) byBase.set(base, new Set());
    if (m) byBase.get(base)!.add(m[2]);
  }
  return [...byBase].map(([base, efforts]) => ({
    base,
    efforts: AGY_EFFORT_ORDER.filter((e) => efforts.has(e)),
  }));
}

/**
 * This provider's capability table; for an unrecognized driver name (for example, a spawned subagent
 * tab that reuses a driver this machine does not have, A3) it returns a table that supports
 * nothing, so the UI is drawn as usual with the controls grayed out, instead of the whole page
 * erroring because the lookup failed.
 */
const UNKNOWN_CAPABILITY: ProviderCapability = { efforts: [], fast: false, suggestedModels: "", modelsHint: "" };
export function capabilityOf(provider: string): ProviderCapability {
  return (CAPABILITIES as Record<string, ProviderCapability | undefined>)[provider] ?? UNKNOWN_CAPABILITY;
}

/**
 * Which tiers the "Thinking" dropdown should offer once this model is selected.
 *
 * Outside agy it is still each provider's fixed table. On the agy side:
 *   - No model selected (default): give the fixed table; agy's own default model accepts any tier;
 *   - A model with tiers selected: **give only the tiers it has, and no "Default"**, because a base
 *     name without --effort gets refused;
 *   - A model that takes no tiers selected (claude-sonnet-4-6): an empty array, grayed out in the UI
 *     with the text "Not supported".
 */
export function effortsFor(
  provider: AiProvider,
  model: string,
  config: { api?: { model?: string }; cliModels?: Partial<Record<string, string>> } | null | undefined,
): EffortLevel[] {
  if (provider !== "agy") return capabilityOf(provider).efforts;
  if (!model) return CAPABILITIES.agy.efforts;
  const group = agyGroups(parseModelList(config?.cliModels?.agy)).find((g) => g.base === model);
  return group ? group.efforts : CAPABILITIES.agy.efforts;
}

/**
 * Fits a possibly stale tier into the current list, and falls back to "Default" if it does not fit.
 *
 * The tier is stored in localStorage, while the list changes: 0ae554b removed codex's `minimal`
 * (upstream does not recognize it at all, and selecting it always gives a 400). That value is still
 * in old users' browsers, and the panel only downgrades it to "Default" for **display**, while the
 * request path reads the raw localStorage value, so the UI says "Default" and the request still
 * carries minimal, and gets the same 400.
 *
 * It is extracted as a pure function so that **the send path itself can be tested**: testing only
 * the CAPABILITIES list is tautological, and if the list is right but the send path is not wired up,
 * production still gets a 400 (this review caught exactly that shape).
 */
export function sanitizeEffort(
  provider: AiProvider,
  model: string,
  effort: EffortLevel,
  config: { api?: { model?: string }; cliModels?: Partial<Record<string, string>> } | null | undefined,
): EffortLevel {
  return effortsFor(provider, model, config).includes(effort) ? effort : "";
}

/**
 * The (model, effort) pair that is actually sent.
 *
 * Outside agy it is returned as is. On the agy side it assembles the panel's "base name + tier" into
 * a combination agy accepts, and **guarantees the pair matches**: if the stored tier does not exist
 * for this model (the model was switched, or it was left over from an earlier version), step down
 * one tier, and if there is nothing lower, take its lowest tier; if the model takes no tiers at all,
 * clear the tier.
 *
 * It also handles the earlier case where a suffixed name was stored directly: the suffix is stripped
 * off to make the base name, and the tier stripped off serves as the fallback when the stored tier
 * does not match, since that is what the user chose back then.
 */
export function pairModelEffort(
  provider: AiProvider,
  model: string,
  effort: EffortLevel,
  config: { api?: { model?: string }; cliModels?: Partial<Record<string, string>> } | null | undefined,
): { model: string; effort: EffortLevel } {
  if (provider !== "agy" || !model) return { model, effort };

  const suffix = AGY_EFFORT_SUFFIX.exec(model);
  const base = suffix ? suffix[1] : model;
  const fromName = (suffix ? suffix[2] : "") as EffortLevel;

  const group = agyGroups(parseModelList(config?.cliModels?.agy)).find((g) => g.base === base);
  const available = group ? group.efforts : [];
  if (available.length === 0) return { model: base, effort: "" };

  if (available.includes(effort)) return { model: base, effort };
  if (fromName && available.includes(fromName)) return { model: base, effort: fromName };
  // Step down one tier: better to be lighter than the user asked for than to run, behind their back,
  // at a higher cost and slower
  const wanted = AGY_EFFORT_ORDER.indexOf(effort);
  const lower = wanted < 0 ? [] : AGY_EFFORT_ORDER.slice(0, wanted).filter((e) => available.includes(e));
  return { model: base, effort: lower.length ? lower[lower.length - 1] : available[0] };
}
