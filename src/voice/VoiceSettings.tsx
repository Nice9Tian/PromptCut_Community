import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import "./VoiceSettings.css";
import {
  getVoiceConfig, saveVoiceConfig, clearVoiceKey, generateVoice, addVoice, removeVoice, designVoice, cloneVoiceFromFile,
  type VoiceConfig, type VoicePresets, type Provider, type CustomVoice,
} from "../ai/voice";

/** 界面上改着的那部分;API Key 单独放,保存时才带上 */
type Draft = Pick<VoiceConfig, "baseUrl" | "provider" | "minimax" | "kling" | "vidu">;

const pick = (c: VoiceConfig): Draft => ({
  baseUrl: c.baseUrl, provider: c.provider,
  minimax: { ...c.minimax }, kling: { ...c.kling }, vidu: { ...c.vidu },
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const KIND_LABEL: Record<CustomVoice["kind"], string> = { clone: "复刻", design: "设计", manual: "手填" };

const FEE_NOTE = "每个新音色第一次用来合成时，MiniMax 另收 ¥9.9；建好后 7 天内没用过会被删除。";

/**
 * 开始页的「配音」:agent 的 voice_generate 默认用这里的服务、音色和参数。
 *
 * 改完要点「保存」才生效(试听会先替你保存)。新建音色会花钱,每一步都先确认。
 * 住在「配音设置」子窗口里(bare:去掉自己的边框和标题,由窗口给)。
 */
export function VoiceSettings(props: { bare?: boolean; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const { bare, onDirtyChange } = props;
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [presets, setPresets] = useState<VoicePresets | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [previewText, setPreviewText] = useState("任务完成了。三十二个测试全部通过，你回来看一下就行。");
  const [audioUrl, setAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    getVoiceConfig()
      .then(({ config, presets }) => { setCfg(config); setPresets(presets); setDraft(pick(config)); })
      .catch((e) => setMsg({ tone: "err", text: `读不到配音设置：${errText(e)}` }));
  }, []);

  // 新的试听一到就放
  useEffect(() => { if (audioUrl) void audioRef.current?.play().catch(() => {}); }, [audioUrl]);

  const dirty = !!cfg && !!draft && (JSON.stringify(pick(cfg)) !== JSON.stringify(draft) || !!keyInput.trim());
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const rootClass = `vs${bare ? " is-bare" : ""}`;
  if (!cfg || !presets || !draft) {
    return <div className={rootClass}>{msg ? <div className="vs-msg is-err">{msg.text}</div> : <span className="sp-muted">读取配音设置…</span>}</div>;
  }

  const P = draft.provider;

  const apply = (c: VoiceConfig) => { setCfg(c); setDraft(pick(c)); };
  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    setMsg(null);
    try { await fn(); } catch (e) { setMsg({ tone: "err", text: errText(e) }); } finally { setBusy(""); }
  };
  const persist = async () => {
    const c = await saveVoiceConfig({ ...draft, ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}) });
    apply(c);
    setKeyInput("");
    return c;
  };
  const setField = <K extends Provider>(k: K, patch: Partial<Draft[K]>) =>
    setDraft((d) => (d ? { ...d, [k]: { ...d[k], ...patch } } : d));

  const save = () => run("save", async () => { await persist(); setMsg({ tone: "ok", text: "已保存。agent 配音会用这套设置。" }); });

  const preview = () => run("preview", async () => {
    if (dirty) await persist();
    const r = await generateVoice({ text: previewText }, { preview: true });
    setAudioUrl(`${r.url}?t=${Date.now()}`);
    setMsg({ tone: "ok", text: `${presets.labels[r.provider]} · ${r.voiceId} · ${r.chars} 字 · ${(r.ms / 1000).toFixed(1)} 秒生成` });
  });

  const clearKey = () => {
    if (!confirm("删掉配音用的 API Key？之后配音会失败，直到重新填一个。")) return;
    void run("key", async () => { apply(await clearVoiceKey()); setMsg({ tone: "ok", text: "API Key 已删除" }); });
  };

  const voiceOptions = (p: Provider) => {
    const mine = cfg.customVoices.filter((v) => v.provider === p);
    return (
      <>
        {mine.length > 0 && (
          <optgroup label="我的音色">
            {mine.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name}（{KIND_LABEL[v.kind]}）</option>)}
          </optgroup>
        )}
        <optgroup label="系统音色">
          {presets.systemVoices[p].map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name} · {v.voiceId}</option>)}
        </optgroup>
      </>
    );
  };

  const emotionSelect = (value: string, onChange: (v: string) => void) => (
    <select className="vs-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {presets.emotions.map((e) => <option key={e} value={e}>{presets.emotionLabels[e] ?? e}</option>)}
    </select>
  );

  const useVoice = (v: CustomVoice) => run("use", async () => {
    apply(await saveVoiceConfig({ provider: v.provider, [v.provider]: { voiceId: v.voiceId } }));
    setMsg({ tone: "ok", text: `默认音色改成「${v.name}」` });
  });

  const dropVoice = (v: CustomVoice) => {
    if (!confirm(`从列表里移除「${v.name}」？只删这里的记录，服务商那边的音色不会删；之后 agent 就用不了它。`)) return;
    void run("drop", async () => { apply(await removeVoice(v.provider, v.voiceId)); });
  };

  return (
    <div className={rootClass}>
      <div className="vs-head">
        <div className="vs-head-text">
          {!bare && <div className="vs-title">云端配音 · voice_generate</div>}
          <div className="sp-muted">agent 把文字配成语音时默认用这里的服务和音色；走 API，按字数计费。</div>
        </div>
        <div className="vs-seg" role="group" aria-label="默认服务">
          {presets.providers.map((p) => (
            <button key={p} className="vs-seg-btn" aria-pressed={P === p} onClick={() => setDraft({ ...draft, provider: p })}>
              {presets.labels[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="vs-grid">
        <Field label="API Key">
          <div className="vs-row">
            <input
              className="vs-input vs-grow" type="password" autoComplete="off" value={keyInput}
              placeholder={cfg.apiKey.set ? `已设置（···${cfg.apiKey.last4}），留空不改` : "粘贴配音用的 API Key sk-…"}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            {cfg.apiKey.set && <button className="sp-ghost-btn" disabled={!!busy} onClick={clearKey}>删除</button>}
          </div>
        </Field>
        <Field label="API 地址">
          <input
            className="vs-input" value={draft.baseUrl}
            placeholder={cfg.effectiveBaseUrl ? `留空跟随 API 设置（${cfg.effectiveBaseUrl}）` : "https://…（API 设置里也没填地址）"}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
        </Field>

        {P === "minimax" && (
          <>
            <Field label="模型">
              <select className="vs-input" value={draft.minimax.model} onChange={(e) => setField("minimax", { model: e.target.value })}>
                {presets.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="音色">
              <select className="vs-input" value={draft.minimax.voiceId} onChange={(e) => setField("minimax", { voiceId: e.target.value })}>
                {voiceOptions("minimax")}
              </select>
            </Field>
            <Range label="语速" min={0.5} max={2} step={0.05} value={draft.minimax.speed} onChange={(v) => setField("minimax", { speed: v })} />
            <Range label="音量" min={0.1} max={10} step={0.1} value={draft.minimax.vol} onChange={(v) => setField("minimax", { vol: v })} />
            <Range label="音调" min={-12} max={12} step={1} value={draft.minimax.pitch} onChange={(v) => setField("minimax", { pitch: v })} />
            <Field label="情绪">{emotionSelect(draft.minimax.emotion, (v) => setField("minimax", { emotion: v }))}</Field>
          </>
        )}

        {P === "kling" && (
          <>
            <Field label="音色">
              <select className="vs-input" value={draft.kling.voiceId} onChange={(e) => setField("kling", { voiceId: e.target.value })}>
                {voiceOptions("kling")}
              </select>
            </Field>
            <Range label="语速" min={0.8} max={2} step={0.05} value={draft.kling.speed} onChange={(v) => setField("kling", { speed: v })} />
            <div className="vs-note sp-muted">可灵只认官方音色，单次最多 1000 字，没有情绪和音调参数。</div>
          </>
        )}

        {P === "vidu" && (
          <>
            <Field label="音色">
              <select className="vs-input" value={draft.vidu.voiceId} onChange={(e) => setField("vidu", { voiceId: e.target.value })}>
                {voiceOptions("vidu")}
              </select>
            </Field>
            <Range label="语速" min={0.5} max={2} step={0.05} value={draft.vidu.speed} onChange={(v) => setField("vidu", { speed: v })} />
            <Range label="音量" min={0} max={10} step={0.5} value={draft.vidu.volume} onChange={(v) => setField("vidu", { volume: v })} />
            <Range label="音调" min={-12} max={12} step={1} value={draft.vidu.pitch} onChange={(v) => setField("vidu", { pitch: v })} />
            <Field label="情绪">{emotionSelect(draft.vidu.emotion, (v) => setField("vidu", { emotion: v }))}</Field>
            <div className="vs-note sp-muted">Vidu 的语音合成底层是 MiniMax，音色 id 通用，实测比直接调 MiniMax 慢一倍。</div>
          </>
        )}
      </div>

      <div className="vs-try">
        <input className="vs-input vs-grow" value={previewText} onChange={(e) => setPreviewText(e.target.value)} aria-label="试听文本" />
        <button className="sp-ghost-btn" disabled={!!busy || !previewText.trim() || (!cfg.apiKey.set && !keyInput.trim())} onClick={() => void preview()}>
          {busy === "preview" ? "生成中…" : dirty ? "保存并试听" : "试听"}
        </button>
        <button className={`sp-ghost-btn${dirty ? " vs-primary" : ""}`} disabled={!dirty || !!busy} onClick={() => void save()}>
          {busy === "save" ? "保存中…" : "保存"}
        </button>
      </div>
      {audioUrl && <audio ref={audioRef} className="vs-audio" src={audioUrl} controls />}
      {msg && <div className={`vs-msg ${msg.tone === "err" ? "is-err" : "is-ok"}`}>{msg.text}</div>}

      <div className="vs-sub">
        <div className="vs-sub-title">我的音色</div>
        {cfg.customVoices.length === 0 && <div className="sp-muted">还没有。可以在下面新建，或者把已有的音色 id 手填进来。</div>}
        <ul className="vs-list">
          {cfg.customVoices.map((v) => {
            const isDefault = cfg.provider === v.provider && cfg[v.provider].voiceId === v.voiceId;
            return (
              <li key={`${v.provider}:${v.voiceId}`} className="vs-item">
                <span className="vs-badge">{KIND_LABEL[v.kind]}</span>
                <span className="vs-item-name" title={v.note}>{v.name}</span>
                <code className="vs-id">{presets.labels[v.provider]} · {v.voiceId}</code>
                <span className="vs-item-actions">
                  {isDefault
                    ? <span className="sp-ok">默认</span>
                    : <button className="sp-ghost-btn" disabled={!!busy} onClick={() => void useVoice(v)}>设为默认</button>}
                  <button className="sp-ghost-btn" disabled={!!busy} onClick={() => dropVoice(v)}>移除</button>
                </span>
              </li>
            );
          })}
        </ul>
        <AddVoiceForm presets={presets} busy={!!busy} onAdd={(entry) => run("add", async () => { apply(await addVoice(entry)); setMsg({ tone: "ok", text: `已登记「${entry.name || entry.voiceId}」` }); })} />
      </div>

      <details className="vs-sub vs-create">
        <summary className="vs-sub-title">新建音色（MiniMax，另收费）</summary>
        <div className="vs-fee">{FEE_NOTE}</div>
        <div className="vs-create-grid">
          <DesignForm disabled={!!busy || !cfg.apiKey.set} busy={busy === "design"} onSubmit={(a) => run("design", async () => {
            const r = await designVoice(a);
            apply(r.config);
            if (r.previewUrl) setAudioUrl(`${r.previewUrl}?t=${Date.now()}`);
            setMsg({ tone: "ok", text: `新音色 ${r.voiceId} 已加进「我的音色」。第一次用它合成时会扣 ¥9.9。` });
          })} />
          <CloneForm disabled={!!busy || !cfg.apiKey.set} busy={busy === "clone"} onSubmit={(file, a) => run("clone", async () => {
            const r = await cloneVoiceFromFile(file, a);
            apply(r.config);
            if (r.demoUrl) setAudioUrl(`${r.demoUrl}?t=${Date.now()}`);
            setMsg({ tone: "ok", text: `复刻好了：${r.voiceId}（用了 ${r.seconds.toFixed(1)} 秒人声）。第一次用它合成时会扣 ¥9.9。` });
          })} />
        </div>
        {!cfg.apiKey.set && <div className="sp-muted">先在上面填好 API Key 并保存。</div>}
      </details>
    </div>
  );
}

function Field(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="vs-field">
      <span className="vs-label">{props.label}</span>
      {props.children}
    </label>
  );
}

function Range(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }): JSX.Element {
  const { label, value, min, max, step, onChange } = props;
  return (
    <label className="vs-field">
      <span className="vs-label">{label}</span>
      <span className="vs-row">
        <input className="vs-range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="vs-num">{Number.isInteger(step) ? value : value.toFixed(2)}</span>
      </span>
    </label>
  );
}

function AddVoiceForm(props: { presets: VoicePresets; busy: boolean; onAdd: (e: { provider: Provider; voiceId: string; name: string }) => void }): JSX.Element {
  const { presets, busy, onAdd } = props;
  const [provider, setProvider] = useState<Provider>("minimax");
  const [voiceId, setVoiceId] = useState("");
  const [name, setName] = useState("");
  const submit = () => {
    if (!voiceId.trim()) return;
    onAdd({ provider, voiceId: voiceId.trim(), name: name.trim() });
    setVoiceId("");
    setName("");
  };
  return (
    <div className="vs-row vs-add">
      <select className="vs-input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)} aria-label="服务">
        {presets.providers.map((p) => <option key={p} value={p}>{presets.labels[p]}</option>)}
      </select>
      <input className="vs-input vs-grow" placeholder="音色 id，如 pcVideoMale1789119355225" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
      <input className="vs-input" placeholder="名字" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="sp-ghost-btn" disabled={busy || !voiceId.trim()} onClick={submit}>登记</button>
    </div>
  );
}

function DesignForm(props: { disabled: boolean; busy: boolean; onSubmit: (a: { prompt: string; previewText: string; name: string }) => void }): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [previewText, setPreviewText] = useState("注意看，这个男人叫小帅。他盯着屏幕上的进度条，已经整整三个小时没有眨眼。");
  const [name, setName] = useState("");
  const submit = () => {
    if (!confirm(`用这句描述建一个新音色？\n\n${prompt}\n\n${FEE_NOTE}`)) return;
    props.onSubmit({ prompt: prompt.trim(), previewText: previewText.trim(), name: name.trim() });
  };
  return (
    <div className="vs-card">
      <div className="vs-card-title">音色设计</div>
      <div className="sp-muted">用一句话描述想要的声音。</div>
      <textarea className="vs-input vs-area" rows={2} placeholder="例：年轻男声，影视解说腔，语速偏快，带一点悬念感" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <input className="vs-input" placeholder="试听文本" value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
      <div className="vs-row">
        <input className="vs-input vs-grow" placeholder="名字" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="sp-ghost-btn" disabled={props.disabled || !prompt.trim() || !previewText.trim()} onClick={submit}>
          {props.busy ? "设计中…" : "设计"}
        </button>
      </div>
    </div>
  );
}

function CloneForm(props: { disabled: boolean; busy: boolean; onSubmit: (file: File, a: { name: string; previewText: string }) => void }): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [previewText, setPreviewText] = useState("任务完成了。三十二个测试全部通过，你回来看一下就行。");
  const [consent, setConsent] = useState(false);
  const submit = () => {
    if (!file) return;
    if (!confirm(`用「${file.name}」里的人声复刻一个新音色？\n\n${FEE_NOTE}`)) return;
    props.onSubmit(file, { name: name.trim(), previewText: previewText.trim() });
  };
  return (
    <div className="vs-card">
      <div className="vs-card-title">声音复刻</div>
      <div className="sp-muted">音频或视频都行，至少 10 秒清楚的单人说话，最多取前 5 分钟。</div>
      <input className="vs-file" type="file" accept="audio/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <input className="vs-input" placeholder="试听文本（可空）" value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
      <label className="vs-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>这是我本人的声音，或者已经得到本人同意</span>
      </label>
      <div className="vs-row">
        <input className="vs-input vs-grow" placeholder="名字" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="sp-ghost-btn" disabled={props.disabled || !file || !consent} onClick={submit}>
          {props.busy ? "复刻中…" : "复刻"}
        </button>
      </div>
    </div>
  );
}
