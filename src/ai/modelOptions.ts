import type { AiProvider } from "./types";

/**
 * 每家驱动到底支持哪几样,以及当前这次运行选了什么。
 *
 * 能力表不是拍脑袋写的,是在本机逐个问过 CLI 的 --help 得来的:
 *   claude  --model / --effort low|medium|high|xhigh|max / fastMode(经 --settings 传)
 *   codex   -m --model / 推理档只能走 -c model_reasoning_effort= / 没有加速档
 *   agy     --model / --effort low|medium|high / 没有加速档
 * 不支持的就在界面上灰掉,不做假开关 —— 点了没反应比没有这个开关更糟。
 */

/**
 * 推理强度。空字符串 = 跟随各家自己的默认,不传标志。
 *
 * `minimal` 现在**没有任何驱动提供**(它曾在 codex 的清单里,而上游不认,选中就是 400)。
 * 类型里留着它只为一件事:用户浏览器里可能还存着这个旧值,留着类型才对得上;
 * 界面那边会把不在清单里的值降级成默认(见 ModelBar),所以它发不出去。
 * 别因为「类型里有」就把它加回某家的 efforts。
 */
export type EffortLevel = "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCapability {
  /** 支持哪几档推理强度;空数组 = 这家不支持,界面上灰掉 */
  efforts: EffortLevel[];
  /** 支不支持「加速」。只有 Claude Code 有(settings 里的 fastMode) */
  fast: boolean;
  /** 没配模型清单时的兜底建议,用户可以在 AI 设置里改 */
  suggestedModels: string;
  /** 这家的模型清单从哪来 */
  modelsHint: string;
}

export const CAPABILITIES: Record<AiProvider, ProviderCapability> = {
  claude: {
    efforts: ["", "low", "medium", "high", "xhigh", "max"],
    fast: true,
    suggestedModels: "opus|sonnet|haiku",
    modelsHint: "填别名就行（opus / sonnet / haiku），也可以填完整模型名",
  },
  codex: {
    /*
     * codex 没有 --effort,只能用 -c model_reasoning_effort= 覆盖配置项。
     *
     * 这份清单必须和上游认的值一致 —— 用户诊断报告里就撞过一次:他从这个下拉框里选了
     * `minimal`,请求直接 400:
     *   Unsupported value: 'minimal' is not supported with the 'gpt-5.6-terra' model.
     *   Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.
     * 两头都错了:`minimal` 我们给了、上游不认;`none` 和 `max` 上游认、我们没给。
     * 摆一个必然 400 的选项在菜单里,用户不可能猜到是我们的错。
     */
    efforts: ["", "none", "low", "medium", "high", "xhigh", "max"],
    fast: false,
    suggestedModels: "gpt-5.6-terra|gpt-5.6-sol",
    modelsHint: "填 codex 支持的模型名，多个用 | 分开",
  },
  agy: {
    efforts: ["", "low", "medium", "high"],
    fast: false,
    suggestedModels: "",
    modelsHint: "可以点「从 CLI 读取」直接拉 agy models 的清单",
  },
  api: {
    /*
     * low / medium / high 是 OpenAI 兼容口径 `reasoning_effort` 的取值,中转站也照收
     * (openlux 文档：「Inference model strength (such as low / medium / high)」)。
     * 不给 minimal / xhigh / max：那几档是 CLI 各自的扩展，OpenAI 兼容接口不认，
     * 列出来只会让用户选一个上游会 400 的值。
     *
     * 选「默认」(空)时一个字段都不发 —— 有些模型名自带 `-thinking` 后缀，网关会自己
     * 注入档位，这时候硬塞一个反而把它覆盖掉。
     */
    efforts: ["", "low", "medium", "high"],
    fast: false,
    suggestedModels: "",
    modelsHint: "多个模型用 | 分开，面板上就能切",
  },
};

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  "": "默认",
  // codex 的 none 是「明确关掉思考」,和 ""(不传这个参数、随它自己的默认)不是一回事
  none: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

/** `a|b|c` → ["a","b","c"]。空段和首尾空格都去掉,允许用户随手写成 `a | b` */
export function parseModelList(raw: string | undefined | null): string[] {
  return String(raw ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── 这一次运行选了什么 ──────────────────────────────────
 * 存 localStorage 而不是 ai.json:这是「这台机器上我现在想用哪个」,
 * 换个模型不该算改配置,也不该跟着项目文件走。按 provider 分开记,
 * 从 Claude 切到 Codex 不会把模型名带过去(那个名字在对面根本不存在)。
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
    /* 无痕模式记不住就算了,本次会话内仍然生效 */
  }
}

