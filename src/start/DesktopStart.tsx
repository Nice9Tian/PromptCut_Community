/**
 * The Vibe mode screen of the **desktop app** (user decision, 2026-10-23: "The desktop app must be
 * usable too. The cloud is not required, because the chat window can go through the user's CLI or API.").
 *
 * It looks the same as the online browser screen (`OnlineStart.tsx`) and uses the same parts (top bar,
 * sidebar, the one-sentence input box, the project row, chat page, right side panel, detail editing).
 * The only difference is **where the data comes from**:
 *
 * |          | Online browser (`OnlineStart.tsx`) | Desktop app (this file) |
 * |---|---|---|
 * | Identity | website account / guest            | no account, it is just this machine |
 * | Projects | project list from the cloud document service | local drafts (`src/editor/io/drafts.ts`, the same ones as "Local drafts" on the Classic start page) |
 * | Chat     | Cloud Agent (`useVibeCloud.ts`)    | local CLI / API Agent (`useVibeLocal.ts`, the same one as the editor AI panel, the same chat) |
 * | Visuals  | same                               | same (`VibeStage.tsx` and `DetailEdit.tsx` both read the current project in the store) |
 *
 * Entry: "Vibe mode" on the Classic start page, and the first slot of the working mode switch in the editor
 * top bar (`src/editor/ModeSwitch.tsx`). Both change the URL to `?ui=vibe`, so a refresh stays on this
 * screen (the check is `wantsVibe` in `src/StartPage.tsx`).
 * The desktop app still defaults to the Classic start page. The "default screen after online browser login"
 * item (`user-workflow.md`, "Working mode") is about online only; changing the desktop app default is a
 * top-level change, not up to a session.
 *
 * A few things the Classic start page has but this screen does not (open a project file, join someone
 * else's project, extensions, storage): use the "Extensions and storage" button on the right of the top
 * bar to go back there.
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
import { tr } from "../i18n/index.ts";
import { EXT_WIDTH, SIDE_WIDTH, clampWidth, readSideCollapsed, readWidth, writeSideCollapsed, writeWidth } from "./sideWidth";
import { removeById, rename, reorder, setArchived, togglePin, visible } from "./treeState";
import type { OrgEntry, OrgState, SeenMeta } from "./vibeOrg";
import { LOCAL_ORG_SCOPE, addGroup, groupNoteText, groupsOf, loadOrg, mergeChats, mergeProjects, moveProject, saveOrg, withChats, withGroups, withProjects } from "./vibeOrg";
import { useVibeLocal } from "./useVibeLocal";
import { RATIO_SIZE, projectNameFromPrompt } from "./format";
import type { Ratio, VibeChat, VibeGroup, VibeProject } from "./types";
import "./start.css";

/**
 * The groups on this screen are **local groups** (see the header of `vibeOrg.ts`): they only hold local
 * draft projects, stored on this machine, and the key is `orgKey("local", LOCAL_ORG_SCOPE)`.
 * Cloud groups belong to the online screen (`OnlineStart.tsx`) and use a different key prefix, so the two
 * never mix; a local project cannot be put into a cloud group either.
 */
const ORG_REALM = "local" as const;

/**
 * How long to wait after a change settles before saving a draft.
 *
 * In Vibe mode the Agent does the work, and the user has no "Save project" button from the editor at hand.
 * Without auto-save, whatever the Agent makes on this screen is gone once the user returns to the home
 * page. The semantics already say so: `workflow/project.md`, "Drafts are auto-saved on this machine".
 * Save after this round finishes running (when `streaming` drops), not over and over during streaming.
 */
const AUTOSAVE_MS = 2500;

/** Sibling key: the same scheme `ProjectSidebar` uses to decide whether items can be dragged together */
/** Address parameter that carries the open project across the reload of a language switch */
const REOPEN_PARAM = "vibeOpen";

const projectSib = (p: VibeProject) => `project:${p.realm}:${p.groupId ?? "loose"}`;
const chatSib = (c: VibeChat) => `chat:p:${c.projectId}`;

/** The sentence typed on the start page: sent once the project is created and the Agent is ready */
interface PendingPrompt {
  projectId: string;
  text: string;
}

