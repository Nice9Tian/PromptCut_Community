import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';
import { cliCommand, cliEnv } from './cli-runtime.mjs';
import { pairingSession } from '../agent/call-pairing.mjs';

function runAgy(exe, args, options) {
  const invocation = cliCommand(exe, args);
  return execFileSync(invocation.command, invocation.args, { env: cliEnv('agy'), timeout: 15000, windowsHide: true, ...options });
}

/**
 * 登记 agy 的 PromptCut MCP:**不在登记里写端口**,端口在每次起 agy 时经环境变量带进去。
 *
 * agy 的 MCP 登记是全局的(一台机器一份)。原来登记时写死 `-e PROMPTCUT_PORT=<端口>`,
 * 而「是否已登记」只比对 node 和脚本路径、不比端口 —— 同一份代码的两个实例(5190 的编辑台、
 * 5198 的测试)端口不同,后启动的会以为已经登记好,agy 的工具调用就一直打到前一个端口上;
 * 那个端口关了就全报错,被别的程序占着就一直挂着。
 *
 * 现在:登记里只有命令和脚本;PROMPTCUT_PORT / PROMPTCUT_AGENT 放在 agy 进程的环境变量里
 * (见下面 spawnCli 的 env),agy 起 MCP 子进程时继承下去,mcp-server.mjs 读到的就是
 * 发起这次对话的那个服务端。每个服务端进程第一次用 agy 时重登一次(`mcp add` 是「加或更新」),
 * 顺手把老版本写进登记的端口清掉;之后只在命令或脚本路径变了时才重登。
 */
let registeredOnce = false;
let registerPromise = null;

export function mcpAddArgs(mcpOpts) {
  return ['mcp', 'add', 'promptcut', mcpOpts.command, mcpOpts.args[0]];
}

