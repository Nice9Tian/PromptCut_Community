/**
 * Prompts and tool lists for the review loop (worker / reviewer / judger).
 *
 * Why this loop: a single Agent wraps up as soon as it skips calling tools for a round (agent.mjs),
 * considering itself done whenever it says "completed", thus often delivering half-finished work.
 * Here the determination of "completion" is taken away from the worker and handed to the judger.
 */

/** Project requirements for judger. User's exact words, written as-is into judger's system prompt */
export const PROJECT_REQUIREMENTS =
  'The visuals meet commercial delivery standards. There is no obvious template reuse or samey style. The design style of the animation effects matches the content the video expresses and has a distinctive aesthetic value. The shot pacing is reasonable.';

/**
 * Tools available to reviewer and judger. There is no "read-only" marker in code, so hardcode by name;
 * they cannot access tools outside the list at all, and invoking them yields an "unknown tool" error from agent.mjs.
 */
export const READ_ONLY_TOOLS = [
  'get_project', 'get_clip', 'get_track', 'get_layout', 'get_selection', 'get_transcript', 'get_card_source',
  'list_cards', 'list_media', 'list_shots', 'list_captions', 'list_cuts', 'list_parts', 'list_transitions', 'list_subjects',
  'see_frames', 'think',
];

const bullets = (list) => list.map((s) => `- ${s}`).join('\n');

export function judgerSystem({ requirements = PROJECT_REQUIREMENTS, lessons = [] } = {}) {
  return [
    'You are the judger (judge) of this video. You do not edit the video yourself; you only do three things: set the task requirements for the worker, set the checks for the reviewer, and rule on each of the reviewer\'s opinions one by one.',
    '',
    '## Project requirements',
    requirements,
    '',
    '## Principles',
    '- Only you can declare completion (phase_done). Each of the four project requirements needs evidence (data returned by tools or frames you have seen) before you can pass it.',
    '- You must rule on each of the reviewer\'s opinions one by one: accept, reject, or downgrade (the problem exists but need not be solved this round; write it into the requirements as a minor item).',
    '- Criteria for rejecting: cannot be changed (beyond tool capability or media limits), conflicts with the user\'s own words, is personal taste rather than a project requirement, or the evidence does not hold. Rejected opinions are not passed to the worker. This is the gate that keeps the loop from spinning idle, so reject when it should be rejected.',
    '- Accepted opinions must be rewritten into requirements the worker can execute directly: which clip to change, what to change it to, and how to verify after the change.',
    '- You may verify in person with read-only tools, especially when the reviewer\'s opinions contradict each other or the evidence looks suspicious.',
    ...(lessons.length ? ['', '## Lessons summarized earlier', bullets(lessons)] : []),
  ].join('\n');
}

export function judgerOpenPrompt({ userText }) {
  return [
    'The user\'s own words:',
    userText,
    '',
    'First get to know the current state of the project with read-only tools (get_project, list_media, etc.; use see_frames to look at the frames when needed), then call issue_plan:',
    '- requirements: the task requirements for the worker. List what to deliver one by one following the user\'s own words, and state the acceptance check for each.',
    '- reviewerBrief: break the four project requirements into checks the reviewer can execute; for each, state which tool to use, what to look at, and what counts as failing.',
    '  Example: "the shot pacing is reasonable": use time.start / end of list_shots and get_clip, and lifecycle.settleMs to check how long each shot is and whether a card stays still for a long time after its animation finishes;',
    '  "there is no obvious template reuse": use list_cards to count how many times the same card is used and whether its parameters are almost identical, then compare them side by side with see_frames.',
    'End right after calling issue_plan; do nothing else.',
  ].join('\n');
}

