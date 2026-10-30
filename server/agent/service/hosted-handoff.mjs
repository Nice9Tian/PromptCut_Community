/**
 * 云端 Agent 的 `user_interface_web_handoff`(原名 `web_handoff`;计划 `docs/plan/cloud-agent-tools-implementation.md` 的 W2 包)。
 *
 * 本机的 `web_handoff` 是把 Agent 用的浏览器窗口挪到用户面前,让用户自己处理登录、验证码、扫码。云节点上的浏览器
 * (W1 包的 `hosted-browser.mjs`)没有窗口可挪,用户的登录信息也不许上节点。语义(`docs/semantics/product/agent.md`
 * 「工具范围」)定的是:它只作用于发起人自己的页面与本机界面,发起人不在线时明确回不在线。所以这里做的是:
 *
 *   1. 问 W1 的云端浏览器「这个对话此刻开着哪个网页」(只要地址,`browser.handoffTarget(context)`);
 *   2. 经反向通道(`page-bridge.mjs` 的 `requestPage`)让**发起页**用它本机同一份 `web_handoff` 实现把本机的浏览器交给本人,
 *      并把这个地址带过去;发起页的环境里没有本机浏览器(纯网页)时页面如实回做不了;
 *   3. 云节点只拿回「交没交出去」,拿不到本机的登录信息、cookie、窗口内容。
 *
 * W1 还没合入:`browser` 这个依赖只定了接口,测试里用假实现。接口:
 *   `browser.handoffTarget(context) -> Promise<{ url: string } | null>`(这个对话的云端浏览器当前页的地址;没有开着的页回 null)。
 * 没给 `browser` 时工厂照常建得出来,调用回「云端的网页操作还没接上」(`cloudUnavailable`),不假装交出去了。
 *
 * 下面 `HANDOFF_TEXT` 里的话是给模型看的工具结果,不是界面文字;界面上给用户看的(页签气泡、提示)用的是本机现成的那一套
 * (`src/ai/agentBrowserStore.ts`),本包没有新增界面文字。这些话是草稿,待用户确认,所以集中成可替换的常量。
 */
import { randomBytes } from 'node:crypto';
import { initiatorOffline } from './cloud-tools.mjs';
import { PageBridgeError, checkedPageArgs } from './page-bridge.mjs';
import { modelToolName } from '../../tools/ui-names.mjs';

/** 模型侧的名字(2026-10-21 起带 `user_interface_` 前缀);发给页面的内部操作名仍是 `web_handoff`(`page-bridge.mjs` 的 `PAGE_BRIDGE_TOOLS`) */
export const HANDOFF_TOOL_NAMES = Object.freeze(['user_interface_web_handoff']);

/** 给模型看的工具结果(草稿,见报告「要用户定的事」)。宿主可以用 `texts` 整体或逐条替换 */
export const HANDOFF_TEXT = Object.freeze({
  shown: (reason) => `已经请发起人在他自己的电脑上处理${reason ? `(${reason})` : ''}。登录信息只留在他的电脑上,云端拿不到。`
    + '现在停下来,用中文告诉用户要做什么、做完了怎么说。**不要继续调工具**,等用户回话之后再 web_view 看当前状态。',
  hidden: '发起人电脑上的浏览器已经收回。',
  noPage: '云端的浏览器还没有打开网页,没有可以交给用户的页面。先用 web_open 打开要处理的网页。',
  unmounted: '云端的网页操作还没接上,user_interface_web_handoff 现在用不了。请按项目内容继续,需要的话告诉用户自己在电脑上的 PromptCut 里做这一步。',
  unsupported: '发起人现在用的是网页版,没有可以交给他的本机浏览器。请告诉用户到电脑上的 PromptCut 里处理这一步,或者换一个不需要登录的做法。',
  failed: 'user_interface_web_handoff 在发起人的电脑上没有做成。',
});

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * @param {object} o
 * @param {{ requestPage: Function, initiator: Function, limits: object }} o.bridge `createPageBridge` 的返回
 * @param {{ handoffTarget(context: object): Promise<{ url: string } | null> } | null} [o.browser] W1 的云端浏览器(只用这一个口子)
 * @param {Partial<typeof HANDOFF_TEXT>} [o.texts] 替换给模型看的话
 */
export function createHandoffTools({ bridge, browser = null, texts = {}, now = Date.now, newRequestId = () => randomBytes(16).toString('base64url') } = {}) {
  if (typeof bridge?.requestPage !== 'function' || typeof bridge?.initiator !== 'function') throw new PageBridgeError('page-bridge-configuration', 503);
  if (browser !== null && typeof browser?.handoffTarget !== 'function') throw new PageBridgeError('handoff-browser-configuration', 503);
  const text = { ...HANDOFF_TEXT, ...texts };
  const handles = new Set(HANDOFF_TOOL_NAMES);

  async function call(nameIn, args, context, options = {}) {
    const name = modelToolName(nameIn);
    if (!handles.has(name)) throw new PageBridgeError('page-tool-unknown', 404);
    // 模型能给的只有 reason 与 hide;地址由云端浏览器给,模型不能指定把用户带到哪
    const a = args === undefined || args === null ? {} : args;
    if (!plain(a) || Object.keys(a).some((key) => key !== 'reason' && key !== 'hide')) return { ok: false, error: 'user_interface_web_handoff 只接受 reason(文字)与 hide(是否收回)。' };
    let send;
    try { send = checkedPageArgs('web_handoff', a, bridge.limits); } catch (error) {
      if (error?.code !== 'bad-args') throw error;
      return { ok: false, error: 'user_interface_web_handoff 的 reason 要是一句不太长的话,hide 要是 true 或 false。' };
    }
    if (!browser) return { ok: false, cloudUnavailable: true, code: 'handoff-browser-unmounted', error: text.unmounted };
    // 先确认这一轮此刻有效、取到发起人与发起页(授权已经不在会在这里抛出去)
    const who = await bridge.initiator(context);
    if (!send.hide) {
      const target = await browser.handoffTarget(context);
      if (!target) return { ok: false, error: text.noPage };
      try { send = checkedPageArgs('web_handoff', { ...send, url: target.url }, bridge.limits); } catch (error) {
        if (error?.code !== 'bad-args') throw error;
        // 云端浏览器当前页不是公开的网页地址(内部页、带口令的地址):不往用户的电脑上带
        return { ok: false, error: text.noPage };
      }
    }
    const out = await bridge.requestPage({ run: context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool: 'web_handoff', args: send,
      requestId: options.requestId ?? newRequestId(), deadline: Number(now()) + bridge.limits.pageMs, ...(options.signal ? { signal: options.signal } : {}) });
    if (!out.delivered) return initiatorOffline('user_interface_web_handoff');
    const answer = out.answer;
    if (answer.ok !== true) {
      if (answer.code === 'unsupported') return { ok: false, initiatorOnly: true, error: text.unsupported };
      return { ok: false, error: String(answer.error || text.failed) };
    }
    // 页面本机实现回的窗口状态原样不往模型那里带(里面可能有本机的细节),只说交没交出去
    return send.hide ? { ok: true, visible: false, initiatorPage: true, message: text.hidden }
      : { ok: true, visible: true, initiatorPage: true, message: text.shown(send.reason ?? '') };
  }

  return Object.freeze({ handles, call, async close() { return { childrenClosed: true, streamsClosed: true, workPending: 0 }; } });
}