export interface RunChoice {
  /** 空 = 用该驱动自己的默认模型 */
  model: string;
  effort: EffortLevel;
  fast: boolean;
  /**
   * 参数兼容模式:工具 schema 按 Gemini 那套最窄子集清洗。auto = 按模型名推(有 gemini 就开);
   * on / off 是用户手动定的。Claude / GPT 系列锁死 off、Gemini 锁死 on,别的厂商才让用户调(见 compatPolicy)。
   */
  schemaCompat: SchemaCompat;
  /**
   * 深度自主:把一次运行的轮次上限从常规的几十轮放宽到 300,并且**不再往模型手里
   * 塞任何关于轮次的话**。默认关着 —— 常规上限的作用是把跑偏的运行拦下来,
   * 开着它等于把这道闸交给用户自己判断,只在明确要它长时间自己跑时才开。
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
 * 参数兼容开关在这个驱动 / 模型下该是什么样。
 *   - Claude Code / Codex 这两条 CLI 路,以及 API 直连里模型名带 claude / gpt / o1~o9 / codex 的:锁死关(它们吃完整 schema);
 *   - API 直连里模型名带 gemini 的:锁死开;
 *   - agy 这条 CLI 路:**这个开关根本不经手**(见 applies);
 *   - 其余(API 直连接的别家模型、模型名看不出来的):用户自己调,默认按厂商字段推。
 * 模型名不带厂商信息时按 vendor 兜底 —— Router 可能把 Gemini 挂在 openai 兼容接口后面,所以看模型名优先。
 *
 * `applies = false` 表示**这条路上这个开关不起任何作用**,界面上不该显示它。
 * agy 就是这种:它的工具是 `agy mcp add promptcut` 注册的 MCP 服务暴露的,走 mcp-server.mjs,
 * 根本不经过 sanitizeSchema —— `schemaCompat` 全仓库只有 runners/api.mjs 会读。
 * 以前这里给 agy 返回「锁死开启」,面板上于是亮着一个按下去什么也不会发生的按钮。
 */
export function compatPolicy(provider: AiProvider, model: string, vendor: string | undefined, pref: SchemaCompat): { on: boolean; locked: boolean; reason: string; applies: boolean } {
  const m = (model || "").toLowerCase();
  if (provider === "claude" || provider === "codex") return { on: false, locked: true, applies: true, reason: "Claude Code / Codex 吃完整的工具 schema,不用兼容模式" };
  if (provider === "agy") return { on: true, locked: true, applies: false, reason: "Antigravity 的工具走 MCP 注册,不经过这里的 schema 清洗,这个开关对它不起作用" };
  if (/claude/.test(m) || /(^|[^a-z])(gpt|o[1-9]|codex)/.test(m)) return { on: false, locked: true, applies: true, reason: "Claude / GPT 系列吃完整的工具 schema,不用兼容模式" };
  /*
   * Gemini 仍然锁开,但**理由变了**,别再说成「只认最窄的子集」。
   * 按 v1beta 的 discovery 契约,它的 Schema 认 title / default / minItems / maxItems / format 等等;
   * 真正不认的只有 additionalProperties / $schema / exclusiveMinimum / exclusiveMaximum(见 harness/schema.mjs)。
   * 所以关掉这个开关会把 additionalProperties 原样发过去 —— 那是真的会 400,因此仍然锁死。
   */
  if (/gemini/.test(m)) return { on: true, locked: true, applies: true, reason: "Gemini 不认 additionalProperties 这几个字段,发过去会 400,所以这一档锁死开着" };
  const auto = vendor === "gemini";
  const on = pref === "on" ? true : pref === "off" ? false : auto;
  return { on, locked: false, applies: true, reason: `模型名看不出厂商:${auto ? "按厂商字段默认开" : "默认关"};工具调用报 schema 相关的 400 就打开` };
}

/** 发请求时带的值:锁死的直接给定论,可调的把用户偏好交给服务端(auto 由服务端按模型名再推一次) */
export function compatToSend(provider: AiProvider, model: string, vendor: string | undefined, pref: SchemaCompat): SchemaCompat {
  const pol = compatPolicy(provider, model, vendor, pref);
  if (pol.locked) return pol.on ? "on" : "off";
  return pref;
}

/**
 * 选中的模型不在清单里就退回「默认」。
 * 用户在设置里把某个模型删掉之后,面板不该继续拿一个已经没有的名字去跑。
 */
export function normalizeModel(model: string, available: string[]): string {
  return model && available.includes(model) ? model : "";
}

/**
 * 这一家现在有哪些模型可选。面板的下拉框和**真正发请求那一刻**都得用这一份,
 * 不能各算各的。
 *
 * 以前只有 ModelBar 算了一次,拿去填下拉框;发请求走的是 readChoice 的原值。
 * 结果是:清单里已经没有的名字(改过设置、或者当初手打错了一个字)在下拉框里
 * 早就退回「默认」了,请求里却还带着它 —— 界面显示「默认」,CLI 收到的是个
 * 不存在的模型名,当场退出。用户看着一切正常,只是永远得不到回复。
 */
export function modelsFor(
  provider: AiProvider,
  config: { api?: { model?: string }; cliModels?: Partial<Record<string, string>> } | null | undefined,
): string[] {
  const raw = provider === "api"
    ? parseModelList(config?.api?.model)
    : parseModelList(config?.cliModels?.[provider]);
  // agy 把思考档编在模型名里,面板上只列基名(见 agyGroups)
  return provider === "agy" ? agyGroups(raw).map((g) => g.base) : raw;
}

/* ── agy:模型名里编着思考档 ─────────────────────────────────
 *
 * `agy models` 给出来的是 gemini-3.8-flash-low / -medium / -high 这种,思考档是**名字的一部分**。
 * 而 agy 同时又收 --effort,两者**必须配对**,配不上它直接拒:
 *
 *   --model gemini-3.8-flash-low  --effort low    ✓
 *   --model gemini-3.8-flash-low  --effort high   ✗ invalid model selection
 *   --model gemini-3.8-flash      --effort low    ✓ 基名 + 档位,和上面第一条等价
 *   --model gemini-3.8-flash                      ✗ requires --effort (available: low, medium, high)
 *   --model gemini-3.1-pro        --effort medium ✗ has no "medium" effort (available: low, high)
 *   --model claude-sonnet-4-6     --effort low    ✗ --effort is not supported for this model
 *
 * 所以档位不能是一张固定的表:**每个模型自己有哪几档,得从清单里数出来**
 * (gemini-3.1-pro 只有 low / high,没有 medium;claude-sonnet-4-6 一档都没有)。
 * 面板上把带后缀的名字折成一个基名,选哪一档交给「思考」那个下拉框,
 * 发请求时再拼回成 agy 认的那一对。
 */

/** 一个 agy 模型,以及它到底支持哪几档思考(空数组 = 这个模型不吃 --effort) */
export interface AgyModelGroup {
  base: string;
  efforts: EffortLevel[];
}

/** 名字末尾的思考档。只认这三个 —— claude-opus-4-6-**thinking** 那种后缀不是档位 */
const AGY_EFFORT_SUFFIX = /^(.+)-(low|medium|high)$/;

/** 从低到高。用来在存着的档位对不上这个模型时往下取一档 */
const AGY_EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high"];

/**
 * 把 `agy models` 那串名字折成「基名 + 它支持的档位」。
 * 顺序按清单里第一次出现的先后,档位按 low → medium → high 排(界面上从轻到重才顺)。
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
 * 这家的能力表;不认识的驱动名(比如拉起的子 Agent 页签沿用了一个本机没有的驱动,A3)给一张「什么都不支持」的表,
 * 界面照常画、控件灰掉,不因为查不到而整页报错。
 */
const UNKNOWN_CAPABILITY: ProviderCapability = { efforts: [], fast: false, suggestedModels: "", modelsHint: "" };
export function capabilityOf(provider: string): ProviderCapability {
  return (CAPABILITIES as Record<string, ProviderCapability | undefined>)[provider] ?? UNKNOWN_CAPABILITY;
}

/**
 * 选中这个模型之后,「思考」下拉框该给哪几档。
 *
 * agy 之外还是各家那张固定表。agy 这边:
 *   - 没选模型(默认):给固定表,agy 自己那个默认模型配什么档都收;
 *   - 选了带档位的模型:**只给它有的那几档,而且没有「默认」** —— 基名不带 --effort 是会被拒的;
 *   - 选了不吃档位的模型(claude-sonnet-4-6):空数组,界面上灰掉写「不支持」。
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
 * 把一个可能过期的档位收进当前清单里,收不进就退回「默认」。
 *
 * 档位存在 localStorage,而清单是会变的 —— 0ae554b 把 codex 的 `minimal` 去掉了
 * (上游根本不认,选中必 400)。老用户浏览器里那个值还在,面板只把它降级成「默认」**显示**,
 * 发请求那条路读的是 localStorage 原值,于是界面写着「默认」、请求里照旧带着 minimal,
 * 还是那条 400。
 *
 * 抽成纯函数是为了**能测发送路径本身** —— 只测 CAPABILITIES 清单是同义反复,
 * 清单对了而发送路径没接上,线上照样 400(这次评审抓到的正是这个形状)。
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
 * 真正发出去的那一对 (model, effort)。
 *
 * agy 之外原样返回。agy 这边负责把面板上的「基名 + 档位」拼成它认的组合,并且**保证配得上**:
 * 存着的档位这个模型没有(换了模型、或者是早先版本留下的),就往下取一档,
 * 一档都没有就取它最低的那档;模型压根不吃档位就把档位清掉。
 *
 * 还兼容早先直接存了带后缀名字的情况:先把后缀剥掉当基名,剥下来的那档在
 * 存着的档位对不上时充当兜底 —— 用户当初选的就是它。
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
  // 往下取一档:宁可比用户要的轻,也不要背着他更贵更慢地跑
  const wanted = AGY_EFFORT_ORDER.indexOf(effort);
  const lower = wanted < 0 ? [] : AGY_EFFORT_ORDER.slice(0, wanted).filter((e) => available.includes(e));
  return { model: base, effort: lower.length ? lower[lower.length - 1] : available[0] };
}
