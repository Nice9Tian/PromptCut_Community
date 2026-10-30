// 对应 claude-quickstarts/agents/utils/schema.py

/**
 * 清洗 schema 使其符合不同厂商的要求
 */
/**
 * @param opts.compat 「参数兼容模式」:按 Gemini 的 `Schema` 类型清洗。不传就按 vendor 推:gemini 家开,其余关。
 *   为什么要和 vendor 分开:走 OpenAI 兼容接口(Router、第三方网关)也可能接的是 Gemini 模型,
 *   厂商字段写的是 openai,schema 却得按 Gemini 的规矩来 —— 由调用方按模型名或用户开关决定。
 */

/**
 * Gemini 的 `Schema` 到底有哪些字段 —— 取自 v1beta 的 discovery 契约
 * (`$discovery/rest?version=v1beta` 里 Schema 那个 definition),不是猜的:
 *
 *   type format title description default example nullable enum
 *   minLength maxLength pattern minimum maximum minItems maxItems
 *   minProperties maxProperties required properties items anyOf propertyOrdering
 *
 * 所以「Gemini 只认最窄的子集」这句话本身是**过时的**。这里只删真的不在清单里的那几个,
 * 别的一律留着 —— 多删的代价不是"保险",是实打实的能力损失,见下面 KEEP 的说明。
 */
const GEMINI_UNKNOWN_KEYS = [
  '$schema',
  // 这是唯一一条真正的硬限制,而且正是「自由对象表达不出来」的根源(见下面那段)
  'additionalProperties',
  // 清单里只有单数 example;复数的改写成单数,不是丢掉
  'examples',
  // 清单里只有 minimum / maximum;开区间改写成闭区间近似,不是丢掉
  'exclusiveMinimum',
  'exclusiveMaximum',
];

/**
 * 曾经也被删、但其实 Gemini 认的:`title` `default` `minItems` `maxItems`。
 *
 * `title` 那条删出过真实的损害:`card-params-schema.mjs` 把「卡片参数」这个自由对象
 * 展开成一串 `anyOf` 分支、每个分支用 `title: card.id` 标明是哪张卡 —— 那是模型认出
 * 「该填哪张卡的参数」的**唯一线索**,在这里被删掉了。也就是说兼容模式一边宣称
 * 「Gemini 传不了参数」,一边在拆掉这个项目已经写好的解法。
 *
 * `format` 也留着,但要过滤取值:Gemini 只认 NUMBER 的 float/double、INTEGER 的 int32/int64、
 * STRING 的 enum/date-time。`uri` / `email` / `uuid` 这类传过去会 400,所以按白名单剔。
 */
const GEMINI_FORMATS = new Set(['float', 'double', 'int32', 'int64', 'enum', 'date-time']);

export function sanitizeSchema(schema, vendor, opts = {}) {
  const clone = JSON.parse(JSON.stringify(schema || {}));
  const compat = typeof opts.compat === 'boolean' ? opts.compat : vendor === 'gemini';

  function processNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    if (compat) {
      // 复数 examples 改写成单数 example,别白丢一个 few-shot 提示
      if (node.examples !== undefined && node.example === undefined && Array.isArray(node.examples) && node.examples.length) {
        node.example = node.examples[0];
      }
      // 开区间没有对应字段,退成闭区间:约束松一点,总好过整条约束消失
      if (node.exclusiveMinimum !== undefined && node.minimum === undefined) node.minimum = node.exclusiveMinimum;
      if (node.exclusiveMaximum !== undefined && node.maximum === undefined) node.maximum = node.exclusiveMaximum;
      for (const k of GEMINI_UNKNOWN_KEYS) delete node[k];
      // format 留着,但只留 Gemini 认的那几个取值
      if (node.format !== undefined && !GEMINI_FORMATS.has(node.format)) delete node.format;
    }

    /*
     * 嵌套的自由对象(没写 properties)要保持自由。
     * 以前这里补一个空的 properties,等于把「任意对象」改写成「没有任何字段的对象」——
     * 模型照着这个 schema 只能交出 {}。补 additionalProperties: true 把「随便填」说明白。
     *
     * **兼容模式下没有等价写法**:Gemini 的 Schema 里没有 additionalProperties,
     * 而它要求 object 必须有 properties,所以只能退回空对象。
     *
     * 这条退化在实际链路上基本走不到,因为真正的解法在别处:`card-params-schema.mjs`
     * 在发请求那一刻把「卡片参数」展开成一串 `anyOf` 分支(每张卡一个,分支里是真实字段),
     * 根本不需要表达「字段不固定的对象」。走到这一条只剩一种情况 —— 卡片列表拿不到、
     * 展开失败的兜底。所以说明留着,但别再拿它当「Gemini 传不了参数」的论据。
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
 * 将内部 Tool 形状转成三家 API 的工具声明
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
