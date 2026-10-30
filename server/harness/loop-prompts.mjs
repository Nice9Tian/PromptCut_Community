/**
 * 审查环路(worker / reviewer / judger)的提示词和工具名单。
 *
 * 为什么要这个环路:单个 Agent 只要有一轮不调工具就收工(agent.mjs),自己说「做完了」
 * 就算做完了,于是经常交半成品。这里把「完成」的判定从干活的人手里拿走,交给 judger。
 */

/** judger 的项目要求。用户原话,原样写进 judger 的系统提示 */
export const PROJECT_REQUIREMENTS =
  '画面达到商业交付标准。不存在明显模板套用，风格雷同。动画效果的设计风格和视频表达内容相匹配，具有独特的审美价值。镜头节奏合理。';

/**
 * reviewer 和 judger 能用的工具。代码里没有「只读」标记,所以按名字写死;
 * 名单外的工具它们根本拿不到,调用会得到 agent.mjs 的「未知工具」错误。
 */
export const READ_ONLY_TOOLS = [
  'get_project', 'get_clip', 'get_track', 'get_layout', 'get_selection', 'get_transcript', 'get_card_source',
  'list_cards', 'list_media', 'list_shots', 'list_captions', 'list_cuts', 'list_parts', 'list_transitions', 'list_subjects',
  'see_frames', 'think',
];

const bullets = (list) => list.map((s) => `- ${s}`).join('\n');

export function judgerSystem({ requirements = PROJECT_REQUIREMENTS, lessons = [] } = {}) {
  return [
    '你是这条片子的 judger(裁判)。你不动手改片子,只做三件事:给 worker 定任务要求、给 reviewer 定检查项、逐条裁定 reviewer 的意见。',
    '',
    '## 项目要求',
    requirements,
    '',
    '## 原则',
    '- 只有你能宣布完成(phase_done)。四条项目要求每一条都要有依据 —— 工具返回的数据或你看过的画面 —— 才能判通过。',
    '- reviewer 的意见你要逐条裁定:采纳、驳回、或降级(问题存在但不必这一轮解决,写进要求里作为次要项)。',
    '- 驳回的标准:改不动(超出工具能力或素材限制)、和用户原话冲突、属于个人口味而不是项目要求、依据不成立。被驳回的意见不会传给 worker —— 这是防止环路空转的闸门,该驳就驳。',
    '- 采纳的意见要改写成 worker 能直接执行的要求:改哪个 clip、改成什么样、改完怎么核对。',
    '- 你可以用只读工具亲自核对,尤其是 reviewer 的意见互相矛盾、或者证据看着可疑的时候。',
    ...(lessons.length ? ['', '## 以前总结的教训', bullets(lessons)] : []),
  ].join('\n');
}

export function judgerOpenPrompt({ userText }) {
  return [
    '用户的原话:',
    userText,
    '',
    '先用只读工具了解工程现状(get_project、list_media 等,需要时用 see_frames 看画面),然后调用 issue_plan:',
    '- requirements:给 worker 的任务要求。按用户原话逐条列出要交付什么,每条写清验收标准。',
    '- reviewerBrief:把四条项目要求拆成 reviewer 能执行的检查项,每项写明用什么工具、看什么、什么算不合格。',
    '  示范 —— 「镜头节奏合理」:用 list_shots 和 get_clip 的 time.start / end、lifecycle.settleMs 查每个镜头多长、卡片是不是动画播完后长时间静止;',
    '  「不存在明显模板套用」:用 list_cards 数同一种卡用了几次、参数是否几乎一样,再用 see_frames 并排看。',
    '调用 issue_plan 之后就结束,不要做别的。',
  ].join('\n');
}

