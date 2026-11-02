import type { QuotaConfig, QuotaInfo } from "../../ai/types";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../../ui/backdropClose";
import { useEffect, useRef, useState } from "react";
import "./AiSetupDialog.css";
import { ApiSharePanel } from "./ApiSharePanel";
import { ReportDialog } from "./ReportDialog";
import { SETUP_ENTRIES, isCliEntry, readFace, writeFace } from "./setupEntries";
import type { SetupEntry, SetupEntryId } from "./setupEntries";
import { redactDebug } from "../../ai/debug";
import { CAPABILITIES } from "../../ai/modelOptions";
import { setViewMode, useViewPrefs } from "./chat/viewPrefs";
import type { ProviderInfo, AiProvider, SttInfo, PublicAiConfig, AiConfigPatch, ApiVendor, CliSetupJob, LoginState, KeyKind } from "../../ai/types";
import { tr } from "../../i18n/index.ts";

/**
 * Pick out the settings that are "non-default and easy to send troubleshooting off course" and put
 * them in plain language at the very top of the diagnostic report.
 *
 * All of these values are in the server's config, but nobody ever digs through it. Text protocol
 * mode especially: once it is on, the model issues tool calls through text blocks in the reply
 * body instead, every tool-related symptom changes, and the switch itself is hidden under "More",
 * so the user may not even remember turning it on.
 */
function notableSettings(cfg: PublicAiConfig | null | undefined, current: AiProvider | null): string[] {
  if (!cfg) return [tr("Could not get the server config (/api/ai/diagnostics returned no config), the content below may be incomplete")];
  const out: string[] = [];
  if (cfg.toolProtocol) {
    out.push(tr("⚠ Text protocol mode is on (off by default): the model issues tool calls through text blocks in the reply body instead. Suspect this first for tool-related problems"));
  }
  out.push(tr("Currently using: {0}; default in config: {1}", current ?? tr("(not selected yet)"), cfg.defaultProvider ?? tr("(not set)")));
  if (current === "api") {
    out.push(tr("Direct API: {0}, model {1}, maxTokens {2}", cfg.api.vendor, cfg.api.model || tr("(not filled in)"), cfg.api.maxTokens));
    // redactDebug replaces apiKey wholesale with [REDACTED], so even "whether it was configured at all"
    // can no longer be seen. These two field names dodge its matching, so support can tell "no Key
    // configured" from "wrong Key".
    out.push(cfg.api.apiKey.set ? tr("API Key: configured, last four {0}", cfg.api.apiKey.last4) : tr("API Key: not configured"));
    if (cfg.api.baseUrl) out.push(tr("Using custom baseUrl: {0}", cfg.api.baseUrl));
  }
  // The model list is empty, so the panel has only "Default" to choose -- users often report "cannot
  // change model", and this is what it actually is
  for (const id of ["claude", "codex", "agy"] as const) {
    if (!cfg.cliModels?.[id]) out.push(tr("{0} has no model list configured, so the panel will only show \"Default\"", id));
  }
  return out;
}

