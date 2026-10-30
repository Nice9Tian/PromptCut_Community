/**
 * **桌面版**的氛围式那一屏(用户 2026-10-23 定:「桌面版也要可以用。云端不是必须。因为聊天窗可以走用户的CLI或者API。」)。
 *
 * 和在线浏览器那一屏(`OnlineStart.tsx`)长得一样、用的是同一批部件(顶栏、侧栏、说一句话的输入框、
 * 项目那一排、聊天页、右侧拓展栏、详细编辑),差别只在**数据从哪来**:
 *
 * |          | 在线浏览器(`OnlineStart.tsx`) | 桌面版(本文件) |
 * |---|---|---|
 * | 身份     | 网站账号 / 游客                | 没有账号,就是这台机器 |
 * | 项目     | 云端文档服务的项目列表          | 本机草稿(`src/editor/io/drafts.ts`,和传统开始页的「本地草稿」是同一批) |
 * | 对话     | 云端 Agent(`useVibeCloud.ts`) | 本机的 CLI / API Agent(`useVibeLocal.ts`,和编辑界面 AI 栏同一套,同一段对话) |
 * | 画面     | 一样                           | 一样(`VibeStage.tsx`、`DetailEdit.tsx` 读的都是 store 里的当前项目) |
 *
 * 入口:传统开始页上的「氛围式」,以及编辑界面顶栏工作方式开关的第一格(`src/editor/ModeSwitch.tsx`)。
 * 两处都把地址改成 `?ui=vibe`,刷新后还在这一屏(判断在 `src/StartPage.tsx` 的 `wantsVibe`)。
 * 桌面版的缺省仍是传统开始页 —— 「在线浏览器登录后的默认界面」那一条(`user-workflow.md`「工作方式」)说的是在线,
 * 桌面版改缺省是一级改动,不由会话定。
 *
 * 传统开始页上有而这一屏没有的几样(打开项目文件、加入别人的项目、拓展功能、存储),顶栏右边那颗「拓展与存储」回去用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { actions, useStore } from "../store/project";
import type { DraftInfo } from "../editor/io/drafts";
import { deleteDraft, listDrafts, newDraftId, openDraft, saveDraft, setActiveDraftId } from "../editor/io/drafts";
import { newProject } from "../editor/io/proc";
import { importMediaFiles, MEDIA_ACCEPT } from "../editor/left/importAssets";
import { AiSetupDialog } from "../editor/right/AiSetupDialog";
import { ChatView } from "./ChatView";
import { ProjectRail } from "./ProjectRail";
import { ProjectSidebar, scopeKeyOf, type Scope, type TreeOps } from "./ProjectSidebar";
import { PromptBox } from "./PromptBox";
import { TopBar } from "./TopBar";
import { EXT_WIDTH, SIDE_WIDTH, clampWidth, readSideCollapsed, readWidth, writeSideCollapsed, writeWidth } from "./sideWidth";
import { removeById, rename, reorder, setArchived, togglePin, visible } from "./treeState";
import type { OrgEntry, OrgState, SeenMeta } from "./vibeOrg";
import { LOCAL_ORG_SCOPE, addGroup, groupNoteText, groupsOf, loadOrg, mergeChats, mergeProjects, moveProject, saveOrg, withChats, withGroups, withProjects } from "./vibeOrg";
import { useVibeLocal } from "./useVibeLocal";
import { RATIO_SIZE, projectNameFromPrompt } from "./format";
import type { Ratio, VibeChat, VibeGroup, VibeProject } from "./types";
import "./start.css";

/**
 * 这一屏的分组是**本地分组**(`vibeOrg.ts` 文件头):只装本机草稿项目、存在本机,键是 `orgKey("local", LOCAL_ORG_SCOPE)`。
 * 云端分组是在线那一屏(`OnlineStart.tsx`)的,键前缀不同,两边不会串;本地项目也放不进云端分组。
 */
const ORG_REALM = "local" as const;

