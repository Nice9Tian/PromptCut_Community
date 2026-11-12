/**
 * Desktop New Project & Personal Project Conversion Modal (Issue #7).
 *
 * Primary options when creating a project on Desktop:
 *   1. "Local project" (personal local draft, no extra account management)
 *   2. "Cloud project" (personal online project via desktop AccountCloud or hosted online room)
 *   3. "More":
 *      - "Render server" -> opens the live RenderServerPanel (add joined projects or invite links)
 *      - "Team project"  -> member account management + LAN / WAN project discovery
 *
 * Also supports converting an existing personal local project (`existingDraft`) directly via
 * "Switch to online project" (`initialView="cloud"`) or "Convert to team project" (`initialView="team"`).
 */
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { setActiveDraftId } from "../editor/io/drafts";
import { newProject } from "../editor/io/proc";
import type { Account } from "../editor/sync/accountExtensions";
import {
  accountCloud,
  accountCloudLogin,
  accountCloudSignIn,
  moveCurrentToAccountCloud,
  type AccountCloud,
} from "../editor/sync/accountMoveFlow";
import { defaultCreatorName, enableCollab, generatePassword } from "../editor/sync/collab";
import { markProjectAsLocalDataServer } from "../editor/sync/dataServerHandover";
import { RenderServerPanel } from "../editor/sync/RenderServerPanel";
import { client, hosted, type Candidate, type SharedMode } from "../editor/sync/sharedApi";
import { readHostedUrl, writeHostedUrl } from "../editor/sync/SharedDialogs";
import { enterShared, getSyncView } from "../editor/sync/syncManager";
import { tr } from "../i18n/index.ts";
import { hostedDocBaseOf, hostedWsUrlOf } from "../online/invite";
import { actions } from "../store/project";
import { useBackdropClose } from "../ui/backdropClose";
import { RATIO_SIZE } from "./format";
import type { Ratio } from "./types";
import "./NewProjectDialog.css";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export type NewProjectInitialView = "local" | "cloud" | "more" | "render-server" | "team";

export interface ExistingDraftTarget {
  id: string;
  name: string;
}

export interface NewProjectDialogProps {
  open: boolean;
  initialView?: NewProjectInitialView;
  existingDraft?: ExistingDraftTarget | null;
  onClose: () => void;
  onCreateLocal: (opts: { name: string; ratio: Ratio }) => void | Promise<void>;
  onEnteredShared: () => void;
}

interface TeamMemberDraft {
  username: string;
  password: string;
  access: "rw" | "r";
}

interface DiscoveredTeamRoom {
  key: string;
  where: "lan" | "hosted";
  base: string;
  ws: string;
  projectId: string;
  name: string;
  mode: SharedMode;
  hostLabel: string;
}

const RATIOS: readonly Ratio[] = ["16:9", "9:16", "1:1"];

async function scanLanProjects(filterName = ""): Promise<{
  lanHost: boolean;
  rooms: DiscoveredTeamRoom[];
}> {
  if (ONLINE_BUILD) return { lanHost: false, rooms: [] };
  try {
    const qs = new URLSearchParams({ timeoutMs: "900" });
    if (filterName.trim()) qs.set("name", filterName.trim());
    const r = await fetch(`/api/lan/discover?${qs.toString()}`, { cache: "no-store" });
    if (!r.ok) return { lanHost: false, rooms: [] };
    const j = (await r.json()) as {
      lanHost?: boolean;
      localProjects?: Array<{ projectId: string; name: string; mode?: string; hostDeviceName?: string; base: string }>;
      hosts?: Array<{
        address: string;
        port: number;
        hostDeviceName?: string;
        projects?: Array<{ projectId: string; name: string; mode?: string }>;
      }>;
    };
    const seen = new Set<string>();
    const rooms: DiscoveredTeamRoom[] = [];
    for (const lp of j.localProjects ?? []) {
      const ws = lp.base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:").replace(/\/+$/, "");
      seen.add(lp.projectId);
      rooms.push({
        key: `local:${lp.projectId}`,
        where: "lan",
        base: lp.base,
        ws,
        projectId: lp.projectId,
        name: lp.name,
        mode: lp.mode === "free" ? "free" : "restricted",
        hostLabel: `${lp.hostDeviceName || tr("This machine")} (LAN)`,
      });
    }
    for (const h of j.hosts ?? []) {
      const base = `http://${h.address}:${h.port}/docservice`;
      const ws = `ws://${h.address}:${h.port}/docservice`;
      for (const p of h.projects ?? []) {
        if (seen.has(p.projectId)) continue;
        seen.add(p.projectId);
        rooms.push({
          key: `lan:${h.address}:${h.port}:${p.projectId}`,
          where: "lan",
          base,
          ws,
          projectId: p.projectId,
          name: p.name,
          mode: p.mode === "free" ? "free" : "restricted",
          hostLabel: `${h.hostDeviceName || `${h.address}:${h.port}`} (LAN)`,
        });
      }
    }
    return { lanHost: Boolean(j.lanHost), rooms };
  } catch {
    return { lanHost: false, rooms: [] };
  }
}