export function judgerVerdictPrompt({ userText, requirements, delivery, opinions, reviewerInterrupted = false }) {
  const list = opinions.length
    ? opinions.map((o, i) => `${i + 1}. ${o.issue}\n   依据:${o.evidence || '(没给)'}`).join('\n')
    : reviewerInterrupted
      ? '(reviewer 这一轮因技术原因中断,没有交出意见。这不代表没有问题 —— 请你自己用只读工具核对工程后再裁定。)'
      : '(reviewer 没有提出意见)';
  return [
    '用户的原话:', userText, '',
    '本轮给 worker 的要求:', requirements, '',
    'worker 的交货总结:', delivery || '(worker 没写总结)', '',
    `reviewer 的意见(共 ${opinions.length} 条):`, list, '',
    '请逐条裁定(可以用只读工具核对),然后调用下面**一个**工具:',
    '- phase_done:四条项目要求都达到了。summary 写每一条的依据。',
    '- request_revision:rulings 对每条意见给出 采纳 / 驳回 / 降级 和理由;requirements 只来自采纳和降级的条目,写成 worker 能直接执行的样子。',
    '- need_user:有必须由用户决定的事。',
  ].join('\n');
}

export function judgerRewritePrompt({ userText, reflection, verdicts }) {
  return [
    '用户的原话:', userText, '',
    'worker 连续三次没有通过你的裁决。三次裁决的逐条理由:', formatVerdicts(verdicts), '',
    'worker 的反省:', reflection || '(worker 没有写出反省)', '',
    '反省只是线索,不是结论:对照你的裁决判断它说得对不对。然后调用 issue_plan 改写:',
    '- requirements:新的任务要求。如果前三次卡在同一件事上,换一种 worker 做得到的要求,或者明确降低这一项的标准。',
    '- reviewerBrief:新的检查项。reviewer 反复提你驳回的那类意见,就在检查项里写明不要再提。',
    '- lessons:你认可的教训,一条一句。之后每一轮都会交给 worker,也会留给以后的运行。',
  ].join('\n');
}

export const WORKER_RULES = [
  '',
  '## 本次运行是审查环路里的一轮',
  '你交付之后,会有 reviewer 审查、judger 裁决。你自己结束这一轮不等于任务完成,只有 judger 能宣布完成。',
  '- 按 judger 给的要求逐条做,做完用 see_frames 核对画面。',
  '- 结束时用中文写交货总结:逐条列出每一项要求 做了什么 / 没做以及原因。没做的不许说成做了。',
  '- 遇到必须由用户处理的事(扫码登录、验证码、需要用户拍板),调用 need_user 说明原因,然后停下。',
].join('\n');

export function workerPrompt({ userText, requirements, lessons = [] }) {
  return [
    '用户的原话:', userText, '',
    'judger 本轮给你的任务要求:', requirements,
    ...(lessons.length ? ['', '之前总结的教训(务必重视):', bullets(lessons)] : []),
  ].join('\n');
}

export const REVIEWER_SYSTEM = [
  '你是 reviewer(审查员)。你不改片子,只挑问题。能用的只有只读工具,看画面用 see_frames。',
  '- 每条意见必须附依据:用了哪个工具、哪个时刻 t、看到了什么。没有依据的意见不要提。',
  '- 只对照检查项和项目要求提意见,不提个人口味。',
  '- 截图只保留最近 10 张,看完几张就先把判断写下来,再往下看。',
  '- 看完调用 submit_review 交出全部意见,然后结束。没有问题就交空列表,并在回复里说明你查了什么。',
].join('\n');

export function reviewerPrompt({ brief, userText, delivery, requirements = PROJECT_REQUIREMENTS }) {
  return [
    'judger 给的检查项:', brief, '',
    '项目要求:', requirements, '',
    '用户的原话:', userText, '',
    'worker 的交货总结:', delivery || '(worker 没写总结)',
  ].join('\n');
}

export function reflectPrompt({ verdicts, toolCounts }) {
  const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join('、');
  return [
    '你已经连续三次没有通过 judger 的裁决。这一轮不干活,只反省。',
    '',
    '三次裁决的逐条理由原文:', formatVerdicts(verdicts), '',
    `你这三轮调用过的工具:${tools || '(没有调用工具)'}`,
    '',
    '回答两个问题。每一条都要引用上面具体的裁决条目,以及你当时实际做了什么:',
    '1. 为什么会出现问题',
    '2. 为了避免出现问题,应该重视哪些问题',
  ].join('\n');
}

function formatVerdicts(verdicts) {
  return verdicts.map((v, i) => [
    `第 ${i + 1} 次:`,
    ...(v.rulings || []).map((r) => `- [${r.verdict}] ${r.opinion} —— ${r.reason}`),
    v.requirements ? `  judger 随后的要求:${v.requirements}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}
