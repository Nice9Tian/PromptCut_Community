import { snapshotsFor, restoreSnapshots, frameRequest } from "../../render/frameClient";
import { actions, getState } from "../../store/project";
import { createEmptyProject, newProjectId } from "../../kernel/project";
import type { Project } from "../../kernel/project";
import { exportProjectJson } from "./index";
import { bundledCardsOf, collectProjectCards, restoreProjectCards, type BundledCard } from "./procCards";
import { restoreMediaUrls } from "./mediaUrls";
import { dropPythonNodes, publishPythonDrop } from "./pythonDrop";
import { collectProjectAi, applyProjectAi, resetProjectAi, type ProjectAi } from "../../ai/projectAi";
import { getSkillSnapshot } from "../../skill/skillMode";
import { checkAssociation, convertedFromOf, currentAssociation, noteConvertedFrom, noteLoadedAssociation, onGoneConversion, type CollaborationDescriptor, type ConvertedFrom, type CloudProjectAssociation, currentCloudAssociation, noteLoadedCloudAssociation, currentCloudSnapshot } from "../sync/recoveryAssociation";
import { snapshotForSave } from "../sync/cloudSnapshot";
import { UNSUPPORTED_PROC_TEXT } from "../sync/recoveryTexts";
import { writeToHandle } from "./safeWrite";

export { writeToHandle } from "./safeWrite";

/**
 * 存盘时给项目盖一个「这是 SKILL 模式下的产物」的戳。不在 SKILL 模式就不写这一段。
 */
/** 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」):在线页面没有 SKILL 模式,不盖戳 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

function skillStamp(): { active: boolean; at?: string } | undefined {
  if (ONLINE_BUILD) return undefined;
  const { state } = getSkillSnapshot();
  if (!state.active) return undefined;
  return { active: true, at: new Date().toISOString() };
}

/**
 * `.proc` —— PromptCut 自己的项目文件。
 *
 * 里面就是一层薄壳加一份编排:壳记住格式和版本,方便以后改结构时认得出老文件。
 * 兼容读入旧的 `.promptcut.json`(那时候是裸的 Project),所以 `parseProc` 两种都吃。
 *
 * 素材本身不进 .proc,只记素材键和服务端 path —— 一份编排几十 KB,塞进视频就没法发给别人了。
 * 素材键是文件内容的 sha256(`media[i].hash`,A1),读回来时 parseProc 按它把地址换回
 * /@media/<hash>;没有 hash 的老文件才退回按 path 的文件名找(见 mediaUrls.ts)。
 * 要把素材一起带走的是 .procp(zip:首条目就是这份 project.proc,其余 media/<hash>.<ext>,
 * 见 procp.ts),顶栏「打包保存…」走那条路。
 *
 * 一条不变量:**读回来的 clip.params 必须原样保留,这里绝不补默认值。**
 * clip.params 现在是写入时物化的(store 的 addCardClip / setClipCard 会把 defaults
 * 展开成全量存进 clip),所以文件里存的就是全套真值;这里再合一次 defaults 只会
 * 把用户改过的值悄悄盖回去。Stage 里那层 {...defaults, ...params} 只是给
 * 「卡片后来新增了参数、老 clip 缺这个键」兜底,不是这里的职责。
 * 已验证:内存往返和过磁盘往返,params 都逐字节相同。
 */

export const PROC_EXT = ".proc";
export const PROC_FORMAT = "promptcut-project";
export const PROC_VERSION = 1;

