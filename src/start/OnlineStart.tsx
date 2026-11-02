/**
 * First screen of the online browser (desktop identity): **Vibe mode** (`user-workflow.md`,
 * "Working mode": the default UI after login in the online browser).
 * Not logged in still shows the start page (issue #2, user 2026-11-03: no standalone login page first):
 * "Sign in" sits in the top bar's account slot, and anything that needs an identity (say a sentence,
 * new project, open a project, expand the sidebar) opens the login dialog (`LoginDialog.tsx`) over the
 * page, then carries on with that action once signed in. A project's direct address opened while
 * logged out opens the dialog straight away, and the project is entered after login
 * (`product/platforms.md`, "Project direct address"). The old full-page login is archived and still
 * reached with `?login=page`. Logged in (or entering as a guest) the start page lists the projects;
 * clicking into a project opens that project's chat page.
 *
 * Shape of the whole page (user decision, 2026-10-23, UI is final):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ House Collapse Logo  [chat name]  Account [Shared][Side panel] │  ← top bar, spans the width
 *   ├──────────┬───────────────────────────────────┤
 *   │ Sidebar   │ Start page / chat page (side panel can open on the right) │
 *   └──────────┴───────────────────────────────────┘
 *
 * On 2026-10-23 the business layer was wired up (`docs/reports/AGENT-claude-vibe-wire.md`); where
 * each part connects:
 *   - **Login / guest / join by link / enter project**: `src/account/useAccountProjects.ts` (shared
 *     with the old start page `AccountProjects.tsx` and the mobile app's `MobileStart.tsx`).
 *     Secondary password, not on the list, and join requests follow its existing handling
 *     (`JoinPanel.tsx`).
 *     When entering a project it calls `onEnterEditor`: here we **don't enter the editor**, but stay
 *     on this page and open the project's chat page; only when the user wants to work by hand does
 *     "Enter Classic mode" (the button at the head of detail editing) call the real upper-level
 *     `onEnterEditor` (Shell switches to the editor, with the project already connected).
 *   - **Project list on the left**: real cloud projects (ones I created / ones I joined; for a guest,
 *     the one this machine remembers); groups are **cloud groups**: they hold only cloud projects,
 *     local drafts can't go in (the desktop app's screen has local groups, `DesktopStart.tsx`).
 *     Cloud groups are stored in the cloud, follow the account, and are visible after switching
 *     devices (`useCloudOrg.ts` drives the sync, `orgSync.ts` is the sync logic, `orgMerge.ts` is
 *     the three-way merge for when two devices edit at the same time); the copy on this machine is
 *     a cache, used first on open. When an old server doesn't have this endpoint yet, it quietly
 *     falls back to recording only in this browser. Guests have no groups (only one project, and
 *     the identity doesn't cross devices).
 *   - **Input box in the middle**: say one sentence → create a cloud project (sized by the chosen
 *     aspect ratio, with the picked media attached) → enter its chat page → that sentence is sent
 *     to the Cloud Agent as the first message.
 *   - **Chat page, side panel on the right**: real Cloud Agent chat (`useVibeCloud.ts`), real
 *     picture (`VibeStage.tsx`), real before / after edits.
 *   - **Detail editing**: the real stage, plus the editor's **real timeline** (drag, trim and split
 *     all work, `DetailEdit.tsx`).
 *   - **Thumbnails**: projects opened in this browser have their first frame recorded
 *     (`thumbCache.ts`); without one it is a color block.
 *
 * The mobile identity uses a different UI (`src/mobile/MobileStart.tsx`); this page only handles
 * desktop.
 * When data can't be fetched (not logged in, network down, service unavailable), every place states
 * its empty state or error explicitly, with no fake data and no blank screen.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  GUEST_CHAT_LIMIT_TEXT,
  GUEST_LIMITS,
  GUEST_LIMITS_TEXT,
  getAccountExtensions,
  subscribeAccountExtensions,
  type AccountProjectsHookResult,
} from "../editor/sync/accountExtensions";


import { currentAccountProjectLink, currentDocProjectId, forgetSharedResume, pushToast, useSync } from "../editor/sync/syncManager";
import { importMediaFiles, MEDIA_ACCEPT } from "../editor/left/importAssets";
import { SyncOverlays } from "../editor/sync/SyncOverlays";
import { actions } from "../store/project";
import { JoinForm } from "../editor/sync/JoinForm";
import { ChatView } from "./ChatView";
import { JoinPanel } from "./JoinPanel";
import { ProjectRail } from "./ProjectRail";
import { ProjectSidebar, scopeKeyOf, type Scope, type TreeOps } from "./ProjectSidebar";
import { createBrowseChats } from "./browseChats";
import { PromptBox } from "./PromptBox";
import { TopBar } from "./TopBar";
import { VibeLogin, type LoginIntent } from "./VibeLogin";
import { LoginDialog } from "./LoginDialog";
import { EXT_WIDTH, SIDE_WIDTH, clampWidth, readSideCollapsed, readWidth, writeSideCollapsed, writeWidth } from "./sideWidth";
import { removeById, rename, reorder, setArchived, togglePin, visible } from "./treeState";
import { CLOUD_ORG_IN_CLOUD, addGroup, cloudOrgScope, groupNoteText, groupsOf, mergeChats, mergeProjects, moveProject, orgWhereText, pruneOrg, withChats, withGroups, withProjects, type OrgEntry } from "./vibeOrg";
import { accountOrgTransport } from "./orgTransport";
import { useCloudOrg } from "./useCloudOrg";
import { seenProjects, subscribeSeen } from "./thumbCache";
import { useSeenProject } from "./useSeenProject";
import { useVibeCloud } from "./useVibeCloud";
import { RATIO_SIZE, createWithFreeName, projectNameFromPrompt } from "./format";
import type { Ratio, VibeChat, VibeGroup, VibeProject } from "./types";
import "./start.css";
import { tr } from "../i18n/index.ts";

/** Root path of the editor page: in the online build it is `/editor/` */
const PAGE_BASE = (typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL) || "/";

