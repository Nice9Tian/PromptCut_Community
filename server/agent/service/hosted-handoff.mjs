/**
 * `user_interface_web_handoff` for Cloud Agent (formerly `web_handoff`; package W2 in plan
 * `docs/plan/cloud-agent-tools-implementation.md`).
 *
 * Local `web_handoff` moves the browser window used by the Agent in front of the user, letting the
 * user handle login, verification codes, and QR code scans themselves. The browser on cloud nodes
 * (`hosted-browser.mjs` in package W1) has no window to move, and user login information is not
 * allowed on the node. Semantics (`docs/semantics/product/agent.md` "Tool scope") specify: it only
 * applies to the initiator's own page and local interface, and explicitly returns offline when the
 * initiator is not online. So what is done here:
 *
 *   1. Ask package W1's cloud browser "which web page this chat currently has open" (address only,
 *      `browser.handoffTarget(context)`);
 *   2. Via the reverse channel (`requestPage` in `page-bridge.mjs`), let the **initiating page** use
 *      its same local `web_handoff` implementation to hand the local browser over to the user, passing
 *      this address along; when there is no local browser in the initiating page's environment (pure
 *      web page), the page truthfully responds that it cannot do it;
 *   3. The cloud node only gets back "whether it was handed off", and cannot obtain local login
 *      information, cookies, or window contents.
 *
 * W1 is not merged yet: the `browser` dependency only defines an interface, using a mock
 * implementation in tests. Interface:
 *   `browser.handoffTarget(context) -> Promise<{ url: string } | null>` (address of the current page
 *   in the cloud browser for this chat; returns null if no page is open).
 * When `browser` is not provided, the factory can still be created as normal, and calls return
 * "cloud web operations not connected yet" (`cloudUnavailable`), without pretending it was handed off.
 *
 * The text in `HANDOFF_TEXT` below is tool output for the model, not UI text; user-facing UI text
 * (tab bubbles, notices) uses the existing local set (`src/ai/agentBrowserStore.ts`), and this
 * package adds no new UI text. This text is draft, pending user confirmation, so it is centralized
 * into replaceable constants.
 */
import { randomBytes } from 'node:crypto';
import { initiatorOffline } from './cloud-tools.mjs';
import { PageBridgeError, checkedPageArgs } from './page-bridge.mjs';
import { modelToolName } from '../../tools/ui-names.mjs';

/**
 * Model-side name (prefixed with `user_interface_` since 2026-10-21); internal operation name sent
 * to the page remains `web_handoff` (`PAGE_BRIDGE_TOOLS` in `page-bridge.mjs`)
 */
export const HANDOFF_TOOL_NAMES = Object.freeze(['user_interface_web_handoff']);

/**
 * Tool output for the model (draft, see report "Things for user decision"). The host can replace
 * them as a whole or item-by-item via `texts`
 */
export const HANDOFF_TEXT = Object.freeze({
  shown: (reason) => `The delegator has been asked to handle this on their own computer${reason ? `(${reason})` : ''}. Login information stays on their computer and is not available to the cloud.`
    + ' Stop now and tell the user, in their language, what to do and what to say when done. **Do not keep calling tools**; after the user replies, use web_view to check the current state.',
  hidden: 'The browser on the delegator\'s computer has been taken back.',
  noPage: 'The cloud browser has not opened a web page yet, so there is no page to hand to the user. Use web_open first to open the page to work on.',
  unmounted: 'Cloud web actions are not connected yet, so user_interface_web_handoff is unavailable. Continue based on the project content, and if needed tell the user to do this step themselves in PromptCut on their computer.',
  unsupported: 'The delegator is using the web version, so there is no local browser to hand over. Tell the user to handle this step in PromptCut on their computer, or use an approach that does not require login.',
  failed: 'user_interface_web_handoff did not succeed on the delegator\'s computer.',
});

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * @param {object} o
 * @param {{ requestPage: Function, initiator: Function, limits: object }} o.bridge Return value of `createPageBridge`
 * @param {{ handoffTarget(context: object): Promise<{ url: string } | null> } | null} [o.browser] Package W1 cloud browser (uses only this single entry point)
 * @param {Partial<typeof HANDOFF_TEXT>} [o.texts] Replacement text for the model
 */
export function createHandoffTools({ bridge, browser = null, texts = {}, now = Date.now, newRequestId = () => randomBytes(16).toString('base64url') } = {}) {
  if (typeof bridge?.requestPage !== 'function' || typeof bridge?.initiator !== 'function') throw new PageBridgeError('page-bridge-configuration', 503);
  if (browser !== null && typeof browser?.handoffTarget !== 'function') throw new PageBridgeError('handoff-browser-configuration', 503);
  const text = { ...HANDOFF_TEXT, ...texts };
  const handles = new Set(HANDOFF_TOOL_NAMES);

  async function call(nameIn, args, context, options = {}) {
    const name = modelToolName(nameIn);
    if (!handles.has(name)) throw new PageBridgeError('page-tool-unknown', 404);
    // The model can only provide reason and hide; the address is provided by the cloud browser,
    // and the model cannot specify where to take the user
    const a = args === undefined || args === null ? {} : args;
    if (!plain(a) || Object.keys(a).some((key) => key !== 'reason' && key !== 'hide')) return { ok: false, error: 'user_interface_web_handoff only accepts reason (text) and hide (whether to take back).' };
    let send;
    try { send = checkedPageArgs('web_handoff', a, bridge.limits); } catch (error) {
      if (error?.code !== 'bad-args') throw error;
      return { ok: false, error: 'The reason of user_interface_web_handoff must be a reasonably short sentence, and hide must be true or false.' };
    }
    if (!browser) return { ok: false, cloudUnavailable: true, code: 'handoff-browser-unmounted', error: text.unmounted };
    // First confirm this round is currently valid and retrieve the initiator and initiating page
    // (if authorization is gone, it will be thrown here)
    const who = await bridge.initiator(context);
    if (!send.hide) {
      const target = await browser.handoffTarget(context);
      if (!target) return { ok: false, error: text.noPage };
      try { send = checkedPageArgs('web_handoff', { ...send, url: target.url }, bridge.limits); } catch (error) {
        if (error?.code !== 'bad-args') throw error;
        // The cloud browser's current page is not a public web address (internal page, address with
        // passphrase): do not bring it to the user's computer
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
    // Do not pass the window state returned by the page's local implementation as-is to the model
    // (it may contain local details); only report whether it was handed off
    return send.hide ? { ok: true, visible: false, initiatorPage: true, message: text.hidden }
      : { ok: true, visible: true, initiatorPage: true, message: text.shown(send.reason ?? '') };
  }

  return Object.freeze({ handles, call, async close() { return { childrenClosed: true, streamsClosed: true, workPending: 0 }; } });
}