export function DesktopStart(props: {
  /** Switch to Classic mode: open the editor (the project is already loaded into the store, so only the view changes here) */
  onEnterEditor: () => void;
  /** Back to the Classic start page: that is where open project file, join someone else's project, extensions and storage are */
  onClassic: () => void;
}): JSX.Element {
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(true);
  /** The project open on this screen (already loaded into the store); null means none is open */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Whether the open project shows the chat page (true) or the start page (the house icon was clicked) */
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
      setListError(e instanceof Error ? e.message : tr("Cannot read local projects"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /* ---------------- Local organizing (groups, pinning, archive, order) ---------------- */
  const [org, setOrgState] = useState<OrgState>(() => loadOrg(ORG_REALM, LOCAL_ORG_SCOPE));
  const setOrg = (next: (o: OrgState) => OrgState) => setOrgState((o) => { const n = next(o); saveOrg(LOCAL_ORG_SCOPE, n); return n; });

  /* ---------------- Project manifest: local drafts + local organizing ---------------- */
  const entries = useMemo<OrgEntry[]>(
    // Local drafts are all the user's own, so there is no "someone else's project" kind; all belong to the local scheme
    () => drafts.map((d) => ({ id: d.id, name: d.name, role: "owned" as const, realm: ORG_REALM })),
    [drafts],
  );
  /**
   * What each cell in the list shows. The online side only remembers it if "this browser opened it before"
   * (`thumbCache.ts`); the desktop app does not need to guess: the draft file itself carries the first frame
   * and the duration, so use them directly. The draft has no aspect ratio, so give null, and the cell falls
   * back to a color block ratio.
   */
  const meta = useMemo<Record<string, SeenMeta>>(() => {
    const m: Record<string, SeenMeta> = {};
    for (const d of drafts) m[d.id] = { ratio: null, duration: d.duration, thumb: d.thumbnail, seenAt: d.updatedAt };
    return m;
  }, [drafts]);
  const projects = useMemo(() => mergeProjects(org, entries, meta), [org, entries, meta]);
  const groups = useMemo(() => groupsOf(org), [org]);

  /* ---------------- Local Agent of the open project ---------------- */
  const vibe = useVibeLocal({ projectId: openId });
  const chats = useMemo(() => (openId ? mergeChats(org, openId, vibe.chats) : []), [org, openId, vibe.chats]);
  const openChat: VibeChat | null = chatPage && openId ? (chats.find((c) => c.id === vibe.tabId) ?? vibe.current) : null;

  /* ---------------- When the two rails pop open by themselves (same scheme as the online screen, `OnlineStart.tsx`) ---------------- */
  /**
   * Once there is already a project: the left sidebar expands automatically (issue #11). The desktop app has
   * no login, so having a local project is enough.
   * Pops open only once: after the user moves the sidebar themselves, follow the user.
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

  /** Click into a chat: the right side panel expands automatically (issue #6). Tracked per chat; if closed within the same chat it does not pop open again */
  const extAuto = useRef<string | null>(null);
  useEffect(() => {
    const id = openChat?.id ?? null;
    if (!id || extAuto.current === id) return;
    extAuto.current = id;
    setPanel(true);
  }, [openChat?.id]);

  /** Switching language reloads the page: save, and reopen this project's chat afterwards */
  const prepareLanguageSwitch = async (url: URL): Promise<boolean> => {
    if (!openId) return true;
    if (dirty && !(await save(openId)) && !confirm(tr("Your changes could not be saved. Switching language will lose them. Continue?"))) return false;
    url.searchParams.set(REOPEN_PARAM, openId);
    return true;
  };

  /* ---------------- Auto-save ---------------- */
  const dirty = useStore((s) => s.dirty);
  /** Save the current project once. If it cannot be saved (read-only, disk full), say so honestly, do not swallow it */
  const save = useCallback(async (id: string) => {
    try {
      await saveDraft(id);
      await refresh();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : tr("Not saved this time. Your changes are still there and it will retry shortly."));
      return false;
    }
  }, [refresh]);
  useEffect(() => {
    if (!openId || !dirty || vibe.streaming || busy) return;
    const timer = window.setTimeout(() => { void save(openId); }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [openId, dirty, vibe.streaming, busy, save]);

  /* ---------------- Actions ---------------- */

  /**
   * Click into a project: read that draft into the store, then go to its chat page. If it is already open,
   * go straight back to the chat page.
   *
   * When `intoClassic` is true, switch to **Classic mode** right after loading (open the editor). The
   * thumbnail cards in the "Recent projects" row take this path
   * (user decision, 2026-10-23, verbatim: "The red area is the project card, clicking a card in this position enters Classic mode"),
   * the same rule as the online screen (`OnlineStart.tsx`). Project entries in the sidebar do not carry this
   * flag and still stay on the chat page.
   */
  const openProject = (id: string, intoClassic = false) => {
    if (openId === id) { if (intoClassic) enterEditor(); else setChatPage(true); return; }
    setNotice("");
    setBusy(true);
    // Save the current one before switching projects: once the switch is done the store holds another project, and unsaved changes cannot be recovered
    const prior = openId && dirty ? save(openId) : Promise.resolve(true);
    void prior.then(() => openDraft(id))
      .then(() => {
        setActiveDraftId(id);
        setOpenId(id);
        setChatPage(true);
        // The draft just loaded has not been touched, so there are no unsaved changes; switch directly here, no need to save again
        if (intoClassic) props.onEnterEditor();
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : tr("This project cannot be opened.")))
      .finally(() => setBusy(false));
  };

  // Back from a language switch: reopen the project that was open
  useEffect(() => {
    const url = new URL(location.href);
    const id = url.searchParams.get(REOPEN_PARAM);
    if (!id) return;
    url.searchParams.delete(REOPEN_PARAM);
    history.replaceState(history.state, "", url);
    openProject(id);
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save once before entering Classic mode: the editor saves manually, and going there with unsaved changes leaves the top bar marked "*" permanently */
  const enterEditor = () => {
    if (openId && dirty) void save(openId).then(props.onEnterEditor);
    else props.onEnterEditor();
  };

  /**
   * Create a local project and enter it. **Save a draft right after creating**: Vibe mode talks to the
   * project, so the project must already have a row in the list, and it cannot wait for the user to press
   * "Save project" as on the Classic start page.
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
    // After this, changes to the project are handled by the auto-save above; the user does not need to press "Save project"
  };

  const createBlank = () => {
    setNotice("");
    setBusy(true);
    void createLocal(tr("Untitled"))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : tr("Creating the project did not succeed.")))
      .finally(() => setBusy(false));
  };

  /** Say one sentence on the start page: create project → set aspect ratio → add media → enter chat page → send the sentence to the local Agent */
  const submitPrompt = async (text: string, ratio: Ratio) => {
    setBusy(true);
    setNotice(tr("Creating project…"));
    const picked = files;
    try {
      // The order must not be reversed: `newProject` inside `createLocal` replaces the whole project in the store,
      // so setting the aspect ratio first would be wiped by it (set it after creation and it sticks)
      const id = await createLocal(projectNameFromPrompt(text));
      if (ratio !== "16:9") actions.setProjectMeta({ ...RATIO_SIZE[ratio] });
      if (picked.length) {
        const r = await importMediaFiles(picked);
        const n = r.counts.video + r.counts.audio + r.counts.image;
        setNotice(n ? tr("Added {0} media to the project.", n) : (r.rejected[0] ?? tr("None of the chosen files contain media that can be imported.")));
      } else setNotice("");
      // Write the aspect ratio and media to disk together, so closing during the few seconds of waiting for auto-save does not lose the setting
      if (ratio !== "16:9" || picked.length) await saveDraft(id);
      setFiles([]);
      setPending({ projectId: id, text });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : tr("Could not create this project."));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- Sidebar changes ---------------- */
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
      setNotice(tr("Pinning only applies among its own siblings."));
    },
    archive: (kind, id) => {
      const next = !archivedNow(kind, id);
      if (kind === "group") writeGroups((a) => setArchived(a, id, next));
      else if (kind === "project") writeProjects((a) => setArchived(a, id, next));
      else writeChats((a) => setArchived(a, id, next));
      setNotice(next ? tr("Archived: moved to \"Archived\" at the bottom of the sidebar, where you can right-click to unarchive. The project files are untouched.") : tr("Unarchived."));
    },
    remove: (kind, id) => {
      if (kind === "group") {
        const g = groups.find((x) => x.id === id);
        if (g && confirm(tr("Delete group \"{0}\"? Its projects will go back to \"Projects\" and are not deleted.", g.name))) writeGroups((a) => removeById(a, id));
        return;
      }
      if (kind === "project") {
        const p = projects.find((x) => x.id === id);
        if (!p) return;
        if (id === openId) { setNotice(tr("This project is currently open. Go back to the start page or open another project before deleting it.")); return; }
        if (!confirm(tr("Delete project \"{0}\"? This deletes the .proc file on disk and cannot be undone.", p.name))) return;
        void deleteDraft(id).then(refresh, (e: unknown) => setNotice(e instanceof Error ? e.message : tr("Delete failed.")));
        return;
      }
      const c = chats.find((x) => x.id === id);
      if (!c || c.fresh) return;
      if (!confirm(tr("Close chat \"{0}\"? The messages on this page will be lost.", c.name))) return;
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
      // Only the same scheme is allowed (local project into local group): organizing info across schemes is left untouched, and the user is told why
      const out = moveProject(withProjects(org, projects), project, groupId);
      if (out.refused) { setNotice(out.refused); return; }
      setOrg(() => out.org);
    },
    blocked: (kind, id) => {
      if (kind === "group") return {};
      if (kind === "project") return { rename: tr("In this version, renaming a project requires Classic mode: do it in the editor.") };
      const c = chats.find((x) => x.id === id);
      return {
        rename: tr("A chat's name is set by the scope the Agent declares itself, so it can't be changed here."),
        remove: c?.fresh ? tr("A new chat with no messages sent yet doesn't need closing.") : undefined,
      };
    },
  };

  /* ---------------- The row on the right ---------------- */
  const shown = useMemo(() => {
    const live = visible(projects);
    if (scope.kind === "group") return live.filter((p) => p.groupId === scope.id);
    if (scope.kind === "loose") return live.filter((p) => p.groupId === null);
    return live;
  }, [projects, scope]);
  const railTitle = scope.kind === "group" ? (groups.find((g) => g.id === scope.id)?.name ?? tr("Group")) : scope.kind === "loose" ? tr("Not in a group") : tr("Recent projects");

  const listNotice = listError
    ? <>{listError}<button type="button" className="ps-link" data-pc="start-list-retry" onClick={() => void refresh()}>{tr("Retry")}</button></>
    : loading && drafts.length === 0 ? tr("Reading local projects…")
    : drafts.length === 0 ? tr("No local projects yet: say something in the middle, or click \"New project\".")
    : null;
  const railEmpty = listError ? tr("Local projects can't be read right now: {0}", listError)
    : loading && drafts.length === 0 ? tr("Reading local projects…")
    : undefined;

  const agentName = vibe.ai.providers.find((p) => p.id === vibe.ai.provider)?.label ?? null;

  return (
    <div className="ps" data-pc="start-desktop" data-vibe="desktop">
      <TopBar
        prepareLanguageSwitch={prepareLanguageSwitch}
        atHome={!openChat}
        onHome={() => {
          setChatPage(false);
          setScope({ kind: "all" });
        }}
        collapsed={collapsed}
        onToggleSide={() => {
          // The user moved it themselves: do not auto-expand it for them again during this page open (the issue #11 rule pops only once)
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
              <span className="ps-top-where">{tr("Project \"{0}\"", projects.find((p) => p.id === openChat.projectId)?.name ?? "")}</span>
            </div>
          ) : null
        }
        right={
          <>
            <button
              type="button"
              className="ps-ghost-btn"
              data-pc="start-agent-setup"
              title={agentName ? tr("Agent on this machine: {0}. Click here to switch or change the login", agentName) : tr("Pick a local command-line Agent, or enter an API key")}
              onClick={vibe.ai.openSetup}
            >
              {agentName ? tr("Agent: {0}", agentName) : tr("Set up Agent")}
            </button>
            {openChat ? (
              <button
                type="button"
                className="ps-chat-ext-btn"
                data-pc="start-chat-ext-toggle"
                aria-pressed={panel}
                aria-label={tr("right side panel")}
                title={tr("Picture, before / after")}
                onClick={() => setPanel((v) => !v)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                  <rect x="3" y="4.5" width="18" height="15" rx="2" />
                  <path d="M15 4.5v15" />
                </svg>
              </button>
            ) : (
              <button type="button" className="ps-ghost-btn" data-pc="start-go-classic" title={tr("Opening project files, joining other people's projects, extensions and storage are all on that page")} onClick={props.onClassic}>
                {tr("Extensions and storage")}
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
            const name = prompt(tr("What should the new group be called? ({0})", groupNoteText(ORG_REALM)), tr("New group"));
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
                <span className="ps-hero-kicker">{tr("Driven by the Agent on this machine")}</span>
                <h1 className="ps-hero-title">{tr("Say one sentence, get a video first")}</h1>
                <span className="ps-hero-sub">{tr("Write a topic or paste in a script, the Agent builds the project and arranges the cards, and then you carry on editing.")}</span>
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
                  if (list.length) { setFiles((f) => [...f, ...list]); setNotice(tr("{0} media selected, they will be put into the new project together when this message is sent.", files.length + list.length)); }
                }} />
              <p className="ps-prompt-note" role="status" data-pc="start-notice">
                {notice || (vibe.whyNot && openId ? vibe.whyNot : "")
                  || (openId && !chatPage ? tr("The project is still open: click the chat under it on the left to pick up where you left off.")
                    : tr("Right-click a row to pin, archive, or put it in a group. Press and hold to drag to reorder. The seam on the right of the sidebar can be dragged to resize it."))}
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

      {/* Pick an Agent, log in, fill in the API key: the same window the editor AI panel opens */}
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
