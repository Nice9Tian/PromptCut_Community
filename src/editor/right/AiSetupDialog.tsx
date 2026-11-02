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
 * 把「非默认、又容易让排查跑偏」的设置挑成人话，放在诊断报告最前面。
 *
 * 这些值服务端那份 config 里全都有，问题在于没人会去翻。文本协议模式尤其：
 * 它一开，模型就改用回复正文里的文本块下达工具调用，工具相关的症状全变样，
 * 而开关本身藏在「更多」里，用户自己都未必记得点过。
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
    // redactDebug 会把 apiKey 整个换成 [REDACTED]，连「到底配没配」都看不出来了。
    // 这两个字段名躲开它的匹配，好让支持能分清「没配 Key」和「Key 不对」。
    out.push(cfg.api.apiKey.set ? tr("API Key: configured, last four {0}", cfg.api.apiKey.last4) : tr("API Key: not configured"));
    if (cfg.api.baseUrl) out.push(tr("Using custom baseUrl: {0}", cfg.api.baseUrl));
  }
  // 模型清单是空的，面板上就只有「默认」一项可选 —— 用户常报「换不了模型」其实是这个
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
  /** 「清理密钥」:删掉那一路的密钥文件 */
  onClearKey?: (kind: KeyKind) => Promise<void>;
}): JSX.Element | null {
  const { open, onClose, providers, stt, current, onChoose, onLogin, loginState, setupJobs, onCancelSetup, onInstall, installState, installError, config, onSaveConfig, onClearKey } = props;
  // 遮罩:按下和松开都在遮罩上才关。在输入框里拖着选文字、松手滑到外面,不能把窗口关了
  const backdrop = useBackdropClose(onClose);
  const [clearing, setClearing] = useState<KeyKind | "">("");
  const [clearMsg, setClearMsg] = useState("");
  /** 粘贴授权码：码只放在这个输入框的状态里，提交后立刻清空，不进诊断报告、不写日志 */
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

  /** null = 停在第一级的选择页;有值 = 进了那一项的配置页 */
  const [openedEntry, setOpenedEntry] = useState<SetupEntryId | null>(null);

  const [apiVendor, setApiVendor] = useState<ApiVendor>("anthropic");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiModel, setApiModel] = useState("");
  /** Router 那一路的模型清单(| 分隔),独立于自定义页 */
  const [routerModel, setRouterModel] = useState("");
  const [savingRouter, setSavingRouter] = useState(false);
  const [routerMsg, setRouterMsg] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** provider → 安装方式:能一键装的给命令,不能的给一句人话 */
  const [installPlans, setInstallPlans] = useState<Partial<Record<string, { command?: string; hint?: string }>>>({});
  const [agyPerms, setAgyPerms] = useState<{ path: string; total: number; granted: string[]; missing: string[] } | null>(null);
  const [agyPermError, setAgyPermError] = useState("");
  const [granting, setGranting] = useState(false);
  const [toolProtocol, setToolProtocol] = useState(false);
  /**
   * 「深度自主」开着时一次运行最多跑多少轮。存成字符串是为了让输入框能清空 ——
   * 用数字 state 的话,删到空会被当成 0,而 0 在这里是「不限轮次」这个真实取值,
   * 用户只是想改个数字就莫名其妙变成了无限跑。
   */
  const [deepRounds, setDeepRounds] = useState("300");
  const [deepRoundsMsg, setDeepRoundsMsg] = useState("");
  /** 「更多」里放高级开关。每次打开对话框都收回去,免得上次展开过就一直敞着 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 三家 CLI 的可选模型清单(| 分隔),面板上的模型选择器读它 */
  const [cliModels, setCliModels] = useState<Record<string, string>>({});
  const [savingModels, setSavingModels] = useState(false);
  /** 额度熔断:阈值配置(全局)+ 每家 CLI 最近查到的用量 */
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
   * 收好的报告 + 装它的子窗口。
   *
   * 以前是点一下就按长度自己选路走掉(短的进剪贴板、长的落盘),用户既看不到
   * 报告长什么样也没得挑。现在先摆出来,复制 / 保存为文件 / 提交三条路由用户定。
   */
  const [diagReport, setDiagReport] = useState("");
  const [diagOpen, setDiagOpen] = useState(false);
  /*
   * 报告到底去哪了,要弹一条看得见的提示。
   *
   * 以前只把这句话塞进「使用这一项」旁边那行小灰字里,点完 Debugger 什么动静都
   * 没有,用户根本不知道复制成功没有。
   */
  const [diagToast, setDiagToast] = useState("");
  const diagToastTimer = useRef<number | null>(null);
  const showDiagToast = (text: string) => {
    setDiagToast(text);
    if (diagToastTimer.current) window.clearTimeout(diagToastTimer.current);
    diagToastTimer.current = window.setTimeout(() => setDiagToast(""), 6000);
  };
  useEffect(() => () => { if (diagToastTimer.current) window.clearTimeout(diagToastTimer.current); }, []);
  /** 「显示」小节读写的是所有分页共用的显示偏好(chat/viewPrefs),不是这个对话框自己的状态 */
  const viewPrefs = useViewPrefs();

  /*
   * 导航状态只在「对话框被打开」这一刻重置。
   *
   * 以前这段和下面的表单同步写在同一个 effect 里,依赖是 [open, current, config] ——
   * 于是**每次保存配置都会把人踢回第一级**:填完 API Key 点保存,config 一变,
   * effect 重跑,setOpenedEntry(null) 把详情页收掉;「更多」展开着也会被合上。
   * 拆成两个:这个只看 open,那个只管把 config 同步进表单。
   */
  useEffect(() => {
    if (!open) return;
    setOpenedEntry(null);
    setMoreOpen(false);
    setDiagState("");
    setDiagReport("");
    setDiagOpen(false);
    // 保存反馈和没提交的输入也属于「这一次打开」的状态,不能跟着 config 走:
    // 跟着走的话保存成功那一刻 config 一变,「已保存」当场被抹掉,用户什么都没看见。
    setApiKeyInput("");
    setSaveSuccess(false);
    setSaveError(null);
    // 「自主轮次」那句回执同理:保存成功那一刻 config 一变,下面同步表单的 effect 会重跑,
    // 把清空放在那边等于自己抹掉刚写的回执 —— 存成功了用户却什么反馈都看不见
    setDeepRoundsMsg("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (config) {
      // 两路各读各的 profile;老服务端没有 profiles 时退回顶层那份
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
    // 未安装的那几项:问服务端能不能一键装、命令是什么(dryRun 只回答不执行)
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
      // Esc 先退回上一级,再按一次才关掉整个对话框
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
    // 显式写进 custom 那一路:即使当前生效的是 Router,也不会把 Router 的配置冲掉
    const patch: AiConfigPatch = { api: { profiles: { custom: { vendor: apiVendor, baseUrl: apiBaseUrl, model: apiModel } } } };
    if (replaceKey && apiKeyInput.trim()) { patch.api!.apiKey = apiKeyInput.trim(); patch.api!.source = "custom"; }
    else if (config?.keys?.custom.set) patch.api!.source = "custom"; // 保存自定义页 = 切到自定义那一路
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

  /** agy 自己能列模型,不用手打。其余两家没有列表命令,只能手填 */
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
   * API 直连:从接口自己拉模型清单，省得手打。
   *
   * 读的是**已保存**的配置（服务端拿 baseUrl 和解密后的 Key 去打 /v1/models），
   * 所以先存再读——不然刚在框里改的地址还没落盘，读回来的是上一次那份。
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

  /** 查一家的用量。Claude 那条要跑一次 claude -p /usage,十来秒 */
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

  /** 「自主轮次」改过没有。改过就在「更多」按钮上挂个点,不展开也知道这儿动过 */
  const roundsChanged = (config?.deepAutoRounds ?? 300) !== 300;

  /**
   * 「自主轮次」失焦时存。不做「边打字边存」:中间态(比如把 300 删成 3 再删成空)
   * 每一步都落盘,既没意义也会把 0 这个特殊值误存进去。
   */
  const handleSaveDeepRounds = async () => {
    const raw = deepRounds.trim();
    if (raw === "") {
      // 清空不当成 0。0 是「不限」,得让用户自己打出来
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
   * 排查信息:服务端那份(平台、CLI 路径、各家安装/登录状态、脱敏后的配置)
   * 加上浏览器这边的一点上下文,收成一份 JSON 摆进子窗口。密钥在服务端就已经
   * 换成 last4,机器码只留首组(它同时是配置分发的解密口令),redactDebug 再兜一道底。
   *
   * 先收完再开窗:收集要等服务端 refresh 一遍各家 CLI 状态,先开窗会闪一下空白;
   * 收集期间「正在收集…」显示在底部那行小字上。
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
          // 摆在最前面:和默认值不一样、又最容易让人查错方向的几条。
          // 服务端那份 config 里本来就有,但埋在几百行 JSON 底下没人翻得到 ——
          // 「用户其实开着文本协议模式」这种乌龙就是这么来的。
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
    // 收集成功就把报告摆进子窗口,复制 / 保存为文件 / 提交由用户自己挑。
    setDiagReport(report);
    setDiagOpen(true);
    setDiagState("");
  };

  /** 切换入口时把上一项的诊断输出清掉,免得看着像是当前这项的 */
  const goTo = (id: SetupEntryId | null) => {
    setOpenedEntry(id);
    setDiagState("");
    setDiagReport("");
    setDiagOpen(false);
  };

  /** 这一项现在能不能用,以及不能用的话缺什么 */
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
        {/* 报告去哪了要看得见。role=status 让读屏软件也念出来 */}
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
              「显示」:原来 AI 面板顶栏上的「简洁 / 详细」切换搬到这里。它是看习惯定一次就不怎么动的偏好,
              不值得在每个分页的顶栏上常驻一个分段按钮;不收进「更多」,因为它不危险,找得到比防误触要紧。
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
              文本协议模式收进「更多」里。它以前是这一页上一个裸的勾选框,谁都可能顺手点一下,
              可它改的是模型下达工具调用的方式 —— 打开之后调用写在正文里,比原生工具慢也更容易出错,
              属于「CLI 真的拒绝原生工具了」才该动的开关,不该和选驱动放在同一层。
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
                  自主轮次:只在输入框旁边的「深度自主」按下时才起作用,所以放在这里而不是
                  面板上 —— 面板管的是「这一次怎么跑」,一个数值上限是设一次就不动的东西。
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
                  收起来是为了防误触,但不能收到「开着也看不出来」。里面有非默认项时
                  按钮上挂个点:用户不展开也知道这儿动过,不至于一直开着文本协议模式
                  却在别处找原因。
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