async function ensureMcpRegistered(exePath, mcpOpts, safeOnEvent) {
  if (registerPromise) await registerPromise.catch(() => {});
  registerPromise = (async () => {
    if (registeredOnce) {
      try {
        const listStdout = runAgy(exePath, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const line = listStdout.split(/\r?\n/).find((l) => l.split(/\s+/)[0] === 'promptcut');
        if (line && line.includes(mcpOpts.command) && line.includes(mcpOpts.args[0])) return;
      } catch { /* 查不到就重登 */ }
    }
    try {
      runAgy(exePath, mcpAddArgs(mcpOpts), { windowsHide: true, stdio: 'ignore' });
      registeredOnce = true;
      safeOnEvent({ type: 'status', text: '已把 PromptCut 注册为 agy 的 MCP 服务（agy mcp add promptcut）' });
    } catch (e) {
      safeOnEvent({ type: 'error', message: `MCP registration failed: ${e.message}` });
    }
  })();
  return registerPromise;
}

export async function getAgyProvider() {
  const exePath = resolveExe('agy');
  let available = false;
  let version = undefined;
  let note = undefined;
  try {
    const stdout = probeVersion(exePath);
    version = stdout.trim();
    available = true;
  } catch (e) {
    note = e.message;
  }
  return { id: 'agy', label: 'Antigravity', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;

  const interceptOnEvent = (ev) => {
    if ((ev.type === 'done' || ev.type === 'error') && rejected) {
        return;
    }
    opts.onEvent(ev);
  };

  const run = _startRun({
    ...opts,
    onEvent: interceptOnEvent,
    onPermissionDenied: () => {
      rejected = true;
    }
  });
  abortRef.abort = run.abort;

  const donePromise = run.done.then((res) => {
    if (rejected) {
      opts.onEvent({ type: 'status', text: '原生工具被拒，改用文本协议重试' });
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
      abortRef.abort = nextRun.abort;
      return nextRun.done;
    }
    return res;
  });

  return { abort: () => abortRef.abort(), done: donePromise };
}

/**
 * 只发给 agy 的一段补充说明,拼在通用系统提示词后面。
 *
 * 通用提示词是四家 runner 共用的,它不知道「跑它的这一家自己还带着一套内建工具」。
 * 而 agy 带着 —— view_file / grep_search / find_by_name / run_command 那一套。
 * 它的工作区只有 `exports/ai-workspace` 那个小沙箱(见 vite-plugin-ai.ts 里的 cwd),
 * 伸到沙箱外的一律自动拒绝;而**一次拒绝会让 agy 放弃整轮、不产出任何东西**。
 * 也就是说,它随手读一个文件的代价是整轮作废,再由我们发一条续跑消息重来。
 *
 * 实测里它把这四步全踩了:先 view_file 四个 MCP schema 的 json(那些 schema 早就在
 * 它自己的工具清单里)、再 grep_search 应用目录、再 view_file 用户附件的磁盘路径。
 * 光是「读一遍工具说明书」就白烧掉两轮。所以这里点名把替代路径写清楚。
 *
 * 审查环路里又见过一次:worker 先 list_dir 应用目录、再 read_url_content 一个网页、
 * 再 grep_search 应用源码找 `project.tracks` —— 三个内建工具各撞一次墙,三轮全作废。
 * 所以清单要列全,并且说清「换一个内建工具也一样」。
 */
const AGY_ADDENDUM = `
## 关于你自己那套内建工具(只有你这一家需要看)

你除了 PromptCut 的工具,自己还带着 view_file / list_dir / grep_search / find_by_name /
read_url_content / run_command 这些内建工具。**在这里基本都用不了,而且用了代价很大:**

- 你的工作区只有一个很小的临时目录,读写它以外的任何路径都会被自动拒绝
  (无人值守,没人能给你点同意);
- 读网页、跑命令同样没人能给你点同意,一律自动拒绝;
- 被拒一次,你这一轮就整个作废、什么都交不出来,要从头再来一遍。换一个内建工具也一样。

所以:**除非文件确实在你的工作区里,否则不要用内建工具碰任何路径、网址或命令。**
你要做的每一件事都有对应的 PromptCut 工具:

| 你想干的事 | 用这个,别用内建工具 |
| --- | --- |
| 看工程里有什么(轨道、片段、素材、卡片) | \`get_project\` / \`get_clip\` / \`get_track\` / \`list_media\` / \`list_cards\` |
| 弄清工程的数据长什么样 | 上面这些工具返回的就是;别去搜应用目录里的源码 |
| 读网页、查资料 | \`web_open\` / \`web_read\` |
| 看某张卡的源码 | \`get_card_source\` |
| 改一张卡 | \`edit_card\`(新建才用 \`create_card\`) |
| 看画面长什么样 | \`see_frames\` |
| 处理用户发来的附件 | \`import_media({ url })\`,url 取消息里的**站内地址**;别去 view_file 那个磁盘路径 |
| 等几秒再查后台作业 | \`wait({ seconds })\`,别用 run_command 去 sleep |
| 查某个工具怎么调 | 它的参数说明**已经在你的工具清单里**了,直接看;不要去读磁盘上的 schema json |
| 每个小阶段结束、整个任务收尾时向用户汇报 | \`report_progress\` |
| 告诉用户你接下来要做什么、刚做好了什么(显示在对话气泡里) | \`send_message\`,to 填 "user" |
`;

/**
 * 被拒的是哪一类权限,就指哪条 PromptCut 的路。
 *
 * 原来续跑话术写死「command 权限(run_command 等)被拒,改用 wait」。实跑里三次被拒分别是
 * list_dir(read_file)、read_url_content(read_url)、grep_search(read_file),一次 command 都没有 ——
 * 模型照着那句去躲 run_command,转手拿另一个内建工具再撞一次墙,重试用完,整个审查环路作废。
 */
export function deniedAdvice(names, detail) {
  const s = `${names} ${detail}`.toLowerCase().replace(/[_\s-]/g, '');
  const tips = [];
  if (/readfile|listdir|grepsearch|findbyname|viewfile|codebasesearch/.test(s)) {
    tips.push('看工程、素材、卡片:用 get_project / get_clip / list_media / list_cards / get_card_source,别去翻磁盘上的目录和源码');
  }
  if (/readurl/.test(s)) tips.push('读网页:用 web_open / web_read;用户发来的附件用 import_media({ url })');
  if (/runcommand|command/.test(s)) tips.push('等几秒再查后台作业:用 wait({ seconds },1~30),别用 run_command 去 sleep');
  if (!tips.length) tips.push('换成 PromptCut 提供的工具做同一件事');
  return tips;
}

function _startRun(opts) {
  const exePath = resolveExe('agy');
  
  let resolveDone;
  const donePromise = new Promise(r => { resolveDone = r; });
  let childController = null;
  let isAborted = false;
  
  const fullPrompt = `<<<系统说明>>>\n${opts.systemPrompt}\n${AGY_ADDENDUM}\n<<<用户消息>>>\n${opts.prompt}`;

  /*
   * 提示词走 **stdin**,不走命令行参数。
   *
   * 原来是 `-p <整个提示词>`。Windows 单条命令行上限 32767 字符,而系统提示词本身就
   * 15,000 出头 —— 平时够用,一旦叠上文本协议那份工具清单(33,000 字符)就是 49,000,
   * 直接 `spawn ENAMETOOLONG`。也就是说 agy 的「原生工具被拒 → 改用文本协议重试」
   * 这条兜底路**从来没有成功过**,一进去就炸,而且炸得看不出所以然。
   * claude.mjs 和 codex.mjs 早就是走 stdin 的,这里是唯一的例外。
   *
   * `--input-format stream-json` 让 agy 从 stdin 逐行读 NDJSON;它本身就意味着 print 模式,
   * 所以不再给 `-p`(给了反而会把后面那个标志当成提示词吃掉)。消息的形状是实测出来的:
   * `{"event":"user","message":{"role":"user","content":"…"}}` —— 少 `event` 或少 `message`
   * 都会被 agy 明确拒绝。实测 48,000 字符的提示词这样发过去正常返回。
   */
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--add-dir', opts.cwd,
    '--print-timeout', '20m'
  ];
  if (opts.sessionId) {
    args.push('--conversation', opts.sessionId);
  }
  /*
   * 模型名和思考档**必须配对**,这是 agy 的硬规矩,配不上直接拒整轮:
   *
   *   --model gemini-3.8-flash-low --effort low   ✓
   *   --model gemini-3.8-flash-low --effort high  ✗ invalid model selection
   *   --model gemini-3.8-flash     --effort low   ✓ 基名 + 档位,和第一条等价
   *
   * 面板那边已经拆成「基名 + 档位」再发过来了(modelOptions.pairModelEffort),
   * 这里把带后缀的写法再兜一道:后台任务、分工模式那几条路不一定经过面板,
   * 而且会话历史里存的可能是早先那种带后缀的名字。剥掉后缀、拿它当档位,
   * 结果和原来那个名字完全等价,但一定配得上。
   */
  let model = opts.model || '';
  let effort = opts.effort || '';
  const suffixed = /^(.+)-(low|medium|high)$/.exec(model);
  if (suffixed) {
    model = suffixed[1];
    effort = suffixed[2];
  }
  if (model) {
    args.push('--model', model);
  }
  // agy 支持 low|medium|high 三档,但**每个模型有哪几档不一样**(gemini-3.1-pro 就没有 medium);
  // 没有加速档,前端会把那个开关灰掉
  if (effort) {
    args.push('--effort', effort);
  }

  const safeOnEvent = (ev) => {
      if (childController) childController.safeOnEvent(ev);
      else {
          try { opts.onEvent(ev); } catch {}
      }
  };

  const runChild = () => {
    if (isAborted) {
       resolveDone();
       return;
    }
    
    // 端口和 Agent 页经环境变量交给 agy,它起 MCP 子进程时继承下去(登记里不写端口,见 ensureMcpRegistered)
    const mcpEnv = opts.mcp?.env || {};
    childController = spawnCli(exePath, args, { cwd: opts.cwd, env: { ...process.env, ...mcpEnv } }, opts.onEvent, 'Antigravity');
    let emitted = '';
    /*
     * callId:`agy:<对话 id>:<步号>`。agy 调 MCP 时在 tools/call 的 _meta 里带 conversation_id 和
     * progressToken "<uuid>:<步号>",步号就是这里 step_update 的 step_index(续跑同一对话时接着涨,不会重号),
     * mcp-server.mjs 按同样的写法拼出提示;这边经 opts.callPairing 报到,编辑器核对工具名和参数一致后配上
     * (server/agent/call-pairing.mjs)。页面 AI 栏按它把文档服务的工具调用事件对上聊天记录里的这一条。
     */
    const pairing = pairingSession(opts.callPairing);
    let convId = opts.sessionId || null;
    childController.donePromise.then(() => pairing.close(), () => pairing.close());

    // 提示词从这里进去(见上面 args 的说明)。EPIPE 忽略:进程要是已经自己退了,
    // 真正的原因在 stderr / result 事件里,不该被一个写管道失败盖过去。
    childController.child.stdin.on('error', () => {});
    try {
      childController.child.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: fullPrompt } }) + '\n');
      childController.child.stdin.end();
    } catch { /* 同上 */ }


    childController.child.stdout.on('data', lineSplitter(line => {
      if (!line.trim()) return;
      if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[agy] ' + line);
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'init' && ev.conversation_id) {
          convId = ev.conversation_id;
          pairing.open(`agy:${convId}`);
          childController.safeOnEvent({ type: 'session', sessionId: ev.conversation_id });
        } else if (ev.event === 'step_update' && ev.step_update) {
           const su = ev.step_update;
           if (su.step_type === 'tool') {
              let tName = su.tool_name;
              let tInput = su.tool_info?.parameters || {};
              // 这一步到底是不是在调 PromptCut 的工具。agy 自己也有一大堆内建工具
              // (run_command / browser_* / …),它们不走 MCP,被拒的处理方式完全不同
              const isMcp = su.tool_name === 'call_mcp_tool';
              const ours = isMcp && (tInput.ServerName === undefined || tInput.ServerName === 'promptcut');
              if (isMcp) {
                  tName = tInput.ToolName || 'call_mcp_tool';
                  tInput = tInput.Arguments || tInput;
              }
              const conv = su.conversation_id || convId;
              const callId = conv && Number.isInteger(su.step_index) ? `agy:${conv}:${su.step_index}` : undefined;
              const call = callId ? { callId } : {};
              if (callId && su.state !== 'ACTIVE') pairing.settle(callId);

              if (su.state === 'ACTIVE') {
                 if (callId && ours) {
                    pairing.open(`agy:${conv}`); // 没见到 init 时补开(已开的不重开)
                    pairing.announce(`agy:${conv}`, tName, tInput, callId);
                 }
                 childController.safeOnEvent({ type: 'tool_call', name: tName, input: tInput, ...call });
              } else if (su.state === 'DONE') {
                 let outputStr = 'done';
                 if (su.tool_info?.output !== undefined) {
                     if (typeof su.tool_info.output === 'string') outputStr = su.tool_info.output;
                     else outputStr = JSON.stringify(su.tool_info.output);
                 }
                 childController.safeOnEvent({ type: 'tool_result', name: tName, ok: true, summary: outputStr.substring(0, 300), ...call });
              } else if (su.state === 'ERROR') {
                 const msg = su.tool_info?.error?.message || '';
                 /*
                  * **「文件不存在」不是「被拒绝」,哪怕报错里出现了 permission 这个词。**
                  *
                  * agy 的权限判定要先把工具参数转一遍(`convert tool call for permissions`),
                  * 这一步顺手去读文件;读不到就把 ENOENT 原样往上抛,于是整条报错长这样:
                  *
                  *   declaring permissions: cortex tool view_file: convert tool call for
                  *   permissions: ... failed to read file: open <路径>:
                  *   The system cannot find the file specified.
                  *
                  * 里面有 permission,原来那个 includes 判定就一口咬定是权限问题,回给模型
                  * 一句「无人值守模式下没法弹窗征求同意」—— 而真相是它写了个根本不存在的路径。
                  * 模型照着这句话去猜权限,怎么试都不对;用户看到的也是一个假的权限故障。
                  * 所以先认「找不到」,认出来就当成一次普通的工具失败,把原文交回去让它换个路径。
                  */
                 const notFound = /cannot find the file|no such file|not found|ENOENT|系统找不到/i.test(msg);
                 const denied = !notFound
                   && (msg.includes('permission') || msg.includes('权限') || msg.includes('denied') || msg.includes('not allowed'));
                 /*
                  * 「被拒」要分是谁被拒的,原来一律当成 MCP 被拒,两处都错:
                  *
                  * - 话说错了。agy 内建的 run_command 在无人值守模式下没法弹窗问,会被自动
                  *   拒掉,而我们回一句「请点『授权 PromptCut 工具』」—— 那个按钮跟它一点关系
                  *   没有,用户点了也没用。同一轮里 get_project / list_media 明明都成功了,
                  *   MCP 根本是通的。
                  * - 事也做错了。onPermissionDenied 会让整轮跑完之后改用文本协议重试,可文本协议
                  *   换的只是「PromptCut 的工具怎么下达」,管不着 agy 自己那套 command 权限;
                  *   重试一遍照样被拒。白跑一轮,还把用户等在那儿。
                  *
                  * 所以只有真的是 MCP 那条路被拒时才回退。agy 自家工具被拒就照实说,
                  * 并且当成一次失败的工具调用交回给模型 —— 让它换个办法接着做,而不是整轮作废。
                  */
                 if (denied && isMcp) {
                    if (opts.onPermissionDenied) opts.onPermissionDenied();
                    childController.safeOnEvent({ type: 'status', text: `agy 拒绝了 MCP 工具调用。请打开 AI 设置（右栏齿轮），点『授权 PromptCut 工具』，然后重试。` });
                 } else if (denied) {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: `Antigravity 自己拒绝了这个工具(它的内建工具,不是 PromptCut 的):${msg}`, ...call });
                    childController.safeOnEvent({ type: 'status', text: `Antigravity 拦下了它自己的 ${tName}——无人值守模式下没法弹窗征求同意。PromptCut 的工具不受影响,让它改用 PromptCut 的工具做同一件事即可。` });
                 } else {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: msg, ...call });
                 }
              }
           } else {
               const txt = su.text_delta ?? su.text ?? su.delta ?? su.content ?? su.message;
               if (typeof txt === 'string' && txt.length > 0) {
                  childController.safeOnEvent({ type: 'text', delta: txt });
                  emitted += txt;
               }
           }
        } else if (ev.event === 'result' && ev.result) {
           const res = ev.result;

           /*
            * agy 出错时照样发一条 result,只是 status 是 ERROR、error 里写着原因,
            * 然后以非 0 退出。这里原来不看 status,把它当成正常收尾发了个 done ——
            * 而 done 一发,spawnCli 里 hasDone 就为真,`close` 那条「exited with code 1」
            * 也被一并压掉。于是界面上只剩一句「已启动 Antigravity」,几秒后无声无息地结束:
            * 没有回复、没有报错、usage 全是 0,看起来就像连不上。
            *
            * 实际最常撞上的是模型名不对(比如 `gemini-3.8.flash` —— agy 的名字是
            * `gemini-3.8-flash-low` 这种),agy 说得清清楚楚,只是没人把这句话传出来。
            * claude.mjs 那边一直是查 is_error 的,这里补齐。
            */
           if (res.status === 'ERROR' || res.error) {
              const why = typeof res.error === 'string' ? res.error : (res.error?.message || 'Antigravity 报错但没说原因');
              childController.finish({ type: 'error', message: `Antigravity: ${why}` });
              return;
           }

           const finalResponse = res.response || '';

           if (res.denied_actions && res.denied_actions.length > 0) {
               const deniedNames = res.denied_actions.map(a => a.display_name || a.action).join(', ');
               // 被拒的原始说明。agy 把它放在 denied_actions 里(字段名各版本不一),
               // 拼进续跑消息里给模型看 —— 比我们转述一遍准确
               const deniedDetail = res.denied_actions
                 .map(a => a.reason || a.message || a.detail || '')
                 .filter(Boolean).join('; ');
               /*
                * 被拒**而且什么都没产出** = 这一轮废了,不能报成功。
                *
                * agy 在无人值守模式下把自己的 run_command 自动拒掉之后就放弃整轮,
                * result 里 denied_actions 有值、response 是空的,但 status 不是 ERROR。
                * 原来这里只发一条 status 就照常 finish('done') —— 界面上是一串工具调用
                * 之后毫无征兆地结束:没有回复、没有报错,用户完全不知道发生了什么。
                * (用户原话:「这里拒绝好像是我们拒绝的,没有给 Agent 反馈而是直接中断了」。)
                *
                * 拒绝这件事我们无法在 agy 的循环里回喂 —— 它是一次性的 CLI 调用,
                * 自己管自己的工具。能做的是:把它如实报成错误,并且说清楚下一步。
                * 真正的治本在另一头:补了 wait 工具,模型就不必再借 shell 去睡觉了
                * (见 server/mcp-tools.mjs 里 wait 的说明)。
                */
               if (!String(finalResponse).trim() && !emitted.trim()) {
                  const why = deniedDetail || `内建工具 ${deniedNames} 被拒绝`;
                  const tips = deniedAdvice(deniedNames, deniedDetail);
                  childController.finish({
                    type: 'error',
                    message: `Antigravity 拒绝了它自己的内建工具(${deniedNames})之后放弃了这一轮,没有产出任何结果。`
                      + `无人值守模式下它没法弹窗征求同意,工作区以外的读文件、读网页、跑命令一律自动拒绝。`
                      + `PromptCut 的工具不受影响 —— ${tips.join(';')}。`,
                    /*
                     * 这一类中断是「接着说就有可能成」的:上下文都还在(--conversation 会把
                     * 整段对话带回来),缺的只是让它知道刚才为什么停、以及换哪条路。
                     * 所以标成可续跑,并且**把中断原因和替代方案直接拼进续跑的那句话** ——
                     * 不让它自己开口问「刚才怎么了」,省一轮往返,也省得它猜错。
                     */
                    retryable: true,
                    retryPrompt: `接着上面继续做。上一轮中断了,原因是:${why}。\n`
                      + `这是 Antigravity 自己的权限限制:无人值守模式下,你的内建工具(view_file / list_dir / grep_search / find_by_name / read_url_content / run_command 等)`
                      + `只要碰工作区以外的路径、网址或命令,一律被自动拒绝,整轮作废。换一个内建工具也一样,不要再试。\n`
                      + `改用 PromptCut 的工具:\n${tips.map((t) => `- ${t}`).join('\n')}\n`
                      + `不用重头再来,从刚才停下的地方接着做就行。`,
                  });
                  return;
               }
               childController.safeOnEvent({ type: 'status', text: `部分动作被拒绝: ${deniedNames}` });
           }

           if (typeof finalResponse === 'string' && finalResponse.trim().length > 0) {
              const cleanedEmitted = emitted.trim();
              const cleanedResponse = finalResponse.trim();
              if (!cleanedEmitted.endsWith(cleanedResponse) && !cleanedEmitted.includes(cleanedResponse)) {
                  childController.safeOnEvent({ type: 'text', delta: finalResponse });
              }
           }
           childController.finish({ type: 'done', sessionId: res.conversation_id, usage: res.usage });
        }
      } catch {}
    }));

    childController.donePromise.then(resolveDone);
  };

  if (opts.mcp) {
    ensureMcpRegistered(exePath, opts.mcp, safeOnEvent).then(runChild);
  } else {
    runChild();
  }
  
  const abort = () => {
    isAborted = true;
    if (childController) childController.abort();
    else resolveDone();
  };
  
  return { abort, done: donePromise };
}