export function AiSetupDialog(props: {
  open: boolean; onClose: () => void;
  providers: ProviderInfo[];
  stt?: SttInfo;
  current: AiProvider | null; onChoose: (id: AiProvider) => void;
  onLogin: (id: AiProvider, deviceAuth?: boolean) => Promise<void>;
  loginState: Partial<Record<AiProvider, LoginState>>;
  setupJobs: CliSetupJob[];
  onCancelSetup: (id: AiProvider) => Promise<void>;
  onInstall: (id: AiProvider) => Promise<void>;
  installState: Partial<Record<AiProvider, "idle" | "installing" | "ok" | "timeout" | "failed">>;
  installError: Partial<Record<AiProvider, string>>;
  config: PublicAiConfig | null; onSaveConfig: (partial: AiConfigPatch) => Promise<void>;
  /** "Clear keys": delete the key file of that route */
  onClearKey?: (kind: KeyKind) => Promise<void>;
}): JSX.Element | null {
  const { open, onClose, providers, stt, current, onChoose, onLogin, loginState, setupJobs, onCancelSetup, onInstall, installState, installError, config, onSaveConfig, onClearKey } = props;
  // Backdrop: close only if both press and release are on the backdrop. Dragging to select text in
  // an input and releasing outside must not close the window
  const backdrop = useBackdropClose(onClose);
  const [clearing, setClearing] = useState<KeyKind | "">("");
  const [clearMsg, setClearMsg] = useState("");
  /** Paste the authorization code: the code lives only in this input's state, is cleared right after
   * submit, and goes into neither the diagnostic report nor logs */
  const [authCode, setAuthCode] = useState("");
  const [authCodeBusy, setAuthCodeBusy] = useState(false);
  const [authCodeMsg, setAuthCodeMsg] = useState("");
  const waitingForCode = setupJobs.some((j) => j.kind === "login" && j.state === "running" && j.acceptsCode);
  useEffect(() => {
    if (!waitingForCode) { setAuthCode(""); setAuthCodeMsg(""); }
  }, [waitingForCode]);
  const submitAuthCode = async (provider: AiProvider) => {
    const code = authCode.trim();
    if (!code || authCodeBusy) return;
    setAuthCodeBusy(true);
    setAuthCodeMsg("");
    try {
      const res = await fetch("/api/ai/setup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, code }), signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || tr("Submit failed, please retry"));
      setAuthCode("");
      setAuthCodeMsg(tr("Submitted, confirming login…"));
    } catch (e) {
      setAuthCodeMsg(e instanceof Error ? e.message : tr("Submit failed, please retry"));
    } finally {
      setAuthCodeBusy(false);
    }
  };
  const clearKeyOf = async (kind: KeyKind) => {
    if (!onClearKey) return;
    if (!confirm(kind === "router" ? tr("Delete the key file imported by Router? You will need to paste the distribution ciphertext again.") : tr("Delete the key file of the custom API? You will need to enter the Key again."))) return;
    setClearing(kind);
    setClearMsg("");
    try {
      await onClearKey(kind);
      setClearMsg(tr("Key file deleted"));
      if (kind === "custom") { setReplaceKey(true); setApiKeyInput(""); }
    } catch (e) {
      setClearMsg(e instanceof Error ? e.message : tr("Cleanup failed"));
    } finally {
      setClearing("");
    }
  };

  /** null = stay on the first-level selection page; a value = entered the configuration page of that item */
  const [openedEntry, setOpenedEntry] = useState<SetupEntryId | null>(null);

  const [apiVendor, setApiVendor] = useState<ApiVendor>("anthropic");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiModel, setApiModel] = useState("");
  /** Model list of the Router route (separated by |), independent of the custom page */
  const [routerModel, setRouterModel] = useState("");
  const [savingRouter, setSavingRouter] = useState(false);
  const [routerMsg, setRouterMsg] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** provider → install method: a command for those that can be installed in one click, a plain sentence for those that cannot */
  const [installPlans, setInstallPlans] = useState<Partial<Record<string, { command?: string; hint?: string }>>>({});
  const [agyPerms, setAgyPerms] = useState<{ path: string; total: number; granted: string[]; missing: string[] } | null>(null);
  const [agyPermError, setAgyPermError] = useState("");
  const [granting, setGranting] = useState(false);
  const [toolProtocol, setToolProtocol] = useState(false);
  /**
   * The maximum number of rounds in one run when "deep autonomy" is on. Stored as a string so the
   * input can be cleared -- with a numeric state, deleting down to empty would be taken as 0, and 0
   * here is a real value meaning "unlimited rounds", so a user who only wanted to change a number
   * would inexplicably end up with unlimited running.
   */
  const [deepRounds, setDeepRounds] = useState("300");
  const [deepRoundsMsg, setDeepRoundsMsg] = useState("");
  /** Advanced switches live under "More". Collapsed every time the dialog opens, so it does not stay
   * open just because it was expanded last time */
  const [moreOpen, setMoreOpen] = useState(false);
  /** Selectable model lists of the three CLIs (separated by |); the model selector on the panel reads it */
  const [cliModels, setCliModels] = useState<Record<string, string>>({});
  const [savingModels, setSavingModels] = useState(false);
  /** Quota cutoff: threshold config (global) + the most recently queried usage of each CLI */
  const [quotaCfg, setQuotaCfg] = useState<QuotaConfig>({ enabled: true, thresholdPercent: 80, checkEveryBytes: 262144 });
  const [quotaInfo, setQuotaInfo] = useState<Record<string, QuotaInfo | undefined>>({});
  const [quotaBusy, setQuotaBusy] = useState<Record<string, boolean>>({});
  const [quotaMsg, setQuotaMsg] = useState("");
  const [loadingAgyModels, setLoadingAgyModels] = useState(false);
  const [loadingApiModels, setLoadingApiModels] = useState(false);
  const [apiModelsMsg, setApiModelsMsg] = useState("");
  const [modelsMsg, setModelsMsg] = useState("");
  const [diagState, setDiagState] = useState("");
  /*
   * The collected report + the child window that holds it.
   *
   * It used to pick a route by length on a single click and be done (short ones to the clipboard,
   * long ones to disk), so the user could neither see what the report looked like nor choose. Now
   * it is shown first, and the three routes, copy / save as file / submit, are the user's decision.
   */
  const [diagReport, setDiagReport] = useState("");
  const [diagOpen, setDiagOpen] = useState(false);
  /*
   * Where the report went needs a visible toast.
   *
   * It used to just put that sentence in the small grey line next to "Use this one", and after
   * clicking Debugger nothing happened at all, so the user had no idea whether the copy succeeded.
   */
  const [diagToast, setDiagToast] = useState("");
  const diagToastTimer = useRef<number | null>(null);
  const showDiagToast = (text: string) => {
    setDiagToast(text);
    if (diagToastTimer.current) window.clearTimeout(diagToastTimer.current);
    diagToastTimer.current = window.setTimeout(() => setDiagToast(""), 6000);
  };
  useEffect(() => () => { if (diagToastTimer.current) window.clearTimeout(diagToastTimer.current); }, []);
  /** The "Display" subsection reads and writes the display preferences shared by all tabs (chat/viewPrefs), not this dialog's own state */
  const viewPrefs = useViewPrefs();

  /*
   * Navigation state is reset only at the moment "the dialog is opened".
   *
   * This used to be in the same effect as the form sync below, with dependencies
   * [open, current, config] -- so **every config save kicked the user back to the first level**:
   * fill in the API Key and click save, config changes, the effect reruns, and
   * setOpenedEntry(null) closes the detail page; an expanded "More" would also be folded.
   * Split into two: this one watches only open, and the other only syncs config into the form.
   */
  useEffect(() => {
    if (!open) return;
    setOpenedEntry(null);
    setMoreOpen(false);
    setDiagState("");
    setDiagReport("");
    setDiagOpen(false);
    // Save feedback and uncommitted input also belong to the state of "this opening" and must not
    // follow config: if they did, the moment a save succeeds config changes and "Saved" is wiped on
    // the spot, so the user sees nothing.
    setApiKeyInput("");
    setSaveSuccess(false);
    setSaveError(null);
    // The same goes for the "autonomy rounds" receipt: the moment a save succeeds config changes and
    // the form-sync effect below reruns, so clearing it there would wipe the receipt just written --
    // the save succeeded yet the user sees no feedback at all
    setDeepRoundsMsg("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (config) {
      // Each of the two routes reads its own profile; an old server without profiles falls back to the
      // top-level one
      const custom = config.api.profiles?.custom ?? config.api;
      setApiVendor(custom.vendor);
      setApiBaseUrl(custom.baseUrl);
      setApiModel(custom.model);
      setRouterModel(config.api.profiles?.router?.model ?? (config.api.source === "router" ? config.api.model : ""));
      setRouterMsg("");
      setReplaceKey(!config.api.apiKey.set);
      setToolProtocol(!!config.toolProtocol);
      setDeepRounds(String(config.deepAutoRounds ?? 300));
      setCliModels({ ...(config.cliModels ?? {}) });
      setModelsMsg("");
      if (config.quota) setQuotaCfg({ ...config.quota });
    }
    fetch("/api/ai/agy-permissions")
      .then((r) => r.json())
      .then((data) => { if (data.ok) setAgyPerms(data); })
      .catch(() => {});
  }, [open, config]);

  useEffect(() => {
    if (!open) return;
    // For the items not installed: ask the server whether one-click install is possible and what the
    // command is (dryRun only answers, does not execute)
    for (const p of providers) {
      if (p.available) continue;
      fetch("/api/ai/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p.id, dryRun: true }),
      })
        .then((r) => r.json())
        .then((d) => setInstallPlans((prev) => ({ ...prev, [p.id]: d.ok ? { command: d.command } : { hint: d.hint || d.error } })))
        .catch(() => {});
    }
  }, [open, providers]);

  useEffect(() => {
    if (!open || (openedEntry !== "claude" && openedEntry !== "codex")) return;
    void loadQuota(openedEntry, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openedEntry]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Esc first goes back one level, and only a second press closes the whole dialog
      if (openedEntry) goTo(null);
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, openedEntry]);

  if (!open) return null;

  const handleGrant = async () => {
    setGranting(true);
    setAgyPermError("");
    try {
      const r = await fetch("/api/ai/agy-permissions", { method: "POST" });
      const data = await r.json();
      if (data.ok) {
        setAgyPerms((prev) => (prev ? { ...prev, granted: [...prev.granted, ...data.added], missing: [] } : null));
      } else {
        setAgyPermError(data.error || tr("Authorization failed"));
      }
    } catch (e) {
      setAgyPermError(String(e));
    } finally {
      setGranting(false);
    }
  };

  const handleSaveApi = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    // Write explicitly into the custom route: even if Router is currently in effect, Router's config
    // is not overwritten
    const patch: AiConfigPatch = { api: { profiles: { custom: { vendor: apiVendor, baseUrl: apiBaseUrl, model: apiModel } } } };
    if (replaceKey && apiKeyInput.trim()) { patch.api!.apiKey = apiKeyInput.trim(); patch.api!.source = "custom"; }
    else if (config?.keys?.custom.set) patch.api!.source = "custom"; // Saving the custom page = switching to the custom route
    try {
      await onSaveConfig(patch);
      setSaveSuccess(true);
      setApiKeyInput("");
      setReplaceKey(false);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message || tr("Save failed") : tr("Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const saveCliModels = async () => {
    setSavingModels(true);
    setModelsMsg("");
    try {
      await onSaveConfig({ cliModels });
      setModelsMsg(tr("Saved, the model selector on the panel will use the new list immediately"));
    } catch (e) {
      setModelsMsg(e instanceof Error ? e.message : tr("Save failed"));
    } finally {
      setSavingModels(false);
    }
  };

  /** agy can list models itself, no need to type them. The other two have no list command, so they must be filled in by hand */
  const loadAgyModels = async () => {
    setLoadingAgyModels(true);
    setModelsMsg("");
    try {
      const d = await (await fetch("/api/ai/models?provider=agy")).json();
      if (!d.ok) throw new Error(d.error || tr("Cannot read the model list"));
      const list: string[] = d.models ?? [];
      if (list.length === 0) throw new Error(tr("The CLI returned no models"));
      setCliModels((prev) => ({ ...prev, agy: list.join("|") }));
      setModelsMsg(tr("Read {0} models, confirm and click Save", list.length));
    } catch (e) {
      setModelsMsg(e instanceof Error ? e.message : tr("Read failed"));
    } finally {
      setLoadingAgyModels(false);
    }
  };

  /**
   * Direct API: pull the model list from the endpoint itself, to save typing.
   *
   * It reads the **saved** config (the server takes baseUrl and the decrypted Key and calls
   * /v1/models), so save first, then read -- otherwise an address just edited in the box is not on
   * disk yet, and what is read back is the previous one.
   */
  const loadApiModels = async () => {
    setLoadingApiModels(true);
    setApiModelsMsg("");
    try {
      await onSaveConfig({ api: { profiles: { custom: { vendor: apiVendor, baseUrl: apiBaseUrl, model: apiModel } } } } as AiConfigPatch);
      const d = await (await fetch("/api/ai/models?provider=api")).json();
      if (!d.ok) throw new Error(d.error || tr("Cannot read the model list"));
      const list: string[] = d.models ?? [];
      if (list.length === 0) throw new Error(tr("The API returned no models"));
      setApiModel(list.join("|"));
      setApiModelsMsg(tr("Read {0} models, confirm and click Save", list.length));
    } catch (e) {
      setApiModelsMsg(e instanceof Error ? e.message : tr("Read failed"));
    } finally {
      setLoadingApiModels(false);
    }
  };

  const saveQuota = async (next: QuotaConfig) => {
    setQuotaCfg(next);
    setQuotaMsg("");
    try {
      await onSaveConfig({ quota: next });
      setQuotaMsg(tr("Saved"));
    } catch (e) {
      setQuotaMsg(e instanceof Error ? e.message : tr("Save failed"));
    }
  };

  /** Query the usage of one vendor. The Claude one has to run claude -p /usage once, about ten seconds */
  const loadQuota = async (provider: string, refresh: boolean) => {
    setQuotaBusy((prev) => ({ ...prev, [provider]: true }));
    try {
      const d = await (await fetch(`/api/ai/quota?provider=${provider}${refresh ? "&refresh=1" : ""}`)).json();
      if (!d.ok) throw new Error(d.error || tr("Cannot look up quota"));
      setQuotaInfo((prev) => ({ ...prev, [provider]: d.quota }));
    } catch (e) {
      setQuotaInfo((prev) => ({ ...prev, [provider]: { provider, label: provider, supported: true, ok: false, checkedAt: Date.now(), windows: [], maxUsedPercent: null, worst: null, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setQuotaBusy((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const handleSaveProtocol = async (checked: boolean) => {
    setToolProtocol(checked);
    await onSaveConfig({ toolProtocol: checked });
  };

  /** Whether "autonomy rounds" has been changed. If so, hang a dot on the "More" button, so you can tell it was touched even when collapsed */
  const roundsChanged = (config?.deepAutoRounds ?? 300) !== 300;

  /**
   * Save "autonomy rounds" on blur. Do not "save as you type": intermediate states (say, deleting 300
   * down to 3, then to empty) each hitting disk is pointless and would also wrongly store the
   * special value 0.
   */
  const handleSaveDeepRounds = async () => {
    const raw = deepRounds.trim();
    if (raw === "") {
      // Clearing is not treated as 0. 0 means "unlimited" and must be typed out by the user
      setDeepRounds(String(config?.deepAutoRounds ?? 300));
      setDeepRoundsMsg("");
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 100000 || !Number.isInteger(v)) {
      setDeepRoundsMsg(tr("Enter an integer from 0 to 100000; 0 means unlimited rounds"));
      return;
    }
    if (v === (config?.deepAutoRounds ?? 300)) { setDeepRoundsMsg(""); return; }
    try {
      await onSaveConfig({ deepAutoRounds: v });
      setDeepRoundsMsg(v === 0 ? tr("Saved: unlimited rounds") : tr("Saved: {0} rounds", v));
    } catch (e) {
      setDeepRoundsMsg(e instanceof Error ? e.message : tr("Save failed"));
    }
  };

  /**
   * Troubleshooting info: the server's part (platform, CLI paths, install/login state of each
   * vendor, the redacted config) plus a bit of browser-side context, collected into one JSON and
   * shown in a child window. Keys are already replaced with last4 on the server, the machine code
   * keeps only its first group (it is also the decryption passphrase for config distribution), and
   * redactDebug is one more safety net.
   *
   * Collect fully before opening the window: collection waits for the server to refresh the status
   * of each CLI, and opening the window first would flash blank; during collection "Collecting..."
   * shows on the small text line at the bottom.
   */
  const openDiagnostics = async () => {
    setDiagState(tr("Collecting…"));
    setDiagReport("");
    let report: string;
    try {
      const res = await fetch("/api/ai/diagnostics");
      const server = await res.json();
      report = JSON.stringify(
        redactDebug({
          format: "PromptCut AI setup diagnostics v2",
          copiedAt: new Date().toISOString(),
          // Put at the very top: the few entries that differ from the defaults and most easily send people
          // the wrong way when investigating. They are already in the server's config, but buried under
          // hundreds of lines of JSON where nobody finds them -- that is how mix-ups like "the user actually
          // has text protocol mode on" come about.
          notable: notableSettings(server?.config, current),
          browser: { userAgent: navigator.userAgent, language: navigator.language },
          openedEntry,
          currentProvider: current,
          setupJobs: setupJobs.map((j) => ({ ...j, logs: j.logs.slice(-8) })),
          server,
        }),
        null,
        2,
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setDiagState(tr("Collection failed: {0}", why));
      showDiagToast(tr("Failed to collect diagnostics: {0}", why));
      return;
    }
    // On successful collection, show the report in the child window; copy / save as file / submit is
    // the user's own pick.
    setDiagReport(report);
    setDiagOpen(true);
    setDiagState("");
  };

  /** When switching entries, clear the previous item's diagnostic output, so it does not look like it belongs to the current one */
  const goTo = (id: SetupEntryId | null) => {
    setOpenedEntry(id);
    setDiagState("");
    setDiagReport("");
    setDiagOpen(false);
  };

  /** Whether this item is usable right now, and if not, what is missing */
  const readiness = (entry: SetupEntry): { ok: boolean; label: string; tone: "ok" | "warn" | "idle" } => {
    if (isCliEntry(entry.id)) {
      const p = providers.find((x) => x.id === entry.provider);
      if (!p?.available) return { ok: false, label: tr("Not installed"), tone: "warn" };
      if (p.auth?.status === 'invalid') return { ok: false, label: tr("Login expired"), tone: 'warn' };
      if (p.auth?.loggedIn === true) return { ok: true, label: tr("Logged in"), tone: "ok" };
      if (p.auth?.loggedIn === false) return { ok: false, label: tr("Not logged in"), tone: "warn" };
      return { ok: false, label: tr("Login status pending confirmation"), tone: "idle" };
    }
    if (config?.api.apiKey.set) return { ok: true, label: tr("Configured ••••{0}", config.api.apiKey.last4), tone: "ok" };
    return { ok: false, label: tr("Not configured"), tone: "idle" };
  };

  const renderCliBody = (entry: SetupEntry) => {
    const p = providers.find((x) => x.id === entry.provider);
    if (!p) return <div className="ais-detail">{tr("This item was not detected on this machine.")}</div>;
    const st = loginState[p.id];
    const job = setupJobs.find((j) => j.provider === p.id);
    const plan = installPlans[p.id];
    const ist = installState[p.id] || "idle";
    const err = installError[p.id];

    return (
      <>
        <section className="ais-step">
          <div className="ais-step-head">
            <span className="ais-step-no">1</span>
            <span className="ais-step-title">{tr("Install")}</span>
            <span className={p.available ? "ais-status-ok" : "ais-status-err"}>
              {p.available ? p.version || tr("Installed (version unknown)") : tr("Not installed")}
            </span>
          </div>
          {!p.available && (
            plan?.command ? (
              <div className="ais-auth-action">
                <button className="ais-btn ais-primary-btn" disabled={ist === "installing"} onClick={(e) => { e.preventDefault(); onInstall(p.id); }}>
                  {ist === "installing" ? tr("Installing…") : ist === "ok" ? tr("Installed") : ist === "timeout" ? tr("Took too long, retry") : ist === "failed" ? tr("Retry install") : tr("Install")}
                </button>
                <span className="ais-detail">{ist === "installing" ? tr("Installing in the background, it will be detected automatically when done") : plan.command}</span>
              </div>
            ) : (
              <div className="ais-detail">{plan?.hint || tr("This item must be installed manually following the official instructions.")}</div>
            )
          )}
          {err && <div className="ais-fixhint">{err}</div>}
        </section>

        <section className="ais-step">
          <div className="ais-step-head">
            <span className="ais-step-no">2</span>
            <span className="ais-step-title">{tr("Log in")}</span>
            {p.auth?.loggedIn === true
              ? <span className="ais-status-ok">{tr("Logged in")}</span>
              : <span className="ais-status-err">{p.auth?.status === 'invalid' ? tr("Login expired") : p.auth?.loggedIn === false ? tr("Not logged in") : tr("Pending confirmation")}</span>}
          </div>
          {(
            <div className="ais-auth-action">
              <button className="ais-btn ais-primary-btn" disabled={!p.available || st === "waiting"} onClick={(e) => { e.preventDefault(); onLogin(p.id); }}>
                {st === "waiting" ? tr("Waiting for login…") : st === "timeout" || st === "failed" ? tr("Retry login") : p.auth?.loggedIn === true || p.auth?.status === 'invalid' ? tr("Log in again") : tr("Log in")}
              </button>
              {!p.available && <span className="ais-detail">{tr("Install it before logging in")}</span>}
            </div>
          )}
          {p.id === "codex" && <div className="ais-detail">{tr("PromptCut uses a separate login, unaffected by the Codex desktop app configuration.")}</div>}
          {p.auth?.loggedIn === null && p.auth.detail && <div className="ais-detail">{p.auth.detail}</div>}
          {p.auth?.fixHint && <div className="ais-fixhint">{p.auth.fixHint}</div>}
          {p.auth?.persistenceWarning && <div className="ais-fixhint">{p.auth.persistenceWarning}</div>}
          {job && (
            <div className="ais-setup-progress" role="status" aria-live="polite">
              <div className={job.state === "failed" ? "ais-fixhint" : "ais-detail"}>{job.message}</div>
              {job.state === "running" && <button className="ais-btn" onClick={(e) => { e.preventDefault(); onCancelSetup(p.id); }}>{tr("Cancel")}</button>}
              {job.url && <a className="ais-btn" href={job.url} target="_blank" rel="noreferrer">{tr("Open login page ↗")}</a>}
              {job.deviceCode && <div>{tr("Login verification code:")}<strong>{job.deviceCode}</strong></div>}
              {job.kind === "login" && job.state === "running" && job.acceptsCode && (
                <details className="ais-code-paste">
                  <summary>{tr("Browser did not return to the app automatically? Paste the authorization code from the login page")}</summary>
                  <div className="ais-detail">
                    {tr("After authorizing on the login page, if the page shows an authorization code, copy it, paste it here, and click \"Submit\". If the browser has already returned to the app automatically and this shows \"Login successful\", you don't need to enter it.")}
                  </div>
                  <div className="ais-api-field ais-code-row">
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitAuthCode(p.id); } }}
                      placeholder={tr("Paste authorization code")}
                    />
                    <button className="ais-btn ais-primary-btn" disabled={authCodeBusy || !authCode.trim()} onClick={(e) => { e.preventDefault(); void submitAuthCode(p.id); }}>
                      {authCodeBusy ? tr("Submitting…") : tr("Submit")}
                    </button>
                  </div>
                  {authCodeMsg && <div className="ais-detail" role="status">{authCodeMsg}</div>}
                </details>
              )}
              {job.kind === "install" && job.logs.length > 0 && <details><summary>{tr("View install details")}</summary><pre>{job.logs.join("")}</pre></details>}
              {p.id === "codex" && job.kind === "login" && job.state === "failed" && (
                <button className="ais-btn" onClick={(e) => { e.preventDefault(); onLogin(p.id, true); }}>{tr("Log in with device code instead")}</button>
              )}
            </div>
          )}
        </section>

        <section className="ais-step">
          <div className="ais-step-head">
            <span className="ais-step-no">${entry.id === "agy" ? 4 : 3}</span>
            <span className="ais-step-title">{tr("Optional models")}</span>
          </div>
          <div className="ais-detail">
            {tr("Use")}{" "} <code>|</code> {" "}{tr("List several, and you can switch between them next to the panel input box.{0}", CAPABILITIES[entry.provider].modelsHint)}
          </div>
          <div className="ais-api-field">
            <input
              type="text"
              value={cliModels[entry.id as "claude" | "codex" | "agy"] ?? ""}
              placeholder={CAPABILITIES[entry.provider].suggestedModels || "model-a|model-b"}
              onChange={(e) => setCliModels((prev) => ({ ...prev, [entry.id]: e.target.value }))}
            />
            <button className="ais-btn" disabled={savingModels} onClick={(e) => { e.preventDefault(); saveCliModels(); }}>
              {savingModels ? tr("Saving…") : tr("Save")}
            </button>
          </div>
          {entry.id === "agy" && (
            <div className="ais-api-field">
              <button className="ais-btn" disabled={loadingAgyModels} onClick={(e) => { e.preventDefault(); loadAgyModels(); }}>
                {loadingAgyModels ? tr("Loading…") : tr("Read from CLI")}
              </button>
              <span className="ais-detail">{tr("Run agy models once and fill the list into the field above")}</span>
            </div>
          )}
          {modelsMsg && <div className="ais-detail">{modelsMsg}</div>}
        </section>

        {(entry.id === "claude" || entry.id === "codex") && (() => {
          const info = quotaInfo[entry.id];
          const busy = !!quotaBusy[entry.id];
          const over = info?.ok && typeof info.maxUsedPercent === "number" && info.maxUsedPercent >= quotaCfg.thresholdPercent;
          return (
            <section className="ais-step">
              <div className="ais-step-head">
                <span className="ais-step-no">4</span>
                <span className="ais-step-title">{tr("Quota circuit breaker")}</span>
                {info?.ok
                  ? <span className={over ? "ais-status-err" : "ais-status-ok"}>{over ? tr("{0}% used, over limit", info.maxUsedPercent) : tr("Highest used {0}%", info.maxUsedPercent)}</span>
                  : <span className="ais-status-err">{busy ? tr("Checking…") : info ? tr("Unavailable") : tr("Not checked")}</span>}
              </div>
              <div className="ais-detail">
                {tr("When the subscription quota (5-hour / weekly window) reaches the threshold, the chat on this route is interrupted with an error, so the arrangement isn't rejected by the CLI halfway through. Roughly every {0} KB of new chat context triggers a background recheck; if usage can't be found (not logged in, API Key mode), it doesn't block.", Math.round(quotaCfg.checkEveryBytes / 1024))}
              </div>
              <label className="ais-more-row">
                <input type="checkbox" checked={quotaCfg.enabled} onChange={(e) => saveQuota({ ...quotaCfg, enabled: e.target.checked })} />
                <span>{tr("Enable circuit breaker")}</span>
              </label>
              <div className="ais-api-field">
                <label>{tr("Threshold %")}</label>
                <input
                  type="number" min={1} max={100} step={5}
                  value={quotaCfg.thresholdPercent}
                  onChange={(e) => setQuotaCfg({ ...quotaCfg, thresholdPercent: Number(e.target.value) || 80 })}
                  onBlur={() => saveQuota({ ...quotaCfg, thresholdPercent: Math.min(100, Math.max(1, Math.round(quotaCfg.thresholdPercent) || 80)) })}
                />
                <label>{tr("Recheck interval KB")}</label>
                <input
                  type="number" min={16} step={64}
                  value={Math.round(quotaCfg.checkEveryBytes / 1024)}
                  onChange={(e) => setQuotaCfg({ ...quotaCfg, checkEveryBytes: Math.max(16, Number(e.target.value) || 256) * 1024 })}
                  onBlur={() => saveQuota({ ...quotaCfg, checkEveryBytes: Math.max(16 * 1024, Math.round(quotaCfg.checkEveryBytes)) })}
                />
                <button className="ais-btn" disabled={busy} onClick={(e) => { e.preventDefault(); void loadQuota(entry.id, true); }}>
                  {busy ? tr("Checking…") : tr("Check now")}
                </button>
              </div>
              {info?.ok && (
                <div className="ais-detail">
                  {info.windows.map((w) => (
                    <div key={w.id}>{tr("{0}: {1}% used{2}", w.label, w.usedPercent, w.resetsText ? tr(", resets {0}", w.resetsText) : "")}</div>
                  ))}
                  {info.planType && <div>{tr("Plan: {0}", info.planType)}</div>}
                </div>
              )}
              {info && !info.ok && <div className="ais-fixhint">{info.error || tr("Usage unavailable")}</div>}
              {quotaMsg && <div className="ais-detail">{quotaMsg}</div>}
            </section>
          );
        })()}

        {entry.id === "agy" && agyPerms && (
          <section className="ais-step">
            <div className="ais-step-head">
              <span className="ais-step-no">3</span>
              <span className="ais-step-title">{tr("Authorize PromptCut tools")}</span>
              <button className="ais-btn ais-primary-btn ais-small-btn" disabled={granting || agyPerms.missing.length === 0} onClick={handleGrant}>
                {agyPerms.missing.length === 0 ? tr("Authorized") : granting ? tr("Authorizing...") : tr("Click to authorize")}
              </button>
            </div>
            <div className="ais-agy-perms-desc">
              {tr("{0} In", agyPerms.missing.length === 0 ? tr("{0} tools authorized.", agyPerms.total) : tr("{0}/{1} tools authorized.", agyPerms.granted.length, agyPerms.total))}{" "} <code>{agyPerms.path}</code> {" "}{tr("'s permissions.allow it will add {0} mcp(promptcut/...) rules; existing rules are left untouched.", agyPerms.missing.length)}
            </div>
            {agyPermError && <div className="ais-status-err">{agyPermError}</div>}
          </section>
        )}
      </>
    );
  };

  const renderRouterBody = () => (
    <section className="ais-step">
      <div className="ais-detail">
        {tr("The distributor encrypts the API config into a ciphertext using your machine ID. Paste it in and it is decrypted and saved automatically, so the key never appears in plaintext in the chat history or on disk.")}
      </div>
      <ApiSharePanel
        onSaveConfig={onSaveConfig}
        saved={config?.keys?.router ?? null}
        active={config?.api.source === "router"}
        clearing={clearing === "router"}
        onClear={onClearKey ? () => clearKeyOf("router") : undefined}
        clearMsg={clearMsg}
      />
      {config?.keys?.router?.set && (
        <>
          <div className="ais-api-field">
            <label>{tr("Model")}</label>
            <input
              type="text"
              value={routerModel}
              onChange={(e) => setRouterModel(e.target.value)}
              placeholder="model-a|model-b"
            />
          </div>
          <div className="ais-detail">
            {tr("The models carried in the distributed ciphertext can be edited here, or use")}{" "} <code>|</code> {" "}{tr("List several alternatives, and you can switch between them next to the panel input box; vendor {0}, address {1}, these two follow the distribution string.", config.api.profiles?.router?.vendor ?? config.api.vendor, config.api.profiles?.router?.baseUrl || tr("(default)"))}
          </div>
          <div className="ais-api-actions">
            <button
              className="ais-btn ais-primary-btn"
              disabled={savingRouter}
              onClick={async (e) => {
                e.preventDefault();
                setSavingRouter(true);
                setRouterMsg("");
                try {
                  await onSaveConfig({ api: { profiles: { router: { model: routerModel } } } });
                  setRouterMsg(tr("Saved, the model selector on the panel will use the new list immediately"));
                } catch (err) {
                  setRouterMsg(err instanceof Error ? err.message : tr("Save failed"));
                } finally {
                  setSavingRouter(false);
                }
              }}
            >
              {savingRouter ? tr("Saving…") : tr("Save model list")}
            </button>
            {routerMsg && <span className="ais-detail">{routerMsg}</span>}
          </div>
        </>
      )}
    </section>
  );

  const renderCustomBody = () => (
    <section className="ais-step">
      <div className="ais-api-field">
        <label>{tr("Vendor")}</label>
        <select value={apiVendor} onChange={(e) => setApiVendor(e.target.value as ApiVendor)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">{tr("OpenAI compatible")}</option>
          <option value="gemini">Gemini</option>
        </select>
      </div>
      <div className="ais-api-field">
        <label>{tr("API address")}</label>
        <input
          type="text"
          value={apiBaseUrl}
          onChange={(e) => setApiBaseUrl(e.target.value)}
          placeholder={apiVendor === "anthropic" ? "https://api.anthropic.com" : apiVendor === "openai" ? "https://api.openai.com" : "https://generativelanguage.googleapis.com"}
        />
      </div>
      <div className="ais-api-field">
        <label>{tr("Model")}</label>
        <input
          type="text"
          value={apiModel}
          onChange={(e) => setApiModel(e.target.value)}
          placeholder={apiVendor === "anthropic" ? "claude-sonnet-4-5|claude-haiku-4-5" : apiVendor === "openai" ? "gpt-4o|gpt-4o-mini" : "gemini-2.0-flash|gemini-2.0-pro"}
        />
      </div>
      <div className="ais-api-field">
        <button className="ais-btn" disabled={loadingApiModels} onClick={(e) => { e.preventDefault(); loadApiModels(); }}>
          {loadingApiModels ? tr("Loading…") : tr("Read from API")}
        </button>
        <span className="ais-detail">{tr("Calls {0}/v1/models once and fills the list into the field above (most relay services support it; official sources list their own models)", tr("{API address}"))}</span>
      </div>
      {apiModelsMsg && <div className="ais-detail">{apiModelsMsg}</div>}
      <div className="ais-detail">
        {tr("Use")}{" "} <code>|</code> {tr("to separate several models, switchable next to the panel input box; the first one is used if none is selected.")}
      </div>
      <div className="ais-api-field">
        <label>API Key</label>
        {config?.keys?.custom.set && !replaceKey ? (
          <div className="ais-api-saved-key">
            <span>{tr("Saved ••••{0}{1}", config.keys.custom.last4, config.api.source === "router" ? tr("(the one imported from Router is currently in effect)") : "")}</span>
            <span className="ais-api-saved-acts">
              <button className="ais-btn" onClick={(e) => { e.preventDefault(); setReplaceKey(true); }}>{tr("Replace")}</button>
              <button className="ais-btn ais-danger-btn" disabled={clearing !== ""} onClick={(e) => { e.preventDefault(); clearKeyOf("custom"); }} title={tr("Delete keys/custom.key")}>
                {clearing === "custom" ? tr("Clearing…") : tr("Clear key")}
              </button>
            </span>
          </div>
        ) : (
          <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder={tr("Paste API Key")} />
        )}
        {clearMsg && <div className="ais-detail">{clearMsg}</div>}
      </div>
      <div className="ais-api-actions">
        <button className="ais-btn ais-primary-btn" onClick={(e) => { e.preventDefault(); handleSaveApi(); }} disabled={saving}>
          {saving ? tr("Saving…") : tr("Save")}
        </button>
        {saveSuccess && <span className="ais-status-ok">{tr("Saved")}</span>}
        {saveError && <span className="ais-status-err">{saveError}</span>}
      </div>
      <div className="ais-detail">
        {tr("The key is encrypted with this machine's fingerprint when saved to disk, stored separately in")}{" "} <code>keys/custom.key</code>{tr("(separate from the one imported via Router, each with its own encryption ID, not mixed), so it is never stored in plain text in the config file; it protects against leaks through backups, synced drives and accidental commits, not against anyone who can run code on this machine.")}
      </div>
    </section>
  );

  const entry = openedEntry ? SETUP_ENTRIES.find((e) => e.id === openedEntry) : null;

  return createPortal(
    <>
    <div className="ais-backdrop" {...backdrop}>
      <div className="ais-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {/* Make it visible where the report went. role=status lets screen readers announce it too */}
        {diagToast && (
          <div className="ais-toast" role="status" onClick={() => setDiagToast("")}>
            {diagToast}
          </div>
        )}
        {!entry ? (
          <>
            <div className="ais-title">{tr("Choose how the AI assistant is driven")}</div>
            <div className="ais-grid">
              {SETUP_ENTRIES.map((item) => {
                const state = readiness(item);
                const isCurrent = current === item.provider && (isCliEntry(item.id) || readFace() === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-entry={item.id}
                    className={`ais-card${isCurrent ? " is-current" : ""}`}
                    onClick={() => goTo(item.id)}
                  >
                    <span className="ais-card-icon">{item.icon}</span>
                    <span className="ais-card-name">{item.name}</span>
                    <span className="ais-card-tagline">{item.tagline}</span>
                    <span className={`ais-card-state is-${state.tone}`}>{state.label}</span>
                    {isCurrent && <span className="ais-card-current">{tr("In use")}</span>}
                  </button>
                );
              })}
            </div>
            {/*
              "Display": the "Compact / Detailed" toggle originally on the AI panel top bar was moved here. It
              is a preference set once based on viewing habits and rarely touched, not worth keeping a permanent
              segmented button on the top bar of every tab; not tucked into "More" because it is not dangerous,
              and discoverability is more important than preventing accidental clicks.
            */}
            <div className="ais-more ais-display">
              <div className="ais-more-title">{tr("Display")}</div>
              <label className="ais-more-row">
                <input
                  type="checkbox"
                  data-pc="ai-verbose-mode"
                  checked={viewPrefs.view === "verbose"}
                  onChange={(e) => setViewMode(e.target.checked ? "verbose" : "simple")}
                />
                <span className="ais-more-body">
                  <span className="ais-more-name">{tr("Verbose mode (show tool calls one by one)")}</span>
                  <span className="ais-detail">
                    {tr("When off, shows action icons by stage and the report cards the Agent hands in; click an icon for details. When on, lists every tool call one by one in the order it happened.")}
                  </span>
                </span>
              </label>
            </div>
            {/*
              Text protocol mode is tucked into "More". Previously it was a bare checkbox on this page that
              anyone could click casually, yet it alters how the model issues tool calls: once enabled, calls
              are written in the body text, which is slower and more error-prone than native tools; it belongs
              to switches that should only be touched when "the CLI genuinely rejects native tools", and should
              not sit on the same level as driver selection.
            */}
            {moreOpen && (
              <div className="ais-more">
                <div className="ais-more-title">{tr("Advanced")}</div>
                <label className="ais-more-row">
                  <input
                    type="checkbox"
                    checked={toolProtocol}
                    onChange={(e) => handleSaveProtocol(e.target.checked)}
                  />
                  <span className="ais-more-body">
                    <span className="ais-more-name">{tr("Text protocol mode")}</span>
                    <span className="ais-detail">
                      {tr("Only needed when this CLI rejects native tools. When on, the model issues tool calls through text blocks in the reply body instead, which is slower than native tools and more error-prone. If unsure, leave it alone.")}
                    </span>
                  </span>
                </label>
                {/*
                  Autonomous rounds: only takes effect when "Deep autonomy" next to the input box is pressed,
                  which is why it is placed here rather than on the panel: the panel governs "how this run executes",
                  whereas a numerical limit is something configured once and left alone.
                */}
                <label className="ais-more-row">
                  <input
                    type="number"
                    className="ais-more-num"
                    min={0}
                    max={100000}
                    step={10}
                    value={deepRounds}
                    onChange={(e) => { setDeepRounds(e.target.value); setDeepRoundsMsg(""); }}
                    onBlur={handleSaveDeepRounds}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                  <span className="ais-more-body">
                    <span className="ais-more-name">{tr("Autonomous rounds")}{deepRoundsMsg && <span className="ais-more-note">{deepRoundsMsg}</span>}</span>
                    <span className="ais-detail">
                      {tr("After you press \"Deep autonomy\" next to the input box, the maximum number of model round trips for this run, and the model is no longer given any hint about rounds.")}<b>{tr("Enter 0 for unlimited rounds")}</b>{tr(": it then keeps running until it thinks it is done or you click stop. This value has no effect unless \"Deep autonomy\" is pressed.")}
                    </span>
                  </span>
                </label>
              </div>
            )}
            <div className="ais-footer">
              <div className="ais-footer-actions">
                {/*
                  Collapsed to prevent accidental clicks, but shouldn't be collapsed so far that "you can't tell
                  it's on". When it has non-default options, put a dot on the button: users know it was modified
                  without expanding, avoiding keeping text protocol mode on while looking elsewhere for the cause.
                */}
                <button
                  className="ais-btn ais-more-btn"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                  title={[toolProtocol ? tr("Text protocol mode is on") : "", roundsChanged ? tr("Autonomous rounds {0}", config?.deepAutoRounds === 0 ? tr("unlimited") : config?.deepAutoRounds) : ""].filter(Boolean).join(tr(";")) || undefined}
                >
                  {tr("More")}{(toolProtocol || roundsChanged) && <span className="ais-more-dot" aria-label={tr("Non-default settings")}>•</span>}
                  {moreOpen ? " ▴" : " ▾"}
                </button>
                <span className="ais-footer-spacer" />
                <button className="ais-btn" onClick={onClose}>{tr("Close")}</button>
              </div>
              {stt && <div className="ais-stt-info">{tr("Speech-to-text: {0} - {1}", stt.engine, stt.available ? tr("available") : tr("Unavailable ({0})", stt.hint))}</div>}
            </div>
          </>
        ) : (
          <>
            <div className="ais-detail-head">
              <button className="ais-btn ais-back-btn" onClick={() => goTo(null)}>{tr("← Back")}</button>
              <span className="ais-card-icon ais-detail-icon">{entry.icon}</span>
              <div className="ais-detail-titles">
                <div className="ais-title">{entry.name}</div>
                <div className="ais-detail">{entry.tagline}</div>
              </div>
            </div>

            <div className="ais-detail-body">
              {isCliEntry(entry.id) ? renderCliBody(entry) : entry.id === "router" ? renderRouterBody() : renderCustomBody()}
            </div>

            <div className="ais-footer">
              <div className="ais-footer-actions">
                <button
                  className="ais-btn"
                  onClick={openDiagnostics}
                  disabled={diagState === tr("Collecting…")}
                  title={tr("Collect local environment, install and login status (no keys); copy / save to file / submit in the sub-window")}
                >
                  {diagState === tr("Collecting…") ? tr("Collecting…") : "Debugger"}
                </button>
                <span className="ais-use-hint">{diagState || (readiness(entry).ok ? "" : readiness(entry).label)}</span>
                <button
                  className="ais-btn ais-primary-btn"
                  disabled={!readiness(entry).ok}
                  onClick={() => { writeFace(entry.id); onChoose(entry.provider); }}
                >
                  {tr("Use this one")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    <ReportDialog
      open={diagOpen}
      title={tr("Environment diagnostic report")}
      label={tr("Environment diagnostics")}
      hint={tr("Includes local environment and install and login status of each CLI; no keys, machine code keeps only the first group")}
      text={diagReport}
      onClose={() => setDiagOpen(false)}
    />
    </>,
    document.body,
  );
}