/**
 * 改动落定之后隔多久存一次草稿。
 *
 * 氛围式里动手的是 Agent,用户手边没有编辑界面那颗「保存项目」—— 不自动存,这一屏里 Agent 做的东西
 * 一回首页就没了。语义里本来就是这么说的:`workflow/project.md`「草稿自动保存在本机」。
 * 等这一轮跑完再存(`streaming` 落下来),不在流式过程中一遍遍写盘。
 */
const AUTOSAVE_MS = 2500;

/** 同级的键:和 `ProjectSidebar` 里判能不能拖到一起用的是同一套 */
const projectSib = (p: VibeProject) => `project:${p.realm}:${p.groupId ?? "loose"}`;
const chatSib = (c: VibeChat) => `chat:p:${c.projectId}`;

/** 开始页上说的那句话:等项目建好、Agent 就绪之后发出去 */
interface PendingPrompt {
  projectId: string;
  text: string;
}

export function DesktopStart(props: {
  /** 切到传统式:打开编辑界面(项目已经载进 store 了,这里只管换视图) */
  onEnterEditor: () => void;
  /** 回传统开始页:那边才有打开项目文件、加入别人的项目、拓展功能和存储 */
  onClassic: () => void;
}): JSX.Element {
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(true);
  /** 这一屏里打开着的项目(已经载进 store);null 是没开 */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 打开着的项目显示聊天页(true)还是开始页(点了房子) */
  const [chatPage, setChatPage] = useState(false);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [notice, setNotice] = useState("");
  const [sideWidth, setSideWidth] = useState(() => readWidth(SIDE_WIDTH));
  const [extWidth, setExtWidth] = useState(() => readWidth(EXT_WIDTH));
  const [collapsed, setCollapsed] = useState(readSideCollapsed);
  const [panel, setPanel] = useState(false);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDrafts(await listDrafts());
      setListError("");
    } catch (e) {
      setListError(e instanceof Error ? e.message : "读不到本机项目");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /* ---------------- 本机整理(分组、置顶、归档、顺序) ---------------- */
  const [org, setOrgState] = useState<OrgState>(() => loadOrg(ORG_REALM, LOCAL_ORG_SCOPE));
  const setOrg = (next: (o: OrgState) => OrgState) => setOrgState((o) => { const n = next(o); saveOrg(LOCAL_ORG_SCOPE, n); return n; });

  /* ---------------- 项目清单:本机草稿 + 本机整理 ---------------- */
  const entries = useMemo<OrgEntry[]>(
    // 本机草稿都是自己的,没有「别人的项目」这一类;都属本地这一套
    () => drafts.map((d) => ({ id: d.id, name: d.name, role: "owned" as const, realm: ORG_REALM })),
    [drafts],
  );
  /**
   * 列表上那一格显示什么。在线那边靠「这台浏览器打开过」才记得下(`thumbCache.ts`),
   * 桌面版不用猜 —— 草稿文件自己就带着首帧和时长,直接拿来用。画幅草稿里没有,给 null,那一格退回色块比例。
   */
  const meta = useMemo<Record<string, SeenMeta>>(() => {
    const m: Record<string, SeenMeta> = {};
    for (const d of drafts) m[d.id] = { ratio: null, duration: d.duration, thumb: d.thumbnail, seenAt: d.updatedAt };
    return m;
  }, [drafts]);
  const projects = useMemo(() => mergeProjects(org, entries, meta), [org, entries, meta]);
  const groups = useMemo(() => groupsOf(org), [org]);

  /* ---------------- 打开着的项目的本机 Agent ---------------- */
  const vibe = useVibeLocal({ projectId: openId });
  const chats = useMemo(() => (openId ? mergeChats(org, openId, vibe.chats) : []), [org, openId, vibe.chats]);
  const openChat: VibeChat | null = chatPage && openId ? (chats.find((c) => c.id === vibe.tabId) ?? vibe.current) : null;

  /* ---------------- 两栏自己弹开的时机(和在线那一屏同一套,`OnlineStart.tsx`) ---------------- */
  /**
   * 手上已经有项目:左侧栏自动展开(issue #11)。桌面版没有登录这一说,有本机项目就算数。
   * 只弹一次:用户自己动过侧栏之后听他的。
   */
  const sideAuto = useRef(false);
  useEffect(() => {
    if (sideAuto.current || projects.length === 0) return;
    sideAuto.current = true;
    setCollapsed((v) => {
      if (!v) return v;
      writeSideCollapsed(false);
      return false;
    });
  }, [projects.length]);

  /** 点进一条对话:右侧拓展栏自动展开(issue #6)。按对话记,同一条里关掉了就不再弹开 */
  const extAuto = useRef<string | null>(null);
  useEffect(() => {
    const id = openChat?.id ?? null;
    if (!id || extAuto.current === id) return;
    extAuto.current = id;
    setPanel(true);
  }, [openChat?.id]);

  /* ---------------- 自动保存 ---------------- */
  const dirty = useStore((s) => s.dirty);
  /** 存一次当前项目。存不下去(只读、盘满)如实说,不吞掉 */
  const save = useCallback(async (id: string) => {
    try {
      await saveDraft(id);
      await refresh();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "这次没存上，改动还在，过一会儿会再试。");
      return false;
    }
  }, [refresh]);
  useEffect(() => {
    if (!openId || !dirty || vibe.streaming || busy) return;
    const timer = window.setTimeout(() => { void save(openId); }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [openId, dirty, vibe.streaming, busy, save]);

  /* ---------------- 动作 ---------------- */

  /**
   * 点进一个项目:读那份草稿载进 store,再进它的聊天页。已经开着就直接回聊天页。
   *
   * `intoClassic` 为真时载完直接切**传统式**(打开编辑界面)——「最近项目」那一排的缩略图卡片走这条
   * (2026-10-23 用户定,原话:「红色区域是项目卡片，点击这个位置的卡片会进入传统式」),
   * 和在线那一屏(`OnlineStart.tsx`)同一条规矩。侧栏的项目条目不带这个开关,仍然停在聊天页。
   */
  const openProject = (id: string, intoClassic = false) => {
    if (openId === id) { if (intoClassic) enterEditor(); else setChatPage(true); return; }
    setNotice("");
    setBusy(true);
    // 换项目之前先把手上这个存了 —— 换完 store 就是另一个项目,没存的就找不回来了
    const prior = openId && dirty ? save(openId) : Promise.resolve(true);
    void prior.then(() => openDraft(id))
      .then(() => {
        setActiveDraftId(id);
        setOpenId(id);
        setChatPage(true);
        // 刚载进来的草稿还没动过,不会有没存的改动,所以这里直接切,不用再存一次
        if (intoClassic) props.onEnterEditor();
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : "这个项目打不开。"))
      .finally(() => setBusy(false));
  };

  /** 进传统式之前先存一次:编辑界面那边是手动存,带着没存的改动过去,顶栏会一直标着「*」 */
  const enterEditor = () => {
    if (openId && dirty) void save(openId).then(props.onEnterEditor);
    else props.onEnterEditor();
  };

  /**
   * 新建一个本机项目并进去。**建完立刻存一份草稿**:氛围式是对着项目说话,项目得先在列表里有一行,
   * 不能像传统开始页那样等用户自己按「保存项目」。
   */
  const createLocal = async (name: string): Promise<string> => {
    const id = newDraftId();
    newProject(name);
    setActiveDraftId(id);
    await saveDraft(id);
    setOpenId(id);
    setChatPage(true);
    await refresh();
    return id;
    // 之后这个项目的改动由上面那段自动保存管,用户不用自己按「保存项目」
  };

  const createBlank = () => {
    setNotice("");
    setBusy(true);
    void createLocal("未命名")
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : "新建没有成功。"))
      .finally(() => setBusy(false));
  };

  /** 开始页说一句话:建项目 → 定画幅 → 放素材 → 进聊天页 → 这句话发给本机 Agent */
  const submitPrompt = async (text: string, ratio: Ratio) => {
    setBusy(true);
    setNotice("正在新建项目…");
    const picked = files;
    try {
      // 顺序不能反:`createLocal` 里的 `newProject` 会把 store 里的项目整个换掉,
      // 先设画幅的话会被它冲掉(建完再设才留得住)
      const id = await createLocal(projectNameFromPrompt(text));
      if (ratio !== "16:9") actions.setProjectMeta({ ...RATIO_SIZE[ratio] });
      if (picked.length) {
        const r = await importMediaFiles(picked);
        const n = r.counts.video + r.counts.audio + r.counts.image;
        setNotice(n ? `已把 ${n} 个素材放进项目。` : (r.rejected[0] ?? "挑的文件里没有能导入的素材。"));
      } else setNotice("");
      // 画幅和素材一起落盘,免得等自动保存那几秒里关掉就白设了
      if (ratio !== "16:9" || picked.length) await saveDraft(id);
      setFiles([]);
      setPending({ projectId: id, text });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "没能建起这个项目。");
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 侧栏的改动 ---------------- */
  const writeProjects = (f: (list: VibeProject[]) => VibeProject[]) => setOrg((o) => withProjects(o, f(mergeProjects(o, entries, meta))));
  const writeGroups = (f: (list: VibeGroup[]) => VibeGroup[]) => setOrg((o) => withGroups(o, f(groupsOf(o))));
  const writeChats = (f: (list: VibeChat[]) => VibeChat[]) => { if (openId) setOrg((o) => withChats(o, openId, f(mergeChats(o, openId, vibe.chats)))); };
  const archivedNow = (kind: "group" | "project" | "chat", id: string) =>
    kind === "group" ? !!groups.find((g) => g.id === id)?.archived : kind === "project" ? !!projects.find((p) => p.id === id)?.archived : !!chats.find((c) => c.id === id)?.archived;

  const ops: TreeOps = {
    rename: (kind, id, name) => {
      if (kind === "group") writeGroups((a) => rename(a, id, name));
    },
    pin: (kind, id) => {
      if (kind === "group") writeGroups((a) => togglePin(a, id));
      else if (kind === "project") writeProjects((a) => togglePin(a, id));
      else writeChats((a) => togglePin(a, id));
      setNotice("置顶只在自己同级里生效。");
    },
    archive: (kind, id) => {
      const next = !archivedNow(kind, id);
      if (kind === "group") writeGroups((a) => setArchived(a, id, next));
      else if (kind === "project") writeProjects((a) => setArchived(a, id, next));
      else writeChats((a) => setArchived(a, id, next));
      setNotice(next ? "已归档：收进侧栏最下面「已归档」，那里右键能取消归档。项目文件本身不动。" : "已取消归档。");
    },
    remove: (kind, id) => {
      if (kind === "group") {
        const g = groups.find((x) => x.id === id);
        if (g && confirm(`删除分组「${g.name}」？里面的项目会放回「项目」，项目本身不删。`)) writeGroups((a) => removeById(a, id));
        return;
      }
      if (kind === "project") {
        const p = projects.find((x) => x.id === id);
        if (!p) return;
        if (id === openId) { setNotice("这个项目正开着，先回开始页或打开别的项目再删。"); return; }
        if (!confirm(`删除项目「${p.name}」？这会删掉磁盘上的 .proc 文件，不能撤销。`)) return;
        void deleteDraft(id).then(refresh, (e: unknown) => setNotice(e instanceof Error ? e.message : "删除失败。"));
        return;
      }
      const c = chats.find((x) => x.id === id);
      if (!c || c.fresh) return;
      if (!confirm(`关掉对话「${c.name}」？这一页的消息就没了。`)) return;
      vibe.removeChat(id);
    },
    reorder: (kind, dragId, overId, place) => {
      if (kind === "group") writeGroups((a) => reorder(a, () => "group", dragId, overId, place));
      else if (kind === "project") writeProjects((a) => reorder(a, projectSib, dragId, overId, place));
      else writeChats((a) => reorder(a, chatSib, dragId, overId, place));
    },
    move: (projectId, groupId) => {
      const project = projects.find((x) => x.id === projectId);
      if (!project) return;
      // 只许同一套(本地项目对本地分组):跨套的整理信息不动,说明给用户
      const out = moveProject(withProjects(org, projects), project, groupId);
      if (out.refused) { setNotice(out.refused); return; }
      setOrg(() => out.org);
    },
    blocked: (kind, id) => {
      if (kind === "group") return {};
      if (kind === "project") return { rename: "这一版改项目名要进传统式，在编辑界面里改。" };
      const c = chats.find((x) => x.id === id);
      return {
        rename: "对话的名字由 Agent 自己声明的范围决定，这里改不了。",
        remove: c?.fresh ? "还没发过消息的新对话不用关。" : undefined,
      };
    },
  };

  /* ---------------- 右边那一排 ---------------- */
  const shown = useMemo(() => {
    const live = visible(projects);
    if (scope.kind === "group") return live.filter((p) => p.groupId === scope.id);
    if (scope.kind === "loose") return live.filter((p) => p.groupId === null);
    return live;
  }, [projects, scope]);
  const railTitle = scope.kind === "group" ? (groups.find((g) => g.id === scope.id)?.name ?? "分组") : scope.kind === "loose" ? "没放进分组" : "最近项目";

  const listNotice = listError
    ? <>{listError}<button type="button" className="ps-link" data-pc="start-list-retry" onClick={() => void refresh()}>重试</button></>
    : loading && drafts.length === 0 ? "正在读本机项目…"
    : drafts.length === 0 ? "本机还没有项目：在中间说一句话，或点「新建项目」。"
    : null;
  const railEmpty = listError ? `本机项目暂时读不到：${listError}`
    : loading && drafts.length === 0 ? "正在读本机项目…"
    : undefined;

  const agentName = vibe.ai.providers.find((p) => p.id === vibe.ai.provider)?.label ?? null;

  return (
    <div className="ps" data-pc="start-desktop" data-vibe="desktop">
      <TopBar
        atHome={!openChat}
        onHome={() => {
          setChatPage(false);
          setScope({ kind: "all" });
        }}
        collapsed={collapsed}
        onToggleSide={() => {
          // 用户自己动过了:这一次打开页面里不再替他自动展开(issue #11 那条只弹一次)
          sideAuto.current = true;
          setCollapsed((v) => {
            writeSideCollapsed(!v);
            return !v;
          });
        }}
        center={
          openChat ? (
            <div className="ps-top-title">
              <span className="ps-top-name" data-pc="start-chat-name">{openChat.name}</span>
              <span className="ps-top-where">项目「{projects.find((p) => p.id === openChat.projectId)?.name ?? ""}」</span>
            </div>
          ) : null
        }
        right={
          <>
            <button
              type="button"
              className="ps-ghost-btn"
              data-pc="start-agent-setup"
              title={agentName ? `这台机器上的 Agent：${agentName}。点这里换一个或改登录` : "挑一个本机的命令行 Agent，或填一个 API 密钥"}
              onClick={vibe.ai.openSetup}
            >
              {agentName ? `Agent：${agentName}` : "配置 Agent"}
            </button>
            {openChat ? (
              <button
                type="button"
                className="ps-chat-ext-btn"
                data-pc="start-chat-ext-toggle"
                aria-pressed={panel}
                aria-label="右侧拓展栏"
                title="画面、修改前 / 修改后"
                onClick={() => setPanel((v) => !v)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                  <rect x="3" y="4.5" width="18" height="15" rx="2" />
                  <path d="M15 4.5v15" />
                </svg>
              </button>
            ) : (
              <button type="button" className="ps-ghost-btn" data-pc="start-go-classic" title="打开项目文件、加入别人的项目、拓展功能和存储都在那一页" onClick={props.onClassic}>
                拓展与存储
              </button>
            )}
          </>
        }
      />

      <div className="ps-body-row">
        <ProjectSidebar
          groups={groups}
          projects={projects}
          chats={chats}
          connectedId={openId}
          scope={scope}
          onScope={setScope}
          collapsed={collapsed}
          ops={ops}
          width={sideWidth}
          onWidth={setSideWidth}
          onWidthCommit={(px) => {
            setSideWidth(px);
            writeWidth(SIDE_WIDTH, px);
          }}
          onWidthNudge={(delta) =>
            setSideWidth((w) => {
              const next = clampWidth(SIDE_WIDTH, w + delta);
              writeWidth(SIDE_WIDTH, next);
              return next;
            })
          }
          openChatId={openChat?.id ?? null}
          onOpenChat={(chat) => {
            if (chat.id !== vibe.tabId) vibe.openChat(chat.id);
            setChatPage(true);
          }}
          onNewChat={(projectId) => {
            if (projectId !== openId) { openProject(projectId); return; }
            vibe.newChat();
            setChatPage(true);
          }}
          groupNote={groupNoteText(ORG_REALM)}
          onNewGroup={() => {
            const name = prompt(`新分组叫什么？（${groupNoteText(ORG_REALM)}）`, "新分组");
            if (name === null) return;
            setOrg((o) => addGroup(o, name).org);
          }}
          onCreate={createBlank}
          onOpen={openProject}
          notice={listNotice}
        />

        {openChat ? (
          <ChatView
            vibe={vibe}
            title={openChat.name}
            pending={pending && pending.projectId === openId ? pending.text : null}
            onPendingSent={() => setPending(null)}
            panel={panel}
            onPro={enterEditor}
            ext={{
              width: extWidth,
              onWidth: setExtWidth,
              onWidthCommit: (px) => {
                setExtWidth(px);
                writeWidth(EXT_WIDTH, px);
              },
              onWidthNudge: (delta) =>
                setExtWidth((w) => {
                  const next = clampWidth(EXT_WIDTH, w + delta);
                  writeWidth(EXT_WIDTH, next);
                  return next;
                }),
            }}
          />
        ) : (
          <main className="ps-main">
            <div className="ps-body">
              <div className="ps-hero">
                <span className="ps-hero-kicker">由你这台机器上的 Agent 驱动</span>
                <h1 className="ps-hero-title">说一句话，先得到一支片子</h1>
                <span className="ps-hero-sub">写下主题或贴进文案，Agent 建好项目、排好卡片，再由你接着剪。</span>
              </div>

              <PromptBox
                onSubmit={(text, ratio) => void submitPrompt(text, ratio)}
                onUpload={() => fileInput.current?.click()}
                fileCount={files.length}
                busy={busy}
              />
              <input ref={fileInput} type="file" multiple accept={MEDIA_ACCEPT} hidden data-pc="start-prompt-files"
                onChange={(e) => {
                  const list = e.target.files ? [...e.target.files] : [];
                  e.target.value = "";
                  if (list.length) { setFiles((f) => [...f, ...list]); setNotice(`已挑 ${files.length + list.length} 个素材，发出这句话时一起放进新项目。`); }
                }} />
              <p className="ps-prompt-note" role="status" data-pc="start-notice">
                {notice || (vibe.whyNot && openId ? vibe.whyNot : "")
                  || (openId && !chatPage ? "项目还开着：点左边它底下的对话回去接着聊。"
                    : "行上右键可以置顶、归档、放进分组，按住能拖着排序，侧栏右边那条缝能拖宽窄。")}
              </p>

              <ProjectRail
                title={railTitle}
                projects={shown}
                resetKey={scopeKeyOf(scope)}
                onCreate={createBlank}
                onOpen={(id) => openProject(id, true)}
                empty={railEmpty}
              />
            </div>
          </main>
        )}
      </div>

      {/* 挑 Agent、登录、填 API 密钥:和编辑界面 AI 栏开的是同一个窗口 */}
      <AiSetupDialog
        open={vibe.ai.setupOpen}
        onClose={vibe.ai.closeSetup}
        providers={vibe.ai.providers}
        stt={vibe.ai.sttInfo ?? undefined}
        current={vibe.ai.provider}
        onChoose={vibe.ai.setProvider}
        onLogin={vibe.ai.login}
        loginState={vibe.ai.loginState}
        setupJobs={vibe.ai.setupJobs}
        onCancelSetup={vibe.ai.cancelSetup}
        onInstall={vibe.ai.install}
        installState={vibe.ai.installState}
        installError={vibe.ai.installError}
        config={vibe.ai.config}
        onSaveConfig={vibe.ai.saveConfig}
        onClearKey={vibe.ai.clearKey}
      />
    </div>
  );
}