/** Back to the start page: change the address from the project's direct address back to `/editor/`, so a refresh stays on the start page (same as Shell's "back to home") */
function showHomeAddress() {
  try {
    const url = new URL(location.href);
    url.pathname = PAGE_BASE;
    for (const key of ["project", "token", "linkToken"]) url.searchParams.delete(key);
    history.replaceState(history.state, "", url);
  } catch { /* Being unable to change the address bar doesn't affect going back to the start page */ }
}

/** Sibling key: the same scheme `ProjectSidebar` uses to decide whether items can be dragged together */
const projectSib = (p: VibeProject) => `project:${p.realm}:${p.groupId ?? "loose"}`;

/** Guests have no groups, pinning or archiving: only one project, the identity doesn't cross devices, and there is nowhere to store the cloud copy */
const GUEST_ORG_TEXT = tr("A guest can have only one project, with no groups, pinning or archiving. After you sign up for an account, you can organize projects with cloud groups.");
const chatSib = (c: VibeChat) => `chat:p:${c.projectId}`;

/**
 * The archived full-page login (`VibeLogin.tsx` + `OnlineLogin.tsx`), kept reachable with `?login=page`
 * (issue #2, 2026-11-03: archived, not deleted). Read once: the address is fixed for the page's life here
 */
function legacyLoginPage(): boolean {
  try { return new URLSearchParams(location.search).get("login") === "page"; } catch { return false; }
}

/** The page was opened at a project's direct address or a share link (`product/platforms.md`, "Project direct address") */
function atProjectAddress(): boolean {
  try {
    const url = new URL(location.href);
    return /\/(p|s)\//.test(url.pathname) || url.searchParams.has("project") || url.searchParams.has("token");
  } catch { return false; }
}

/** What a logged-out visitor tried to do: done once signed in (issue #2) */
type AfterLogin =
  | { kind: "open"; id: string; intoClassic: boolean }
  | { kind: "create" }
  | { kind: "prompt"; text: string; ratio: Ratio };

/** The sentence said on the start page: sent after the project is created, connected, and the Cloud Agent is ready */
interface PendingPrompt {
  projectId: string;
  text: string;
}

export function OnlineStart(props: { onEnterEditor: () => void }): JSX.Element {
  const ext = useSyncExternalStore(subscribeAccountExtensions, getAccountExtensions, getAccountExtensions);
  if (!ext.useAccountProjects) {
    return (
      <div className="ps-online-start">
        <JoinForm onJoined={props.onEnterEditor} />
      </div>
    );
  }
  return <OnlineStartWithAccount onEnterEditor={props.onEnterEditor} useAccountProjects={ext.useAccountProjects} />;
}