export interface ProcFile {
  format: typeof PROC_FORMAT;
  version: number;
  savedAt: string;
  /** 列表里的封面,留给以后填;现在一律 null */
  thumbnail: string | null;
  project: Project;
  /**
   * 剧本和这段 AI 对话。和 project 平级而不是塞进 project 里 ——
   * project 会被 get_project 原样返回给模型,把对话记录放进去等于每次调用
   * 都让它把自己说过的话再读一遍。旧文件没有这一段,读的时候按空处理。
   */
  ai?: ProjectAi;
  /**
   * 这份编排是不是在 SKILL 模式下存的。`jobId` 是旧版(无头实例的任务号,已归档)写的,读得进来,不再写。
   *
   * 只是**留在项目文件里的痕迹**,不是运行时开关 —— 真正决定"现在能不能操作"的是
   * server/skill-gate.mjs 那个状态文件。理由:Rust 壳和编辑器是两个进程,
   * 而 .proc 随时可能被另存到别处、被拷走;拿一份会跑的文件当共享状态,
   * 迟早出现两边看到的模式不一样。这里记下来是为了事后看得出"这段是谁改的"。
   */
  skill?: { active: boolean; jobId?: string | null; at?: string };
  /**
   * 这个项目用到的定制卡(Agent 用 create_card 写的那种)的源码。
   *
   * 素材不进 .proc,卡片代码却要进:素材是用户自己的文件,还在原处;定制卡活在这台机器的
   * src/cards/user/ 全局目录里,拷走 .proc、换台机器、被别的项目同名卡覆盖,片子里就只剩一个
   * 找不到的 cardId。打开时装回本机,规矩见 procCards.ts。没有定制卡就不写这一段。
   */
  cards?: BundledCard[];
  /** Disposable frame deltas, encoded as one gzip/base64 block. */
  snapshots?: string;
  /** Stable room association only. Authentication stays on each device. */
  collaboration?: CollaborationDescriptor;
  /** 这个本地项目是从哪个已不存在的云端项目转来的（只供提示与追溯，不是协作关联；见 `recoveryAssociation.ts`） */
  convertedFrom?: ConvertedFrom;
  /** 账号云端项目另存为文件时的云端关联记号（10-14 第 3.4 节） */
  cloudAssociation?: CloudProjectAssociation;
}

/** 当前项目 → .proc 文本 */
export function serializeProc(thumbnail: string | null = null): string {
  const project = JSON.parse(exportProjectJson()) as Project;
  const cards = collectProjectCards(project);
  const currentAssoc = currentCloudAssociation();
  // 固定非本机快照(`sync/cloudSnapshot.ts`):连着这个云端项目时记下当下确认过的那一版(基准内容 + 哈希 + 序号 + 时间);
  // 没连着(以本地副本打开、断网)时沿用文件里原来的基准与序号。不再取「当前连接的序号」:以本地副本打开时那是本机空间的序号
  const cloudAssoc: CloudProjectAssociation | undefined = currentAssoc
    ? { ...currentAssoc, ...snapshotForSave(currentAssoc, currentCloudSnapshot(currentAssoc.projectId)) }
    : undefined;
  const doc: ProcFile = {
    format: PROC_FORMAT,
    version: PROC_VERSION,
    savedAt: new Date().toISOString(),
    thumbnail,
    snapshots: snapshotsFor(getState().project),
    project,
    ai: collectProjectAi(),
    skill: skillStamp(),
    cards: cards.length ? cards : undefined,
    collaboration: currentAssociation() ?? undefined,
    convertedFrom: convertedFromOf(project) ?? undefined,
    cloudAssociation: cloudAssoc,
  };
  return JSON.stringify(doc, null, 2);
}

/** 收预渲染快照的时限(毫秒) */
export const FRAME_ARCHIVE_TIMEOUT_MS = 2500;

/**
 * 把渲染这边已经做完的预渲染快照收进 `.proc` 文本(保存前等本机的「渲染」写完,`docs/semantics/mechanism/document-service.md`
 * 「保存基准与修改状态检查」)。快照是可以丢的缓存:没有、坏了都不能挡住保存,所以收不到就照原文存;
 * 但**等到时限还没收到**(`timedOut`)要告诉用户这次文件里没带快照,不静默放过。
 */
export async function collectFrameSnapshots(text: string): Promise<{ text: string; timedOut: boolean }> {
  let doc: ProcFile;
  try {
    doc = JSON.parse(text) as ProcFile;
  } catch { return { text, timedOut: false }; }
  if (doc?.format !== PROC_FORMAT) return { text, timedOut: false };
  // 时限看信号本身:frameRequest 会把出错包一层(名字没了),请求之前对齐数据镜像那一步也不吃信号,所以再和时限赛跑一次
  const signal = AbortSignal.timeout(FRAME_ARCHIVE_TIMEOUT_MS);
  const timeUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  try {
    const result = await Promise.race([frameRequest("archive", doc.project, {}, signal), timeUp]);
    doc.snapshots = result.snapshots;
    return { text: JSON.stringify(doc, null, 2), timedOut: false };
  } catch {
    return { text, timedOut: signal.aborted };
  }
}