async function applyReadOnlyMembersOnLocalHost(projectId: string, readonlyMembers: TeamMemberDraft[]): Promise<void> {
  if (ONLINE_BUILD || readonlyMembers.length === 0) return;
  for (const m of readonlyMembers) {
    await fetch("/api/data-server/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        action: "add-member",
        username: m.username,
        password: m.password,
        access: "r",
      }),
    }).catch(() => {});
  }
}

export function NewProjectDialog(props: NewProjectDialogProps): JSX.Element | null {
  const { open, initialView = "local", existingDraft = null, onClose, onCreateLocal, onEnteredShared } = props;

  const [primaryTab, setPrimaryTab] = useState<"local" | "cloud" | "more">("local");
  const [moreSubView, setMoreSubView] = useState<"menu" | "render-server" | "team">("menu");
  const [teamTab, setTeamTab] = useState<"create" | "discover">("create");

  const [name, setName] = useState("");
  const [ratio, setRatio] = useState<Ratio>("16:9");

  // Cloud project state
  const [acctCloud, setAcctCloud] = useState<AccountCloud | null>(null);
  const [acctUser, setAcctUser] = useState<Account | null>(null);
  const [acctChecked, setAcctChecked] = useState(false);
  const [acctLoginUser, setAcctLoginUser] = useState("");
  const [acctLoginPw, setAcctLoginPw] = useState("");
  const [cloudHostedUrl, setCloudHostedUrl] = useState(() => readHostedUrl());
  const [useHostedFallback, setUseHostedFallback] = useState(false);

  // Team project creation state
  const [teamWhere, setTeamWhere] = useState<"lan" | "hosted">("lan");
  const [teamHostedUrl, setTeamHostedUrl] = useState(() => readHostedUrl());
  const [creatorUser, setCreatorUser] = useState("");
  const [creatorPw, setCreatorPw] = useState(() => generatePassword(12));
  const [members, setMembers] = useState<TeamMemberDraft[]>([]);
  const [draftMemUser, setDraftMemUser] = useState("");
  const [draftMemPw, setDraftMemPw] = useState("");
  const [draftMemAccess, setDraftMemAccess] = useState<"rw" | "r">("rw");

  // Team LAN / WAN discovery state
  const [scanningLan, setScanningLan] = useState(false);
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredTeamRoom[]>([]);
  const [wanQueryName, setWanQueryName] = useState("");
  const [wanUrl, setWanUrl] = useState(() => readHostedUrl());
  const [selectedRoom, setSelectedRoom] = useState<DiscoveredTeamRoom | null>(null);
  const [joinUser, setJoinUser] = useState("");
  const [joinPw, setJoinPw] = useState("");
  const [joinAsCreator, setJoinAsCreator] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setBusy(false);
    setName(existingDraft ? existingDraft.name : "");
    setRatio("16:9");
    if (existingDraft) {
      if (initialView === "team") {
        setPrimaryTab("more");
        setMoreSubView("team");
        setTeamTab("create");
      } else {
        setPrimaryTab("cloud");
        setMoreSubView("menu");
      }
    } else if (initialView === "cloud") {
      setPrimaryTab("cloud");
      setMoreSubView("menu");
    } else if (initialView === "more") {
      setPrimaryTab("more");
      setMoreSubView("menu");
    } else if (initialView === "render-server") {
      setPrimaryTab("more");
      setMoreSubView("render-server");
    } else if (initialView === "team") {
      setPrimaryTab("more");
      setMoreSubView("team");
      setTeamTab("create");
    } else {
      setPrimaryTab("local");
      setMoreSubView("menu");
    }

    void defaultCreatorName().then((n) => {
      setCreatorUser((cur) => cur || n);
    });

    setAcctChecked(false);
    void accountCloud()
      .then(async (c) => {
        setAcctCloud(c);
        if (c) {
          const u = await accountCloudLogin(c).catch(() => null);
          setAcctUser(u);
        } else {
          setAcctUser(null);
        }
      })
      .finally(() => setAcctChecked(true));
  }, [open, initialView, existingDraft]);

  const runLanScan = useCallback(async () => {
    setScanningLan(true);
    setError("");
    const res = await scanLanProjects();
    setDiscoveredRooms(res.rooms);
    if (res.rooms.length > 0 && !selectedRoom) {
      setSelectedRoom(res.rooms[0]);
    }
    setScanningLan(false);
  }, [selectedRoom]);

  useEffect(() => {
    if (open && primaryTab === "more" && moreSubView === "team" && teamTab === "discover") {
      void runLanScan();
    }
  }, [open, primaryTab, moreSubView, teamTab, runLanScan]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const backdrop = useBackdropClose(() => {
    if (!busy) onClose();
  });

  if (!open) return null;

  const cleanProjectName = (name.trim() || existingDraft?.name || tr("Untitled")).trim() || tr("Untitled");

  const prepareFreshStoreProject = () => {
    if (existingDraft) {
      actions.setProjectMeta({ name: cleanProjectName });
      return;
    }
    newProject(cleanProjectName);
    if (ratio !== "16:9") {
      actions.setProjectMeta({ ...RATIO_SIZE[ratio] });
    }
    setActiveDraftId(null);
  };

  const handleConfirmLocal = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreateLocal({ name: cleanProjectName, ratio });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("Could not create local project."));
    } finally {
      setBusy(false);
    }
  };

  const handleAccountSignIn = async () => {
    if (!acctCloud || !acctLoginUser.trim() || !acctLoginPw) {
      setError(tr("Enter your cloud account username and password."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const user = await accountCloudSignIn(acctCloud, acctLoginUser.trim(), acctLoginPw);
      setAcctUser(user);
      setAcctLoginPw("");
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("Sign-in failed. Check your account credentials."));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmCloud = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      prepareFreshStoreProject();
      if (acctCloud && !useHostedFallback) {
        if (!acctUser) {
          setError(tr("Sign in to your cloud account first, or choose a custom online server."));
          return;
        }
        const moved = await moveCurrentToAccountCloud(acctCloud, { name: cleanProjectName });
        if (!moved.ok) {
          setError(tr("Could not create cloud project ({0}).", moved.error));
          return;
        }
        onClose();
        onEnteredShared();
        return;
      }

      const resolvedUrl = hosted.resolveHostedUrl({ ui: cloudHostedUrl });
      writeHostedUrl(cloudHostedUrl);
      const cName = creatorUser.trim() || (await defaultCreatorName());
      const cPw = generatePassword(16);
      const pPw = generatePassword(16);
      const res = await enableCollab({
        where: "hosted",
        mode: "free",
        name: cleanProjectName,
        creator: { username: cName, password: cPw },
        projectPassword: pPw,
        hostedUrl: resolvedUrl,
      });
      if (!res.ok) {
        setError(
          res.error === "name-taken"
            ? tr("A project named \"{0}\" already exists on that online server.", cleanProjectName)
            : tr("Could not reach the online server ({0}). Verify the server URL or start a hosted service.", res.error),
        );
        return;
      }
      setActiveDraftId(null);
      onClose();
      onEnteredShared();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("Could not create cloud project."));
    } finally {
      setBusy(false);
    }
  };

  const handleAddMemberRow = () => {
    const u = draftMemUser.trim();
    if (!u) {
      setError(tr("Enter a member username."));
      return;
    }
    if (u === creatorUser.trim()) {
      setError(tr("Member username must differ from the creator username."));
      return;
    }
    const pw = draftMemPw || generatePassword(12);
    setError("");
    setMembers((prev) => {
      const filtered = prev.filter((m) => m.username !== u);
      return [...filtered, { username: u, password: pw, access: draftMemAccess }];
    });
    setDraftMemUser("");
    setDraftMemPw("");
  };

  const handleConfirmTeamCreate = async () => {
    if (busy) return;
    const cUser = creatorUser.trim();
    if (!cUser || !creatorPw) {
      setError(tr("Enter a creator account username and password."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      prepareFreshStoreProject();
      const pendingUser = draftMemUser.trim();
      const effectiveMembers = pendingUser && pendingUser !== cUser
        ? [...members.filter((m) => m.username !== pendingUser), { username: pendingUser, password: draftMemPw || generatePassword(12), access: draftMemAccess }]
        : members;

      let resolvedHosted: string | null = null;
      if (teamWhere === "hosted") {
        resolvedHosted = hosted.resolveHostedUrl({ ui: teamHostedUrl });
        writeHostedUrl(teamHostedUrl);
      }

      const res = await enableCollab({
        where: teamWhere,
        mode: "restricted",
        name: cleanProjectName,
        creator: { username: cUser, password: creatorPw },
        list: effectiveMembers.map((m) => ({
          username: m.username,
          password: m.password,
          ...(m.access === "r" ? { access: "r" as const } : {}),
        })),
        hostedUrl: resolvedHosted,
      });
      if (!res.ok) {
        setError(
          res.error === "name-taken"
            ? tr("A team project named \"{0}\" already exists. Choose a different name.", cleanProjectName)
            : tr("Could not create team project ({0}).", res.error),
        );
        return;
      }
      const createdId = getSyncView().shared?.projectId;
      if (createdId && teamWhere === "lan") {
        markProjectAsLocalDataServer(createdId);
        const roList = effectiveMembers.filter((m) => m.access === "r");
        if (roList.length > 0) {
          await applyReadOnlyMembersOnLocalHost(createdId, roList);
        }
      }
      setActiveDraftId(null);
      onClose();
      onEnteredShared();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("Could not create team project."));
    } finally {
      setBusy(false);
    }
  };

  const handleSearchWan = async () => {
    if (!wanQueryName.trim()) {
      setError(tr("Enter the team project name to search on WAN."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const origin = hosted.resolveHostedUrl({ ui: wanUrl });
      writeHostedUrl(wanUrl);
      let base = hostedDocBaseOf(origin);
      let where: "hosted" | "lan" = "hosted";
      let found: Awaited<ReturnType<typeof client.lookupProject>>;
      try {
        found = await client.lookupProject({ base, name: wanQueryName.trim() });
      } catch {
        const directBase = `${origin.replace(/\/+$/, "")}/docservice`;
        found = await client.lookupProject({ base: directBase, name: wanQueryName.trim() });
        base = directBase;
        where = "lan";
      }
      const room: DiscoveredTeamRoom = {
        key: `wan:${base}:${found.projectId}`,
        where,
        base,
        ws: hostedWsUrlOf(base),
        projectId: found.projectId,
        name: found.name,
        mode: found.mode,
        hostLabel: `${new URL(base).host} (${where === "lan" ? "LAN" : "WAN"})`,
      };
      setDiscoveredRooms((prev) => [room, ...prev.filter((x) => x.key !== room.key)]);
      setSelectedRoom(room);
    } catch {
      setError(tr("Project not found on WAN server, or server unreachable."));
    } finally {
      setBusy(false);
    }
  };

  const handleJoinDiscovered = async () => {
    if (!selectedRoom) {
      setError(tr("Select a discovered LAN or WAN team project first."));
      return;
    }
    if (!joinUser.trim() || !joinPw) {
      setError(tr("Enter your member account username and password."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      newProject(tr("Untitled"));
      const candidate: Candidate = {
        where: selectedRoom.where,
        base: selectedRoom.base,
        ws: selectedRoom.ws,
        projectId: selectedRoom.projectId,
        name: selectedRoom.name,
        mode: selectedRoom.mode,
      };
      const entered = await enterShared(candidate, {
        as: joinAsCreator ? "creator" : "member",
        username: joinUser.trim(),
        password: joinPw,
      });
      if (!entered.ok) {
        setError(tr("Could not join \"{0}\" ({1}). Check your account credentials.", selectedRoom.name, entered.error));
        return;
      }
      setActiveDraftId(null);
      onClose();
      onEnteredShared();
    } finally {
      setBusy(false);
    }
  };

  const isRenderServerView = primaryTab === "more" && moreSubView === "render-server";
  const isTeamView = primaryTab === "more" && moreSubView === "team";
  const dialogTitle = existingDraft
    ? (isTeamView ? tr("Convert \"{0}\" to team project", existingDraft.name) : tr("Switch \"{0}\" to online project", existingDraft.name))
    : tr("New project");

  const showProjectMetaInputs = !existingDraft && (primaryTab === "local" || primaryTab === "cloud" || (isTeamView && teamTab === "create"));

  return createPortal(
    <div className="npd-mask" {...backdrop}>
      <div
        className={`npd-dialog${isRenderServerView ? " is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="npd-dialog-title"
        data-pc="new-project-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="npd-head">
          <h2 id="npd-dialog-title" className="npd-title">{dialogTitle}</h2>
          <button type="button" className="npd-close" aria-label={tr("Close")} disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="npd-body">
          {!existingDraft && !isRenderServerView && (
            <div className="npd-choices" role="tablist" aria-label={tr("Project type")}>
              <button
                type="button"
                role="tab"
                aria-selected={primaryTab === "local"}
                className={`npd-choice${primaryTab === "local" ? " is-on" : ""}`}
                data-pc="new-project-choice-local"
                onClick={() => { setPrimaryTab("local"); setMoreSubView("menu"); setError(""); }}
              >
                <span className="npd-choice-title">{tr("Local project")}</span>
                <span className="npd-choice-sub">{tr("Personal draft, no account needed")}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={primaryTab === "cloud"}
                className={`npd-choice${primaryTab === "cloud" ? " is-on" : ""}`}
                data-pc="new-project-choice-cloud"
                onClick={() => { setPrimaryTab("cloud"); setMoreSubView("menu"); setError(""); }}
              >
                <span className="npd-choice-title">{tr("Cloud project")}</span>
                <span className="npd-choice-sub">{tr("Personal online workspace")}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={primaryTab === "more"}
                className={`npd-choice${primaryTab === "more" ? " is-on" : ""}`}
                data-pc="new-project-choice-more"
                onClick={() => { setPrimaryTab("more"); setMoreSubView("menu"); setError(""); }}
              >
                <span className="npd-choice-title">{tr("More")}</span>
                <span className="npd-choice-sub">{tr("Render server & team project")}</span>
              </button>
            </div>
          )}

          {showProjectMetaInputs && (
            <div className="npd-meta-grid">
              <div className="npd-field">
                <label htmlFor="npd-project-name">{tr("Project name")}</label>
                <input
                  id="npd-project-name"
                  className="pc-dialog-input"
                  data-pc="new-project-name"
                  value={name}
                  maxLength={80}
                  placeholder={tr("Untitled")}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && primaryTab === "local") void handleConfirmLocal();
                  }}
                />
              </div>
              <div className="npd-field">
                <span className="npd-label">{tr("Aspect ratio")}</span>
                <div className="npd-ratios">
                  {RATIOS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`npd-ratio-btn${ratio === r ? " is-on" : ""}`}
                      data-pc={`new-project-ratio-${r}`}
                      onClick={() => setRatio(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {existingDraft && (
            <div className="npd-field">
              <label htmlFor="npd-convert-name">{tr("Project name")}</label>
              <input
                id="npd-convert-name"
                className="pc-dialog-input"
                data-pc="new-project-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          {primaryTab === "local" && !existingDraft && (
            <div className="npd-card" data-pc="new-project-local-view">
              <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                {tr("Creates a personal project stored on this computer with zero account setup.")}
              </div>
              <div className="pc-sync-hint">
                {tr("You can switch any personal project to an online project or convert it into a team project later from project management.")}
              </div>
            </div>
          )}

          {primaryTab === "cloud" && (
            <div className="npd-card" data-pc="new-project-cloud-view">
              {!acctChecked ? (
                <div className="pc-sync-hint">{tr("Checking cloud account configuration…")}</div>
              ) : acctCloud && !useHostedFallback ? (
                acctUser ? (
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    {tr("Signed in as \"{0}\". The project will be synced to your personal cloud workspace ({1}).", acctUser.name, acctCloud.origin)}
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13 }}>
                      {tr("Sign in to your cloud account to create an online project:")}
                    </div>
                    <div className="npd-row">
                      <div className="npd-field" style={{ flex: "1 1 160px" }}>
                        <label htmlFor="npd-acct-user">{tr("Account")}</label>
                        <input
                          id="npd-acct-user"
                          className="pc-dialog-input"
                          data-pc="new-project-cloud-user"
                          value={acctLoginUser}
                          onChange={(e) => setAcctLoginUser(e.target.value)}
                        />
                      </div>
                      <div className="npd-field" style={{ flex: "1 1 160px" }}>
                        <label htmlFor="npd-acct-pw">{tr("Password")}</label>
                        <input
                          id="npd-acct-pw"
                          type="password"
                          className="pc-dialog-input"
                          data-pc="new-project-cloud-pw"
                          value={acctLoginPw}
                          onChange={(e) => setAcctLoginPw(e.target.value)}
                        />
                      </div>
                      <button
                        type="button"
                        className="pc-btn pc-btn--primary"
                        data-pc="new-project-cloud-signin"
                        disabled={busy}
                        onClick={() => void handleAccountSignIn()}
                      >
                        {tr("Sign in")}
                      </button>
                    </div>
                    <div>
                      <button type="button" className="pc-sync-link-btn" onClick={() => setUseHostedFallback(true)}>
                        {tr("Use a custom hosted server URL instead")}
                      </button>
                    </div>
                  </>
                )
              ) : (
                <>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    {tr("Host this personal project on an online document service so you can access it across devices.")}
                  </div>
                  <div className="npd-field">
                    <label htmlFor="npd-cloud-url">{tr("Online service URL")}</label>
                    <input
                      id="npd-cloud-url"
                      className="pc-dialog-input"
                      data-pc="new-project-cloud-url"
                      value={cloudHostedUrl}
                      onChange={(e) => setCloudHostedUrl(e.target.value)}
                    />
                  </div>
                  {acctCloud && (
                    <div>
                      <button type="button" className="pc-sync-link-btn" onClick={() => setUseHostedFallback(false)}>
                        {tr("Back to account cloud")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {primaryTab === "more" && moreSubView === "menu" && (
            <div className="npd-more-grid" data-pc="new-project-more-grid">
              <button
                type="button"
                className="npd-more-item"
                data-pc="new-project-more-render-server"
                onClick={() => { setMoreSubView("render-server"); setError(""); }}
              >
                <b>{tr("Render server")}</b>
                <span>
                  {tr("Open the render server data panel: inspect throughput, add already-joined projects, or bind via invite link.")}
                </span>
              </button>
              <button
                type="button"
                className="npd-more-item"
                data-pc="new-project-more-team"
                onClick={() => { setMoreSubView("team"); setTeamTab("create"); setError(""); }}
              >
                <b>{tr("Team project")}</b>
                <span>
                  {tr("Manage member accounts with edit or read-only access, and discover projects across LAN or WAN.")}
                </span>
              </button>
            </div>
          )}

          {isRenderServerView && (
            <RenderServerPanel
              mode="embedded"
              onBack={() => { setMoreSubView("menu"); setError(""); }}
            />
          )}

          {isTeamView && (
            <div className="npd-card" data-pc="new-project-team-view">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div className="pc-srv-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={teamTab === "create"}
                    className={`pc-srv-tab${teamTab === "create" ? " is-on" : ""}`}
                    data-pc="team-tab-create"
                    onClick={() => { setTeamTab("create"); setError(""); }}
                  >
                    {existingDraft ? tr("Convert project") : tr("Create team project")}
                  </button>
                  {!existingDraft && (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={teamTab === "discover"}
                      className={`pc-srv-tab${teamTab === "discover" ? " is-on" : ""}`}
                      data-pc="team-tab-discover"
                      onClick={() => { setTeamTab("discover"); setError(""); }}
                    >
                      {tr("LAN / WAN discovery")}
                    </button>
                  )}
                </div>
                {!existingDraft && (
                  <button
                    type="button"
                    className="pc-sync-link-btn"
                    data-pc="team-back-more"
                    onClick={() => { setMoreSubView("menu"); setError(""); }}
                  >
                    {tr("Back to More")}
                  </button>
                )}
              </div>

              {teamTab === "create" ? (
                <>
                  <div className="npd-row">
                    <div className="npd-field" style={{ flex: "1 1 200px" }}>
                      <span className="npd-label">{tr("Network discovery & hosting")}</span>
                      <div className="npd-ratios">
                        <button
                          type="button"
                          className={`npd-ratio-btn${teamWhere === "lan" ? " is-on" : ""}`}
                          data-pc="team-where-lan"
                          onClick={() => setTeamWhere("lan")}
                        >
                          {tr("LAN (this machine)")}
                        </button>
                        <button
                          type="button"
                          className={`npd-ratio-btn${teamWhere === "hosted" ? " is-on" : ""}`}
                          data-pc="team-where-hosted"
                          onClick={() => setTeamWhere("hosted")}
                        >
                          {tr("WAN / Hosted server")}
                        </button>
                      </div>
                    </div>
                    {teamWhere === "hosted" && (
                      <div className="npd-field" style={{ flex: "1.4 1 220px" }}>
                        <label htmlFor="npd-team-url">{tr("WAN server URL")}</label>
                        <input
                          id="npd-team-url"
                          className="pc-dialog-input"
                          data-pc="team-hosted-url"
                          value={teamHostedUrl}
                          onChange={(e) => setTeamHostedUrl(e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  <div className="npd-row">
                    <div className="npd-field" style={{ flex: "1 1 180px" }}>
                      <label htmlFor="npd-creator-user">{tr("Creator account")}</label>
                      <input
                        id="npd-creator-user"
                        className="pc-dialog-input"
                        data-pc="team-creator-username"
                        value={creatorUser}
                        maxLength={64}
                        onChange={(e) => setCreatorUser(e.target.value)}
                      />
                    </div>
                    <div className="npd-field" style={{ flex: "1 1 180px" }}>
                      <label htmlFor="npd-creator-pw">{tr("Creator password")}</label>
                      <input
                        id="npd-creator-pw"
                        type="password"
                        className="pc-dialog-input"
                        data-pc="team-creator-password"
                        value={creatorPw}
                        onChange={(e) => setCreatorPw(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="npd-field" data-pc="team-members-editor">
                    <span className="npd-label">{tr("Member accounts (required for team access)")}</span>
                    <div className="npd-row">
                      <div className="npd-field" style={{ flex: "1 1 140px" }}>
                        <input
                          className="pc-dialog-input"
                          data-pc="team-member-user-input"
                          value={draftMemUser}
                          placeholder={tr("Member username")}
                          maxLength={64}
                          onChange={(e) => setDraftMemUser(e.target.value)}
                        />
                      </div>
                      <div className="npd-field" style={{ flex: "1 1 140px" }}>
                        <input
                          type="password"
                          className="pc-dialog-input"
                          data-pc="team-member-pw-input"
                          value={draftMemPw}
                          placeholder={tr("Password (auto if blank)")}
                          onChange={(e) => setDraftMemPw(e.target.value)}
                        />
                      </div>
                      {teamWhere === "lan" && (
                        <div className="npd-field" style={{ flex: "0 0 116px" }}>
                          <select
                            className="pc-dialog-select"
                            data-pc="team-member-access-select"
                            value={draftMemAccess}
                            onChange={(e) => setDraftMemAccess(e.target.value === "r" ? "r" : "rw")}
                          >
                            <option value="rw">{tr("Can edit")}</option>
                            <option value="r">{tr("Read-only")}</option>
                          </select>
                        </div>
                      )}
                      <button
                        type="button"
                        className="pc-btn"
                        data-pc="team-member-add-btn"
                        onClick={handleAddMemberRow}
                      >
                        {tr("Add account")}
                      </button>
                    </div>

                    {members.length > 0 ? (
                      <div className="npd-member-list" data-pc="team-member-list">
                        {members.map((m) => (
                          <div key={m.username} className="npd-member-chip" data-pc="team-member-chip">
                            <span>
                              <b>{m.username}</b> · {m.access === "r" ? tr("Read-only") : tr("Can edit")}
                            </span>
                            <button
                              type="button"
                              className="pc-sync-link-btn"
                              onClick={() => setMembers((prev) => prev.filter((x) => x.username !== m.username))}
                            >
                              {tr("Remove")}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="pc-sync-hint">
                        {tr("Add team member accounts now, or manage them later from the Data Server panel.")}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="pc-srv-list" data-pc="team-discovery-panel">
                  <div className="npd-row">
                    <button
                      type="button"
                      className="pc-btn"
                      data-pc="team-lan-scan-btn"
                      disabled={scanningLan || busy}
                      onClick={() => void runLanScan()}
                    >
                      {scanningLan ? tr("Scanning LAN…") : tr("Scan LAN")}
                    </button>
                    <div className="npd-field" style={{ flex: "1 1 140px" }}>
                      <input
                        className="pc-dialog-input"
                        data-pc="team-wan-name-input"
                        value={wanQueryName}
                        placeholder={tr("WAN project name")}
                        onChange={(e) => setWanQueryName(e.target.value)}
                      />
                    </div>
                    <div className="npd-field" style={{ flex: "1.2 1 160px" }}>
                      <input
                        className="pc-dialog-input"
                        data-pc="team-wan-url-input"
                        value={wanUrl}
                        placeholder="https://..."
                        onChange={(e) => setWanUrl(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="pc-btn"
                      data-pc="team-wan-search-btn"
                      disabled={busy}
                      onClick={() => void handleSearchWan()}
                    >
                      {tr("Search WAN")}
                    </button>
                  </div>

                  {discoveredRooms.length > 0 ? (
                    <div className="pc-srv-list" data-pc="team-discovered-list">
                      {discoveredRooms.map((rm) => (
                        <button
                          key={rm.key}
                          type="button"
                          className={`pc-sync-choice${selectedRoom?.key === rm.key ? " is-on" : ""}`}
                          data-pc="team-discovered-item"
                          onClick={() => setSelectedRoom(rm)}
                        >
                          <span className="pc-sync-choice-dot" />
                          <span className="pc-sync-choice-text">
                            <b>{rm.name}</b>
                            <small>{rm.hostLabel}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="pc-srv-empty" data-pc="team-discovered-empty">
                      {scanningLan
                        ? tr("Scanning local network for team projects…")
                        : tr("No LAN team projects discovered yet. Click \"Scan LAN\" or search a WAN server by project name.")}
                    </div>
                  )}

                  <div className="npd-row">
                    <div className="npd-field" style={{ flex: "1 1 150px" }}>
                      <label htmlFor="npd-join-user">{tr("Account username")}</label>
                      <input
                        id="npd-join-user"
                        className="pc-dialog-input"
                        data-pc="team-join-username"
                        value={joinUser}
                        onChange={(e) => setJoinUser(e.target.value)}
                      />
                    </div>
                    <div className="npd-field" style={{ flex: "1 1 150px" }}>
                      <label htmlFor="npd-join-pw">{tr("Password")}</label>
                      <input
                        id="npd-join-pw"
                        type="password"
                        className="pc-dialog-input"
                        data-pc="team-join-password"
                        value={joinPw}
                        onChange={(e) => setJoinPw(e.target.value)}
                      />
                    </div>
                  </div>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={joinAsCreator}
                      onChange={(e) => setJoinAsCreator(e.target.checked)}
                    />
                    {tr("Sign in as project creator")}
                  </label>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="pc-srv-msg is-err" data-pc="new-project-error" role="alert">
              {error}
            </div>
          )}
        </div>

        {!isRenderServerView && (
          <div className="npd-foot">
            <div className="npd-foot-right">
              <button type="button" className="pc-btn" data-pc="new-project-cancel" disabled={busy} onClick={onClose}>
                {tr("Cancel")}
              </button>

              {primaryTab === "local" && !existingDraft && (
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  data-pc="new-project-local-confirm"
                  disabled={busy}
                  onClick={() => void handleConfirmLocal()}
                >
                  {busy ? tr("Creating…") : tr("Create local project")}
                </button>
              )}

              {primaryTab === "cloud" && (
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  data-pc="new-project-cloud-confirm"
                  disabled={busy || (Boolean(acctCloud && !useHostedFallback) && !acctUser)}
                  onClick={() => void handleConfirmCloud()}
                >
                  {busy
                    ? tr("Connecting…")
                    : existingDraft
                      ? tr("Switch to online project")
                      : tr("Create cloud project")}
                </button>
              )}

              {isTeamView && teamTab === "create" && (
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  data-pc="new-project-team-confirm"
                  disabled={busy}
                  onClick={() => void handleConfirmTeamCreate()}
                >
                  {busy
                    ? tr("Starting…")
                    : existingDraft
                      ? tr("Convert to team project")
                      : tr("Create team project")}
                </button>
              )}

              {isTeamView && teamTab === "discover" && (
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  data-pc="team-join-submit"
                  disabled={busy || !selectedRoom}
                  onClick={() => void handleJoinDiscovered()}
                >
                  {busy ? tr("Joining…") : tr("Join team project")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