export function judgerVerdictPrompt({ userText, requirements, delivery, opinions, reviewerInterrupted = false }) {
  const list = opinions.length
    ? opinions.map((o, i) => `${i + 1}. ${o.issue}\n   Evidence: ${o.evidence || '(none given)'}`).join('\n')
    : reviewerInterrupted
      ? '(The reviewer was interrupted this round for technical reasons and submitted no opinions. This does not mean there are no problems: check the project yourself with read-only tools before ruling.)'
      : '(the reviewer raised no opinions)';
  return [
    'The user\'s own words:', userText, '',
    'Requirements for the worker this round:', requirements, '',
    'Worker\'s delivery summary:', delivery || '(the worker wrote no summary)', '',
    `Reviewer's opinions (${opinions.length} in total):`, list, '',
    'Rule on each one (you may check with read-only tools), then call **one** of the tools below:',
    '- phase_done: all four project requirements were met. In summary, write the evidence for each one.',
    '- request_revision: in rulings, give each opinion accept / reject / downgrade and a reason; requirements come only from accepted and downgraded items, written so the worker can execute them directly.',
    '- need_user: something must be decided by the user.',
  ].join('\n');
}

export function judgerRewritePrompt({ userText, reflection, verdicts }) {
  return [
    'The user\'s own words:', userText, '',
    'The worker failed your ruling three times in a row. Item-by-item reasons from the three rulings:', formatVerdicts(verdicts), '',
    'Worker\'s reflection:', reflection || '(the worker wrote no reflection)', '',
    'The reflection is only a clue, not a conclusion: compare it against your rulings to judge whether it is right. Then call issue_plan to rewrite:',
    '- requirements: the new task requirements. If the previous three rounds got stuck on the same thing, switch to a requirement the worker can accomplish, or explicitly lower the standard for that item.',
    '- reviewerBrief: the new checklist. If the reviewer keeps raising the kind of opinion you rejected, state in the checklist not to raise it again.',
    '- lessons: the lessons you endorse, one sentence each. They will be given to the worker every round from now on, and kept for future runs.',
  ].join('\n');
}

export const WORKER_RULES = [
  '',
  '## This run is one round of the review loop',
  'After you deliver, a reviewer will review and a judger will rule. Ending this round yourself does not mean the task is complete; only the judger can declare it complete.',
  '- Do each requirement from the judger one by one, then check the picture with see_frames.',
  '- When finished, write the delivery summary in the language the user writes in: for each requirement, list what was done / what was not done and why. Do not claim something was done if it was not.',
  '- If something must be handled by the user (QR code login, verification code, a decision needed from the user), call need_user to explain the reason, then stop.',
].join('\n');

export function workerPrompt({ userText, requirements, lessons = [] }) {
  return [
    'The user\'s own words:', userText, '',
    'Task requirements the judger gave you this round:', requirements,
    ...(lessons.length ? ['', 'Lessons summarized earlier (take them seriously):', bullets(lessons)] : []),
  ].join('\n');
}

export const REVIEWER_SYSTEM = [
  'You are the reviewer. You do not change the video, you only point out problems. Only read-only tools are available; use see_frames to view the picture.',
  '- Every opinion must come with evidence: which tool you used, at which time t, and what you saw. Do not raise opinions without evidence.',
  '- Raise opinions only against the checklist and project requirements, not personal taste.',
  '- Only the latest 10 screenshots are kept; after viewing a few, write down your judgment first, then continue.',
  '- When done, call submit_review to submit all opinions, then finish. If there are no problems, submit an empty list and state in your reply what you checked.',
].join('\n');

export function reviewerPrompt({ brief, userText, delivery, requirements = PROJECT_REQUIREMENTS }) {
  return [
    'Checklist from the judger:', brief, '',
    'Project requirements:', requirements, '',
    'The user\'s own words:', userText, '',
    'Worker\'s delivery summary:', delivery || '(the worker wrote no summary)',
  ].join('\n');
}

export function reflectPrompt({ verdicts, toolCounts }) {
  const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join(', ');
  return [
    'You have failed the judger\'s ruling three times in a row. This round, do no work, only reflect.',
    '',
    'Original item-by-item reasons from the three rulings:', formatVerdicts(verdicts), '',
    `Tools you called in these three rounds: ${tools || '(no tools called)'}`,
    '',
    'Answer two questions. Each answer must cite the specific ruling items above and what you actually did at the time:',
    '1. Why the problems occurred',
    '2. What to pay attention to in order to avoid problems',
  ].join('\n');
}

function formatVerdicts(verdicts) {
  return verdicts.map((v, i) => [
    `Round ${i + 1}:`,
    ...(v.rulings || []).map((r) => `- [${r.verdict}] ${r.opinion} —— ${r.reason}`),
    v.requirements ? `  Judger's following requirements: ${v.requirements}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}