/** Collect whatever B has completed. Missing/corrupt caches must never prevent saving the project. */
export async function withFrameSnapshots(text: string): Promise<string> {
  return (await collectFrameSnapshots(text)).text;
}

export interface ParseProcOptions {
  /**
   * 老文件没有 project.id 时顶上的身份。从草稿打开时传草稿 id —— 归属表里的老条目
   * 记的就是草稿 id,这样它名下的定制卡照样认得出来。
   */
  legacyId?: string;
}

/** .proc 文本 → Project。旧的裸 Project JSON 也认 */
export function parseProc(text: string, opts: ParseProcOptions = {}): Project {
  const doc = JSON.parse(text);
  // 更新的格式版本不硬读：读得进来也可能悄悄丢掉这一版不认识的字段，再保存就把它们抹了。报错，原文件不动。
  if (doc?.format === PROC_FORMAT && !(Number.isSafeInteger(doc.version) && doc.version >= 1 && doc.version <= PROC_VERSION)) {
    throw new Error(UNSUPPORTED_PROC_TEXT(doc.version));
  }
  const project = doc?.format === PROC_FORMAT ? doc.project : doc;
  if (!project || typeof project !== "object" || !Array.isArray(project.tracks)) {
    throw new Error("这不是一个 PromptCut 项目文件");
  }
  const id = typeof project.id === "string" && project.id ? project.id : opts.legacyId || newProjectId();
  // Python 卡已归档,**转成 Project 之前**就把定义和节点丢掉(见 pythonDrop.ts)。
  // 排在下面那一行 spread 前面:晚一步,原始 JSON 里的 cardDefinitions 就已经铺进去了。
  publishPythonDrop(dropPythonNodes(project));
  const full: Project = { ...createEmptyProject(), ...project, id };
  // 存下来的素材地址是死的 blob: 或裸文件名,按 path 换回能播的 /@media 地址(见 mediaUrls.ts)
  // A .proc can have been created by the desktop build, where the media file
  // lives in the shared Videos/PromptCut/media folder rather than this source
  // checkout's out/media.  Keep the absolute path behind the server's guarded
  // media endpoint so old projects remain playable after moving installations.
  const { media, missing } = restoreMediaUrls(full.media || [], { externalPathUrl: true });
  for (const m of missing) console.warn(`[proc] 缺失素材: ${m.name} (${m.url})`);
  return { ...full, media };
}

/**
 * .proc 文本 → Project,**并把里面的剧本和对话灌回去**。
 *
 * 打开项目走这个,不要直接用 parseProc:后者只解析文档本身,AI 那一段会被漏掉,
 * 于是新打开的项目里还留着上一个项目的对话。旧的 .proc 没有 ai 段,按空处理 ——
 * 也就是会清掉当前对话,这正是「每个项目一份对话」该有的样子。
 */
export function loadProc(text: string, opts: ParseProcOptions = {}): Project {
  const project = parseProc(text, opts);
  let doc: ProcFile | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.format === PROC_FORMAT) doc = parsed;
  } catch {
    /* parseProc 已经验过一遍,走到这儿说明是裸 Project,没有 ai 段 */
  }
  // 先把会抛错的校验都做完,再动任何东西:协作关联写坏了的文件要报错,不能先把当前项目的剧本和对话换掉再报
  checkAssociation(doc?.collaboration);
  applyProjectAi(doc?.ai ?? null);
  noteLoadedAssociation(project, doc?.collaboration);
  noteConvertedFrom(project, doc?.convertedFrom);
  noteLoadedCloudAssociation(project, doc?.cloudAssociation);
  restoreSnapshots(project, doc?.snapshots);
  // 项目里带的定制卡装回本机。不等它:装完 vite 热更新,卡自己出现在舞台和卡库里
  if (doc) void restoreProjectCards(bundledCardsOf(doc), project.id ?? null);
  return project;
}

/** 当前项目名,拿来当默认文件名 */
export function currentProjectName(): string {
  return getState().project.name || "未命名";
}

/** 新建一个空项目并载入(顶栏「新建项目」和开始页「开始创作」都走这里) */
export function newProject(name = "未命名"): Project {
  // 新项目还没有落点,别让它覆盖上一个项目的文件
  forgetSaveTarget();
  // 新项目从空白开始,剧本和对话都不该跟过来
  resetProjectAi();
  const project = createEmptyProject(name);
  actions.loadProject(project, `${name}${PROC_EXT}`);
  return project;
}