function OnlineStartWithAccount(props: {
  onEnterEditor: () => void;
  useAccountProjects: (opts: { online: boolean; onEnterEditor: () => void }) => AccountProjectsHookResult;
}): JSX.Element {
  const { useAccountProjects } = props;
  /**
   * After entering a project (clicked from the list, joined by link, newly created, auto-entered via
   * direct address), `useAccountProjects` calls this:
   * don't enter the editor, open the project's chat page on this page. Route through a ref, so that an
   * async flow in progress doesn't hold an old callback
   */
  const entered = useRef<() => void>(() => {});
  /** Record the project ID when this click was on a thumbnail card (to enter Classic mode); null when it came from a sidebar click */
  const toClassic = useRef<string | null>(null);
  const ap = useAccountProjects({ online: true, onEnterEditor: () => entered.current() });
  const shared = useSync((s) => s.shared);
  const blocked = useSync((s) => s.blocked);

  /** The project open on this page (already connected to the document service); null means none is open */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Whether the open project shows the chat page (true) or the start page (the house icon was clicked) */
  const [chatPage, setChatPage] = useState(false);
  /** Only the archived full-page login (`?login=page`) uses this: its "skip" shows the logged-out start page */
  const [skipped, setSkipped] = useState(false);
  const [legacyLogin] = useState(legacyLoginPage);
  /** The login dialog (issue #2) */
  const [loginOpen, setLoginOpen] = useState(false);
  const afterLogin = useRef<AfterLogin | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [notice, setNotice] = useState("");
  const [sideWidth, setSideWidth] = useState(() => readWidth(SIDE_WIDTH));
  const [extWidth, setExtWidth] = useState(() => readWidth(EXT_WIDTH));
  const [collapsed, setCollapsed] = useState(readSideCollapsed);
  const [panel, setPanel] = useState(false);
  const [join, setJoin] = useState<{ askPassword: boolean } | null>(null);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  /** Clicked a chat under another project: enter this one after that project connects (issue #15) */
  const [wantChat, setWantChat] = useState<{ projectId: string; chatId: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The connected project was replaced or disconnected (kicked, project gone, logged out): close this page along with it
  const connectedId = shared?.projectId ?? null;
  useEffect(() => {
    if (openId && connectedId !== openId) { setOpenId(null); setChatPage(false); }
  }, [connectedId, openId]);
  useEffect(() => {
    if (blocked === "kicked") setNotice(tr("You have been kicked from this project."));
    else if (blocked === "removed") setNotice(tr("You are no longer on this project's member list."));
  }, [blocked]);

  /**
   * After entering a project: go by the project currently connected in the sync state (by the time
   * `enterAccountProject` finishes it is already this project; at the moment of entering React hasn't
   * re-rendered, and `shared` may still be the old one, so read it live). If it can't be read, we
   * didn't get in; stay on the start page
   */
  entered.current = () => {
    const id = currentDocProjectId() || null;
    if (!id) return;
    setOpenId(id);
    setChatPage(true);
    setJoin(null);
    setNotice("");
    // Came in from a thumbnail card: once connected, switch straight to Classic mode (the chat page's state stays underneath, same as when clicking "Enter Classic mode")
    if (toClassic.current === id) { toClassic.current = null; props.onEnterEditor(); }
  };

  const signedIn = !!(ap.account || ap.guest);
  const signedInRef = useRef(signedIn); signedInRef.current = signedIn;
  /** Open the login dialog; `then` is done once signed in (closing the dialog without signing in drops it) */
  const askLogin = (then: AfterLogin | null = null) => {
    afterLogin.current = then;
    ap.setError("");
    setLoginOpen(true);
  };
  /** Cloud groups follow the account; guests have none (null: can't be read or saved, organization data is always empty) */
  const orgScope = ap.account ? cloudOrgScope(ap.account.id) : null;

  /* ---------------- Cloud organization (cloud groups, pins, archive, order): stored in the cloud, the local copy is a cache ---------------- */
  // The transport object must be stable: a new one rebuilds the sync engine. Before login, and for guests, it is null (no sync)
  const orgTransport = useMemo(() => (ap.account ? accountOrgTransport(() => ap.orgApi) : null), [ap.account?.id, ap.orgApi]); // eslint-disable-line react-hooks/exhaustive-deps
  const { org, setOrg, status: orgStatus } = useCloudOrg({ scope: orgScope, transport: orgTransport });
  /** Whether cloud groups are really stored in the cloud right now: with an old server (no such endpoint) the UI says honestly that they are only kept in this browser */
  const orgInCloud = CLOUD_ORG_IN_CLOUD && orgStatus !== "unsupported";
  const orgSyncNote = orgStatus === "pending" ? tr("Cloud groups failed to sync: changes are saved in this browser for now and will be applied automatically once you're online.") : null;
  /** A guest changing organization data: refuse, and say why. Returns true if it was blocked */
  const guestBlocked = (): boolean => {
    if (!ap.guest) return false;
    setNotice(GUEST_ORG_TEXT);
    return true;
  };

  /* ---------------- Project manifest: cloud list + local organization + visuals remembered locally ---------------- */
  const seen = useSyncExternalStore(subscribeSeen, seenProjects, seenProjects);
  const cloudEntries = useMemo<OrgEntry[]>(() => {
    // Every project on this screen is a cloud project, so it belongs to the cloud set
    if (ap.guest) return ap.guestProject ? [{ id: ap.guestProject.id, name: ap.guestProject.name, role: "guest", realm: "cloud" }] : [];
    if (!ap.lists) return [];
    return [
      ...ap.lists.owned.map((p) => ({ id: p.projectId, name: p.name, role: "owned" as const, realm: "cloud" as const })),
      ...ap.lists.joined.map((p) => ({ id: p.projectId, name: p.name, role: "joined" as const, realm: "cloud" as const })),
    ];
  }, [ap.guest, ap.guestProject, ap.lists]);
  // Projects just connected but not in the list yet (just joined via link, or entered by direct URL): list them first
  // under the name from the sync state; once the list refreshes, the list wins
  const entries = useMemo(() => {
    if (!openId || cloudEntries.some((c) => c.id === openId)) return cloudEntries;
    return [{ id: openId, name: shared?.name || tr("Cloud project"), role: shared?.creator ? ("owned" as const) : ("joined" as const), realm: "cloud" as const }, ...cloudEntries];
  }, [cloudEntries, openId, shared?.name, shared?.creator]);
  const projects = useMemo(() => mergeProjects(org, entries, seen), [org, entries, seen]);
  const groups = useMemo(() => groupsOf(org), [org]);
  // After the project list is fetched, remove projects from the organization data that are no longer in the list
  // (the cloud copy must not only ever grow); if the list wasn't fetched, don't prune
  useEffect(() => {
    if (ap.guest || !ap.lists) return;
    const ids = new Set(entries.map((e) => e.id));
    setOrg((o) => pruneOrg(o, ids));
  }, [ap.guest, ap.lists, entries]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- Cloud Agent of the open project ---------------- */
  const vibe = useVibeCloud({ connected: !!openId && connectedId === openId, shown: chatPage });
  useSeenProject(openId && connectedId === openId ? openId : null);

  /* ---------------- What to list under an expanded but unopened project (issue #15) ---------------- */
  /** Who is viewing: an account or a guest. A different person means a different store, so chats fetched by the previous account must not leak over */
  const principalId = ap.account?.id ?? ap.guest?.id ?? null;
  const browse = useMemo(() => createBrowseChats({
    session: (projectId) => ap.peekSession(projectId),
    viewer: () => ({ accountId: principalId }),
    origin: () => (typeof location !== "undefined" ? location.origin : ""),
  }), [principalId]); // eslint-disable-line react-hooks/exhaustive-deps
  const browsed = useSyncExternalStore(browse.subscribe, browse.snapshot, browse.snapshot);
  // The open project uses the live copy (`useVibeCloud`), the others use the read-only browse-state copy;
  // both get the local organization applied (pins, archive, order)
  const chats = useMemo(() => {
    const here = openId ? mergeChats(org, openId, vibe.chats) : [];
    const elsewhere = Object.keys(browsed)
      .filter((id) => id !== openId)
      .flatMap((id) => mergeChats(org, id, browsed[id].chats));
    return [...here, ...elsewhere];
  }, [org, openId, vibe.chats, browsed]);
  // The chat currently shown on the chat page. While the cloud chat list hasn't been read back yet (notice not yet
  // confirmed, just connected), show it as a new chat for now, so the notice dialog pops up on the chat page
  const openChat: VibeChat | null = chatPage && openId
    ? (chats.find((c) => c.id === vibe.chat.conversationId) ?? vibe.current ??
      { id: vibe.chat.conversationId || "pending", name: tr("New chat"), projectId: openId, state: "idle", visibility: "shared", readOnly: false, fresh: true })
    : null;

  /* ---------------- When the two rails open by themselves ---------------- */
  /**
   * Logged in and already holding projects: the left sidebar expands automatically (issue #11). When there is
   * something to list, the user shouldn't have to click the collapse button first.
   * Only pops once: after the user moves the sidebar themselves during this page visit (`onToggleSide`), follow
   * them and never auto-expand again.
   * The expanded state is still remembered locally as usual (`writeSideCollapsed`), so it stays expanded after a
   * refresh.
   */
  const sideAuto = useRef(false);
  useEffect(() => {
    if (sideAuto.current || !signedIn || projects.length === 0) return;
    sideAuto.current = true;
    setCollapsed((v) => {
      if (!v) return v;
      writeSideCollapsed(false);
      return false;
    });
  }, [signedIn, projects.length]);

  /**
   * A chat under another project was clicked in the sidebar (issue #15): that click first opens that project, and
   * here we wait for it to connect before entering the chat.
   * If it can't connect (needs a secondary password, no longer on the list), keep waiting, and never switch to a
   * chat of another project by mistake: the key records the project ID
   */
  useEffect(() => {
    if (!wantChat || openId !== wantChat.projectId || connectedId !== wantChat.projectId) return;
    if (vibe.chat.conversationId !== wantChat.chatId) vibe.chat.openChat(wantChat.chatId);
    setChatPage(true);
    setWantChat(null);
  }, [wantChat, openId, connectedId, vibe.chat.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Entering a chat: the right side panel expands automatically (issue #6). Once in the session, the user should
   * be able to see the picture and the before / after edit.
   * Remembered per chat: if the user closed it themselves in the same chat, it no longer pops open; switching to
   * another chat pops it open again.
   */
  const extAuto = useRef<string | null>(null);
  useEffect(() => {
    const id = openChat?.id ?? null;
    if (!id || extAuto.current === id) return;
    extAuto.current = id;
    setPanel(true);
  }, [openChat?.id]);

  /* ---------------- Actions ---------------- */
  const failText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

  /**
   * Enter a project. If already connected, go straight back to its chat page. If a secondary password is set and
   * hasn't been entered yet: open "Join with link", which asks for the password.
   *
   * When `intoClassic` is true, switch straight to **Classic mode** after entering (opening the editor). The
   * thumbnail cards in the "Recent projects" row take this path
   * (user decision, 2026-10-23, original words: "The red area is the project card; clicking a card in this
   * position enters Classic mode").
   * Project entries in the sidebar don't carry this switch and still stop on the chat page: that is where Vibe mode
   * manages projects and resumes the last chat.
   * The actual switch happens in `entered.current`: it only counts once the project is connected
   * (`enterAccountProject` has finished).
   */
  /**
   * Copy the current project's link. In Vibe mode this is a **permanent** share entry (issue #15):
   * previously the link was only available from the never-disappearing bubble shown on entering a project, so that
   * bubble could neither go away by itself nor avoid stacking up one after another
   */
  const copyProjectLink = () => {
    const link = currentAccountProjectLink();
    if (!link) { pushToast(tr("The project link isn't available yet: try again once the project is connected."), "warn"); return; }
    void navigator.clipboard?.writeText(link).then(
      () => pushToast(tr("Project link copied."), "info"),
      () => pushToast(tr("Project link: {0}", link), "info", Infinity),
    );
  };

  const openProject = (id: string, intoClassic = false) => {
    if (!signedIn) { askLogin({ kind: "open", id, intoClassic }); return; }
    toClassic.current = intoClassic ? id : null;
    if (openId === id && connectedId === id) { if (intoClassic) props.onEnterEditor(); else setChatPage(true); return; }
    const p = projects.find((x) => x.id === id);
    setNotice("");
    void ap.perform(async () => {
      if (p?.role === "guest") { await ap.openGuestProject(); return; }
      if (await ap.open(id, p?.name ?? tr("Cloud project")) === "secondary-required") setJoin({ askPassword: true });
    });
  };

  // Logged out is not "blocked": the buttons stay live and open the login dialog (issue #2)
  const createBlocked = ap.guest && ap.guestProject ? tr("Guests can create only {0} project(s). To create more, sign up for an account.", GUEST_LIMITS.projects)
    : null;

  /** Create a blank cloud project and enter it (sidebar "New project", first slot of the thumbnails) */
  const createBlank = () => {
    if (!signedIn) { askLogin({ kind: "create" }); return; }
    if (createBlocked) { setNotice(createBlocked); return; }
    void ap.perform(() => createWithFreeName(n => ap.create(n), tr("Untitled")).then(() => undefined));
  };

  /** Say one sentence on the start page: create project → set aspect ratio → upload media → enter chat page → send this sentence to the Cloud Agent */
  const submitPrompt = async (text: string, ratio: Ratio) => {
    if (!signedIn) { askLogin({ kind: "prompt", text, ratio }); return; }
    if (createBlocked) { setNotice(createBlocked); return; }
    setCreating(true);
    setNotice(tr("Creating project…"));
    const picked = files;
    try {
      await ap.perform(async () => {
        await createWithFreeName(n => ap.create(n), projectNameFromPrompt(text));
        const id = currentDocProjectId() || null;
        if (!id) throw new Error(tr("The project was created but could not be opened. Click it in the project list on the left."));
        if (ratio !== "16:9") actions.setProjectMeta({ ...RATIO_SIZE[ratio] });
        if (picked.length) {
          const r = await importMediaFiles(picked);
          const n = r.counts.video + r.counts.audio + r.counts.image;
          setNotice(n ? tr("Added {0} media to the project.", n) : (r.rejected[0] ?? tr("None of the chosen files contain media that can be imported.")));
        } else setNotice("");
        setFiles([]);
        setPending({ projectId: id, text });
      });
    } finally {
      setCreating(false);
    }
  };

  const signOut = () => {
    // First leave the connected project (stop using this identity for the document service), then log out of the account or drop the guest identity
    forgetSharedResume();
    setOpenId(null);
    setChatPage(false);
    setPending(null);
    setWantChat(null);
    browse.forget();
    showHomeAddress();
    if (ap.guest) ap.leaveGuest();
    else void ap.perform(ap.logout);
    setSkipped(false);
  };

  const onIntent = (it: LoginIntent) => {
    if (it.link) ap.setLink(it.link);
    if (it.kind === "skip") { setSkipped(true); return; }
    void ap.perform(async () => {
      if (it.kind === "guest") await ap.enterAsGuest();
      // The Google path already logged in successfully on the login page; here we only let the business layer accept the
      // session (`adoptSession` of `useAccountProjects`)
      else if (it.kind === "third-party") await ap.adoptSession();
      else await ap.login(it.name, it.password, it.remember);
      if (it.link) setJoin({ askPassword: false });
    });
  };

  /*
   * Once signed in, carry on with what the logged-out visitor tried (issue #2). Wait for the business
   * layer to finish signing in (`busy`), so this action doesn't overlap that one. Goes through a ref so
   * the action uses this render's functions, not the logged-out render's
   */
  const runAfter = useRef<(a: AfterLogin) => void>(() => {});
  runAfter.current = (a) => {
    if (a.kind === "open") openProject(a.id, a.intoClassic);
    else if (a.kind === "create") createBlank();
    else void submitPrompt(a.text, a.ratio);
  };
  useEffect(() => {
    if (!signedIn || ap.busy || !afterLogin.current) return;
    const a = afterLogin.current;
    afterLogin.current = null;
    runAfter.current(a);
  }, [signedIn, ap.busy]);

  /*
   * Has the first "is the website already signed in?" check finished. Until then the page shows
   * "Connecting" rather than flashing the logged-out page; after it, the business layer being busy (the
   * dialog's own sign-in) must not swap the page out from under the dialog
   */
  const [settled, setSettled] = useState(false);
  useEffect(() => { if (!ap.busy || signedIn) setSettled(true); }, [ap.busy, signedIn]);
  // A project's direct address or a share link opened while logged out: the dialog opens by itself; after login `useAccountProjects` goes on into the project
  const addressAsked = useRef(false);
  useEffect(() => {
    if (addressAsked.current || !settled || signedIn || legacyLogin || ap.shellOld) return;
    addressAsked.current = true;
    if (atProjectAddress()) setLoginOpen(true);
  }, [settled, signedIn, legacyLogin, ap.shellOld]);

  // The page was opened from a share link (the link carries a token): after login, open "Join with link" with the link already filled in
  const linkedOnce = useRef(false);
  useEffect(() => {
    if (linkedOnce.current || !signedIn || !ap.link || openId) return;
    linkedOnce.current = true;
    try { if (new URL(location.href).searchParams.has("token") || /\/s\//.test(location.pathname)) setJoin({ askPassword: false }); } catch { /* If the address can't be read, don't auto-open */ }
  }, [signedIn, ap.link, openId]);
  // Auto-entering a project from a direct URL must first ask for the secondary password
  useEffect(() => {
    if (!ap.directSecondary) return;
    setJoin({ askPassword: true });
    ap.clearDirectSecondary();
  }, [ap.directSecondary]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- Sidebar changes ---------------- */
  const writeProjects = (f: (list: VibeProject[]) => VibeProject[]) => setOrg((o) => withProjects(o, f(mergeProjects(o, entries, seen))));
  const writeGroups = (f: (list: VibeGroup[]) => VibeGroup[]) => setOrg((o) => withGroups(o, f(groupsOf(o))));
  const writeChats = (f: (list: VibeChat[]) => VibeChat[]) => { if (openId) setOrg((o) => withChats(o, openId, f(mergeChats(o, openId, vibe.chats)))); };
  /**
   * This chat belongs to **another** project (in the branch of the sidebar that is expanded but not opened, issue
   * #15). Such a chat can only be clicked into: deleting a chat goes through the Agent service of the currently
   * connected project, and pins and archive are written under `openId`:
   * doing them here would land on the wrong project, so they are all blocked, with an explanation in the menu
   */
  const chatElsewhere = (id: string) => {
    const c = chats.find((x) => x.id === id);
    return c && c.projectId !== openId ? c : null;
  };
  const archivedNow = (kind: "group" | "project" | "chat", id: string) =>
    kind === "group" ? !!groups.find((g) => g.id === id)?.archived : kind === "project" ? !!projects.find((p) => p.id === id)?.archived : !!chats.find((c) => c.id === id)?.archived;

  const ops: TreeOps = {
    rename: (kind, id, name) => {
      if (kind === "group") writeGroups((a) => rename(a, id, name));
    },
    pin: (kind, id) => {
      if (guestBlocked()) return;
      if (kind === "chat" && chatElsewhere(id)) return;
      if (kind === "group") writeGroups((a) => togglePin(a, id));
      else if (kind === "project") writeProjects((a) => togglePin(a, id));
      else writeChats((a) => togglePin(a, id));
      setNotice(tr("Pinning only applies among its siblings, {0}.", orgWhereText("cloud", orgInCloud)));
    },
    archive: (kind, id) => {
      if (guestBlocked()) return;
      if (kind === "chat" && chatElsewhere(id)) return;
      const next = !archivedNow(kind, id);
      if (kind === "group") writeGroups((a) => setArchived(a, id, next));
      else if (kind === "project") writeProjects((a) => setArchived(a, id, next));
      else writeChats((a) => setArchived(a, id, next));
      setNotice(next ? tr("Archived: moved to \"Archived\" at the bottom of the sidebar, where you can right-click to unarchive. {0}, and the project itself is unaffected.", orgWhereText("cloud", orgInCloud)) : tr("Unarchived."));
    },
    remove: (kind, id) => {
      if (kind === "group") {
        const g = groups.find((x) => x.id === id);
        if (g && confirm(tr("Delete group \"{0}\"? Its projects will go back to \"Projects\" and are not deleted.", g.name))) writeGroups((a) => removeById(a, id));
        return;
      }
      if (kind === "chat") {
        const c = chats.find((x) => x.id === id);
        if (!c || c.fresh || c.projectId !== openId) return;
        if (!confirm(tr("Delete chat \"{0}\"? This can't be undone.{1}", c.name, c.state === "running" ? tr(" A task is still running in this chat and will be stopped first; changes already applied are kept.") : ""))) return;
        void vibe.chat.removeChat(id, crypto.randomUUID()).then(
          () => setNotice(tr("Deleted chat \"{0}\".", c.name)),
          (e) => setNotice(failText(e, tr("Failed to delete the chat. You can try again."))),
        );
      }
    },
    reorder: (kind, dragId, overId, place) => {
      if (guestBlocked()) return;
      if (kind === "chat" && (chatElsewhere(dragId) || chatElsewhere(overId))) return;
      if (kind === "group") writeGroups((a) => reorder(a, () => "group", dragId, overId, place));
      else if (kind === "project") writeProjects((a) => reorder(a, projectSib, dragId, overId, place));
      else writeChats((a) => reorder(a, chatSib, dragId, overId, place));
    },
    move: (projectId, groupId) => {
      if (guestBlocked()) return;
      const project = projects.find((x) => x.id === projectId);
      if (!project) return;
      // Only the same set is allowed (cloud projects with cloud groups): organization data across sets is left alone, and the user gets an explanation
      const out = moveProject(withProjects(org, projects), project, groupId);
      if (out.refused) { setNotice(out.refused); return; }
      setOrg(() => out.org);
    },
    blocked: (kind, id) => {
      if (kind === "group") return {};
      if (kind === "project") return { rename: tr("This version can't rename cloud projects here yet."), remove: tr("This version can't delete cloud projects here.") };
      const c = chats.find((x) => x.id === id);
      // A chat under another project: it can only be clicked into (clicking opens that project); organizing and deleting both require opening it first
      if (chatElsewhere(id)) {
        const why = tr("Open this project first to organize or delete its chats.");
        return { rename: why, remove: why, pin: why, archive: why };
      }
      return {
        rename: tr("This version has no way to rename cloud chats."),
        remove: c?.fresh ? tr("A new chat with no messages sent doesn't need deleting.") : undefined,
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

  const listNotice = !signedIn
    ? <>{tr("Not signed in: after you sign in to an account or enter as a guest, your cloud projects are listed here.")}<button type="button" className="ps-link" data-pc="start-go-login" onClick={() => (legacyLogin ? setSkipped(false) : askLogin())}>{tr("Sign in")}</button></>
    : ap.guest ? (ap.guestProject ? null : tr("A guest can create 1 project, which will be listed here once created."))
    : ap.listError ? <>{ap.listError}<button type="button" className="ps-link" data-pc="start-list-retry" disabled={ap.busy} onClick={() => void ap.refreshLists()}>{tr("Retry")}</button></>
    : !ap.lists ? tr("Loading project list…")
    : ap.lists.owned.length + ap.lists.joined.length === 0 ? tr("You have no cloud projects yet: say something in the middle, or click \"New project\".")
    : null;
  const railEmpty = !signedIn ? tr("After you sign in, your recent cloud projects show up here.")
    : ap.listError ? tr("Can't load the project list right now: {0}", ap.listError)
    : !ap.lists && !ap.guest ? tr("Loading project list…")
    : undefined;

  /* ---------------- Before the start page: still checking the website login; the archived login page ---------------- */
  const restoring = !settled && ap.busy && !signedIn && !ap.error && !skipped;
  if (!signedIn && !skipped) {
    if (restoring) {
      // Just opened the page: first check whether the website is already logged in (login is shared with the website), and don't flash the login page before that is answered
      return (
        <div className="ps-vibe-loading" data-pc="start-restoring" role="status">
          <span className="ps-muted">{tr("Connecting to the account service…")}</span>
        </div>
      );
    }
    if (ap.shellOld) return <div className="ps-vibe-loading" role="alert"><span>{ap.error || tr("Account sign-in is temporarily unavailable.")}</span></div>;
    if (legacyLogin) return <VibeLogin busy={ap.busy} error={ap.error} onIntent={onIntent} />;
  }

  const accountName = ap.account?.name ?? ap.guest?.name ?? null;
  const errorLine = ap.error || notice;

  return (
    <div className="ps" data-pc="start-online" data-signed-in={signedIn || undefined} data-guest={ap.guest ? "1" : undefined}>
      <TopBar
        atHome={!openChat}
        onHome={() => {
          setChatPage(false);
          setJoin(null);
          showHomeAddress();
          // The "All projects" block got archived; this home icon is how to return to "All" (see SHOW_SCOPE_ROWS in ProjectSidebar.tsx)
          setScope({ kind: "all" });
        }}
        collapsed={collapsed}
        onToggleSide={() => {
          // Logged out there is nothing to list: expanding asks to sign in instead (issue #2)
          if (!signedIn && collapsed) { askLogin(); return; }
          // The user moved it themselves: do not auto-expand it for them again during this page open (the issue #11 rule pops only once)
          sideAuto.current = true;
          setCollapsed((v) => {
            writeSideCollapsed(!v);
            return !v;
          });
        }}
        accountName={accountName}
        onSignOut={signedIn ? signOut : undefined}
        onSignIn={signedIn ? undefined : () => askLogin()}
        center={
          openChat ? (
            <div className="ps-top-title">
              <span className="ps-top-name" data-pc="start-chat-name">{openChat.name}</span>
              <span className="ps-top-where">{tr("Project \"{0}\"", projects.find((p) => p.id === openChat.projectId)?.name ?? shared?.name ?? "")}</span>
            </div>
          ) : null
        }
        right={
          openChat ? (
            <>
              <button
                type="button"
                className="ps-ghost-btn"
                data-pc="start-copy-link"
                title={tr("Send this project's link to another signed-in member")}
                onClick={copyProjectLink}
              >
                {tr("Copy project link")}
              </button>
              <button
                type="button"
                className="ps-chat-vis"
                data-pc="start-chat-visibility"
                aria-pressed={openChat.visibility === "private"}
                disabled={!vibe.canSwitchVisibility}
                title={vibe.canSwitchVisibility ? tr("Only the person who started this chat can switch it between shared and private") : openChat.fresh ? tr("New chats are shared by default; you can make one private after sending the first message") : tr("Only the person who started this chat can switch it between shared and private")}
                onClick={() => void vibe.toggleVisibility()}
              >
                {openChat.visibility === "private" ? tr("private") : tr("shared")}
              </button>
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
            </>
          ) : (
            <>
              <button type="button" className="ps-ghost-btn" data-pc="start-join-open" onClick={() => setJoin((j) => (j ? null : { askPassword: false }))}>
                {tr("Join a project with a link")}
              </button>
              <a className="ps-ghost-btn" href={typeof location !== "undefined" ? `${location.origin}/account` : "#"} target="_blank" rel="noopener noreferrer">
                {tr("Website account and project list")}
              </a>
              <a className="ps-ghost-btn" href={typeof location !== "undefined" ? `${location.origin}/` : "#"} target="_blank" rel="noopener noreferrer" title={tr("Download the desktop app from the website")}>
                {tr("Download the desktop app")}
              </a>
            </>
          )
        }
      />

      {loginOpen && (
        <LoginDialog
          signedIn={signedIn}
          busy={ap.busy}
          error={ap.error}
          clearError={() => ap.setError("")}
          onClose={() => {
            setLoginOpen(false);
            // Closed without signing in: forget what they tried; signed in: the effect above carries it on
            if (!signedInRef.current) afterLogin.current = null;
          }}
          onLogin={(name, password, remember, link) => onIntent({ kind: "login", name, password, remember, link })}
          onGuest={(link) => onIntent({ kind: "guest", link })}
          onAdopt={(link) => {
            if (link) ap.setLink(link);
            return ap.perform(async () => {
              await ap.adoptSession();
              if (link) setJoin({ askPassword: false });
            });
          }}
        />
      )}

      {/* While connected to a project: the sync overlays (bubble on entering a project, blocking dialogs such as being removed, offline unsent notices), the same set the editor mounts */}
      {openId && <SyncOverlays />}

      {join && (
        <JoinPanel
          ap={ap}
          askPassword={join.askPassword}
          onClose={() => setJoin(null)}
          onJoined={() => setJoin(null)}
        />
      )}

      <div className="ps-body-row">
        <ProjectSidebar
          groups={groups}
          projects={projects}
          chats={chats}
          connectedId={openId && connectedId === openId ? openId : null}
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
          browse={{
            open: (projectId) => browse.load(projectId),
            note: (projectId) => {
              const entry = browsed[projectId];
              if (!entry?.note) return null;
              return { text: entry.note, ...(entry.retry ? { retry: () => browse.load(projectId, { force: true }) } : {}) };
            },
          }}
          onOpenChat={(chat) => {
            // A chat under another project (sidebar expanded, branch not opened): first open that project, then enter this chat once connected
            if (chat.projectId !== openId || connectedId !== openId) {
              setWantChat({ projectId: chat.projectId, chatId: chat.id });
              openProject(chat.projectId);
              return;
            }
            if (chat.id !== vibe.chat.conversationId) vibe.chat.openChat(chat.id);
            setChatPage(true);
          }}
          newChatBlocked={(projectId) => (projectId === openId && vibe.chat.history.guest && vibe.chat.history.atLimit ? GUEST_CHAT_LIMIT_TEXT : null)}
          onNewChat={(projectId) => {
            if (projectId !== openId) { openProject(projectId); return; }
            // A guest can open only one chat per project (user decision, 2026-10-23): explain why and how to open more; the server also has `guest-chat-limit` as a fallback
            if (vibe.chat.history.guest && vibe.chat.history.atLimit) { setNotice(GUEST_CHAT_LIMIT_TEXT); return; }
            if (vibe.chat.history.atLimit) { setNotice(tr("You already have {0} cloud chats in this project, and the limit is reached. Delete a few and try again.", vibe.chat.history.ownedCount)); return; }
            vibe.chat.newChat();
            setChatPage(true);
          }}
          groupNote={groupNoteText("cloud", orgInCloud)}
          groupStatus={orgSyncNote}
          newGroupBlocked={ap.guest ? GUEST_ORG_TEXT : null}
          onNewGroup={() => {
            if (guestBlocked()) return;
            const name = prompt(tr("What should the new group be called? ({0})", groupNoteText("cloud", orgInCloud)), tr("New group"));
            if (name === null) return;
            setOrg((o) => addGroup(o, name).org);
          }}
          onCreate={createBlank}
          createBlocked={createBlocked}
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
            onPro={props.onEnterEditor}
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
                <span className="ps-hero-kicker">{tr("Powered by PromptCut's Agent")}</span>
                <h1 className="ps-hero-title">{tr("Say one sentence, get a video first")}</h1>
                <span className="ps-hero-sub">{tr("Write a topic or paste in a script, the Agent builds the project and arranges the cards, and then you carry on editing.")}</span>
              </div>

              <PromptBox
                onSubmit={(text, ratio) => void submitPrompt(text, ratio)}
                onUpload={() => {
                  if (createBlocked) { setNotice(createBlocked); return; }
                  fileInput.current?.click();
                }}
                fileCount={files.length}
                disabled={createBlocked}
                busy={creating || ap.busy}
              />
              <input ref={fileInput} type="file" multiple accept={MEDIA_ACCEPT} hidden data-pc="start-prompt-files"
                onChange={(e) => {
                  const list = e.target.files ? [...e.target.files] : [];
                  e.target.value = "";
                  if (list.length) { setFiles((f) => [...f, ...list]); setNotice(tr("{0} media selected, they will be put into the new project together when this message is sent.", files.length + list.length)); }
                }} />
              <p className={`ps-prompt-note${ap.error ? " is-err" : ""}`} role={ap.error ? "alert" : "status"} data-pc="start-notice">
                {errorLine || (ap.guest ? GUEST_LIMITS_TEXT : openId && !chatPage ? tr("The project is still open: click the chat under it on the left to pick up where you left off.") : tr("Right-click a row to pin it, archive it, or move it to a cloud group ({0}). Hold and drag to reorder, and drag the edge on the right of the sidebar to resize it.", orgWhereText("cloud", orgInCloud)))}
              </p>

              <ProjectRail
                title={railTitle}
                projects={shown}
                resetKey={scopeKeyOf(scope)}
                onCreate={createBlank}
                createDisabled={createBlocked}
                onOpen={(id) => openProject(id, true)}
                empty={railEmpty}
              />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