/* ── 存到哪儿 ────────────────────────────────────────────────────
 * 以前是造一个 <a download> 点一下,浏览器不问直接丢进「下载」——用户根本
 * 没机会选目录,也不知道文件去哪了。改成用文件系统访问 API 弹真正的「另存为」。
 *
 * 句柄记住一份:第一次保存问一次路径,之后同一个项目的保存直接覆盖那个文件,
 * 不再每次都弹窗(和正经编辑器一致)。**换项目时必须清掉**,否则会把新项目
 * 覆盖到上一个项目的文件上 —— newProject / openDraft 都会调 forgetSaveTarget。
 */

/** lib.dom 里还没有 showSaveFilePicker,只声明我们用到的这一点 */
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

function pickerFn(): SaveFilePicker | null {
  const fn = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof fn === "function" ? fn : null;
}

/**
 * 通用的「另存为」:让用户挑一个落点,拿不到 API 就返回 null 由调用方兜底。
 *
 * 和 writeProcToDisk 共用同一个能力探测,免得项目里出现两套判断。
 * 一样要在用户手势里**第一个** await 它。用户点取消会抛 AbortError。
 */
export async function pickSaveTarget(
  suggestedName: string,
  description: string,
  accept: Record<string, string[]>,
): Promise<FileSystemFileHandle | null> {
  const picker = pickerFn();
  if (!picker) return null;
  return picker({ suggestedName, types: [{ description, accept }] });
}

let saveTarget: FileSystemFileHandle | null = null;

/** 这个项目这一次打开期间存过磁盘文件(记着落点,再存不用问) */
export function hasSaveTarget(): boolean {
  return saveTarget !== null;
}

/** 换项目、换草稿时调用:下次保存重新问路径 */
export function forgetSaveTarget(): void {
  saveTarget = null;
}
// 过期的云端项目转成本地项目之后,原文件保留:下次保存重新问落点,不覆盖它
onGoneConversion(() => forgetSaveTarget());

export type SaveOutcome =
  /** `snapshotsSkipped`:等预渲染快照到了时限,这次文件里没带快照(项目内容是完整的) */
  | { kind: "saved"; where: string; snapshotsSkipped?: boolean }
  /** 用户在「另存为」对话框里点了取消 */
  | { kind: "cancelled" }
  /** 这个 WebView 没有文件系统访问 API,只能退回浏览器下载 */
  | { kind: "downloaded"; where: string };

/**
 * 把 .proc 写到磁盘。
 *
 * `askAlways` 为真时强制弹对话框(「另存为」用),否则沿用上次选的位置。
 * 注意调用时机:showSaveFilePicker 需要用户手势,所以点击处理函数里要**先**
 * 调它,别先 await 别的东西,不然手势过期会抛 SecurityError。
 */
export async function writeProcToDisk(
  content: string | (() => Promise<string>),
  defaultName: string,
  { askAlways = false }: { askAlways?: boolean } = {},
): Promise<SaveOutcome> {
  // 给函数时在挑好落点之后才取内容:连着文档服务时要先等所有本地修改拿到确认(c65-design.md 第 4 节),
  // 而「另存为」必须是手势里的第一个 await
  const produce = () => (typeof content === "function" ? content() : Promise.resolve(content));
  const picker = pickerFn();
  if (!picker) {
    let text = await produce();
    text = await withFrameSnapshots(text);
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(a.href);
    return { kind: "downloaded", where: defaultName };
  }

  if (askAlways || !saveTarget) {
    try {
      saveTarget = await picker({
        suggestedName: defaultName,
        types: [{ description: "PromptCut 项目", accept: { "application/json": [PROC_EXT] } }],
      });
    } catch (e) {
      // 用户点取消是正常操作,不是错误,不要弹报错框
      if ((e as Error)?.name === "AbortError") return { kind: "cancelled" };
      throw e;
    }
  }

  // 内容(含预渲染快照)全备齐了才打开写入流;写临时副本、close 才替换原文件,任一步出错 abort,原文件不变(`safeWrite.ts`)
  const { text, timedOut } = await collectFrameSnapshots(await produce());
  await writeToHandle(saveTarget, text);
  return { kind: "saved", where: saveTarget.name, ...(timedOut ? { snapshotsSkipped: true } : {}) };
}
