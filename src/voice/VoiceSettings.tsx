import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import "./VoiceSettings.css";
import {
  getVoiceConfig, saveVoiceConfig, clearVoiceKey, generateVoice, addVoice, removeVoice, designVoice, cloneVoiceFromFile,
  type VoiceConfig, type VoicePresets, type Provider, type CustomVoice,
} from "../ai/voice";
import { tr } from "../i18n/index.ts";

/** The part currently being edited in the UI; the API key is kept separate and only included when saving */
type Draft = Pick<VoiceConfig, "baseUrl" | "provider" | "minimax" | "kling" | "vidu">;

const pick = (c: VoiceConfig): Draft => ({
  baseUrl: c.baseUrl, provider: c.provider,
  minimax: { ...c.minimax }, kling: { ...c.kling }, vidu: { ...c.vidu },
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const KIND_LABEL: Record<CustomVoice["kind"], string> = { clone: tr("Clone"), design: tr("Design"), manual: tr("Manual") };

const FEE_NOTE = tr("The first time each new voice is used for synthesis, MiniMax charges an extra ¥9.9; a voice not used within 7 days of creation is deleted.");

/**
 * "Voiceover" on the start page: the agent voice_generate uses the service, voice, and parameters here by default.
 *
 * Click "Save" after editing to take effect (audition saves for you first). Creating a new voice costs money, so confirm every step first.
 * Lives inside the "Voiceover settings" subwindow (bare: removes its own border and title, provided by the window).
 */
export function VoiceSettings(props: { bare?: boolean; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const { bare, onDirtyChange } = props;
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [presets, setPresets] = useState<VoicePresets | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [previewText, setPreviewText] = useState(tr("Task complete. All thirty-two tests passed, just come back and take a look."));
  const [audioUrl, setAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    getVoiceConfig()
      .then(({ config, presets }) => { setCfg(config); setPresets(presets); setDraft(pick(config)); })
      .catch((e) => setMsg({ tone: "err", text: tr("Can't read voiceover settings: {0}", errText(e)) }));
  }, []);

  // Play as soon as a new audition arrives
  useEffect(() => { if (audioUrl) void audioRef.current?.play().catch(() => {}); }, [audioUrl]);

  const dirty = !!cfg && !!draft && (JSON.stringify(pick(cfg)) !== JSON.stringify(draft) || !!keyInput.trim());
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const rootClass = `vs${bare ? " is-bare" : ""}`;
  if (!cfg || !presets || !draft) {
    return <div className={rootClass}>{msg ? <div className="vs-msg is-err">{msg.text}</div> : <span className="sp-muted">{tr("Loading voiceover settings…")}</span>}</div>;
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

  const save = () => run("save", async () => { await persist(); setMsg({ tone: "ok", text: tr("Saved. Agent voiceover will use these settings.") }); });

  const preview = () => run("preview", async () => {
    if (dirty) await persist();
    const r = await generateVoice({ text: previewText }, { preview: true });
    setAudioUrl(`${r.url}?t=${Date.now()}`);
    setMsg({ tone: "ok", text: tr("{0} · {1} · {2} chars · generated in {3} s", tr(presets.labels[r.provider]), r.voiceId, r.chars, (r.ms / 1000).toFixed(1)) });
  });

  const clearKey = () => {
    if (!confirm(tr("Delete the API Key used for voiceover? Voiceover will fail until you enter a new one."))) return;
    void run("key", async () => { apply(await clearVoiceKey()); setMsg({ tone: "ok", text: tr("API Key deleted") }); });
  };

  const voiceOptions = (p: Provider) => {
    const mine = cfg.customVoices.filter((v) => v.provider === p);
    return (
      <>
        {mine.length > 0 && (
          <optgroup label={tr("My voices")}>
            {mine.map((v) => <option key={v.voiceId} value={v.voiceId}>{tr("{0} ({1})", v.name, KIND_LABEL[v.kind])}</option>)}
          </optgroup>
        )}
        <optgroup label={tr("System voices")}>
          {presets.systemVoices[p].map((v) => <option key={v.voiceId} value={v.voiceId}>{tr(v.name)} · {v.voiceId}</option>)}
        </optgroup>
      </>
    );
  };

  const emotionSelect = (value: string, onChange: (v: string) => void) => (
    <select className="vs-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {presets.emotions.map((e) => <option key={e} value={e}>{tr(presets.emotionLabels[e] ?? e)}</option>)}
    </select>
  );

  const useVoice = (v: CustomVoice) => run("use", async () => {
    apply(await saveVoiceConfig({ provider: v.provider, [v.provider]: { voiceId: v.voiceId } }));
    setMsg({ tone: "ok", text: tr("Default voice changed to \"{0}\"", v.name) });
  });

  const dropVoice = (v: CustomVoice) => {
    if (!confirm(tr("Remove \"{0}\" from the list? This only deletes the record here; the voice at the provider is not deleted. After that, the agent can no longer use it.", v.name))) return;
    void run("drop", async () => { apply(await removeVoice(v.provider, v.voiceId)); });
  };

  return (
    <div className={rootClass}>
      <div className="vs-head">
        <div className="vs-head-text">
          {!bare && <div className="vs-title">{tr("Cloud voiceover · voice_generate")}</div>}
          <div className="sp-muted">{tr("When the agent turns text into speech, it uses the service and voice set here by default; it goes through the API and is billed by character count.")}</div>
        </div>
        <div className="vs-seg" role="group" aria-label={tr("Default service")}>
          {presets.providers.map((p) => (
            <button key={p} className="vs-seg-btn" aria-pressed={P === p} onClick={() => setDraft({ ...draft, provider: p })}>
              {tr(presets.labels[p])}
            </button>
          ))}
        </div>
      </div>

      <div className="vs-grid">
        <Field label="API Key">
          <div className="vs-row">
            <input
              className="vs-input vs-grow" type="password" autoComplete="off" value={keyInput}
              placeholder={cfg.apiKey.set ? tr("Set (···{0}), leave blank to keep", cfg.apiKey.last4) : tr("Paste the voiceover API Key sk-…")}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            {cfg.apiKey.set && <button className="sp-ghost-btn" disabled={!!busy} onClick={clearKey}>{tr("Delete")}</button>}
          </div>
        </Field>
        <Field label={tr("API URL")}>
          <input
            className="vs-input" value={draft.baseUrl}
            placeholder={cfg.effectiveBaseUrl ? tr("Leave blank to follow API settings ({0})", cfg.effectiveBaseUrl) : tr("https://… (no URL set in API settings either)")}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
        </Field>

        {P === "minimax" && (
          <>
            <Field label={tr("Model")}>
              <select className="vs-input" value={draft.minimax.model} onChange={(e) => setField("minimax", { model: e.target.value })}>
                {presets.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field label={tr("Voice")}>
              <select className="vs-input" value={draft.minimax.voiceId} onChange={(e) => setField("minimax", { voiceId: e.target.value })}>
                {voiceOptions("minimax")}
              </select>
            </Field>
            <Range label={tr("Speed")} min={0.5} max={2} step={0.05} value={draft.minimax.speed} onChange={(v) => setField("minimax", { speed: v })} />
            <Range label={tr("Volume")} min={0.1} max={10} step={0.1} value={draft.minimax.vol} onChange={(v) => setField("minimax", { vol: v })} />
            <Range label={tr("Pitch")} min={-12} max={12} step={1} value={draft.minimax.pitch} onChange={(v) => setField("minimax", { pitch: v })} />
            <Field label={tr("Emotion")}>{emotionSelect(draft.minimax.emotion, (v) => setField("minimax", { emotion: v }))}</Field>
          </>
        )}

        {P === "kling" && (
          <>
            <Field label={tr("Voice")}>
              <select className="vs-input" value={draft.kling.voiceId} onChange={(e) => setField("kling", { voiceId: e.target.value })}>
                {voiceOptions("kling")}
              </select>
            </Field>
            <Range label={tr("Speed")} min={0.8} max={2} step={0.05} value={draft.kling.speed} onChange={(v) => setField("kling", { speed: v })} />
            <div className="vs-note sp-muted">{tr("Kling only accepts official voices, up to 1000 characters per request, and has no emotion or pitch parameters.")}</div>
          </>
        )}

        {P === "vidu" && (
          <>
            <Field label={tr("Voice")}>
              <select className="vs-input" value={draft.vidu.voiceId} onChange={(e) => setField("vidu", { voiceId: e.target.value })}>
                {voiceOptions("vidu")}
              </select>
            </Field>
            <Range label={tr("Speed")} min={0.5} max={2} step={0.05} value={draft.vidu.speed} onChange={(v) => setField("vidu", { speed: v })} />
            <Range label={tr("Volume")} min={0} max={10} step={0.5} value={draft.vidu.volume} onChange={(v) => setField("vidu", { volume: v })} />
            <Range label={tr("Pitch")} min={-12} max={12} step={1} value={draft.vidu.pitch} onChange={(v) => setField("vidu", { pitch: v })} />
            <Field label={tr("Emotion")}>{emotionSelect(draft.vidu.emotion, (v) => setField("vidu", { emotion: v }))}</Field>
            <div className="vs-note sp-muted">{tr("Vidu's speech synthesis runs on MiniMax underneath, voice ids are interchangeable, and in testing it is twice as slow as calling MiniMax directly.")}</div>
          </>
        )}
      </div>

      <div className="vs-try">
        <input className="vs-input vs-grow" value={previewText} onChange={(e) => setPreviewText(e.target.value)} aria-label={tr("Preview text")} />
        <button className="sp-ghost-btn" disabled={!!busy || !previewText.trim() || (!cfg.apiKey.set && !keyInput.trim())} onClick={() => void preview()}>
          {busy === "preview" ? tr("Generating…") : dirty ? tr("Save and preview") : tr("Preview")}
        </button>
        <button className={`sp-ghost-btn${dirty ? " vs-primary" : ""}`} disabled={!dirty || !!busy} onClick={() => void save()}>
          {busy === "save" ? tr("Saving…") : tr("Save")}
        </button>
      </div>
      {audioUrl && <audio ref={audioRef} className="vs-audio" src={audioUrl} controls />}
      {msg && <div className={`vs-msg ${msg.tone === "err" ? "is-err" : "is-ok"}`}>{msg.text}</div>}

      <div className="vs-sub">
        <div className="vs-sub-title">{tr("My voices")}</div>
        {cfg.customVoices.length === 0 && <div className="sp-muted">{tr("None yet. Create one below, or enter an existing voice id by hand.")}</div>}
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
                    ? <span className="sp-ok">{tr("Default")}</span>
                    : <button className="sp-ghost-btn" disabled={!!busy} onClick={() => void useVoice(v)}>{tr("Set as default")}</button>}
                  <button className="sp-ghost-btn" disabled={!!busy} onClick={() => dropVoice(v)}>{tr("Remove")}</button>
                </span>
              </li>
            );
          })}
        </ul>
        <AddVoiceForm presets={presets} busy={!!busy} onAdd={(entry) => run("add", async () => { apply(await addVoice(entry)); setMsg({ tone: "ok", text: tr("Registered \"{0}\"", entry.name || entry.voiceId) }); })} />
      </div>

      <details className="vs-sub vs-create">
        <summary className="vs-sub-title">{tr("Create voice (MiniMax, extra charge)")}</summary>
        <div className="vs-fee">{FEE_NOTE}</div>
        <div className="vs-create-grid">
          <DesignForm disabled={!!busy || !cfg.apiKey.set} busy={busy === "design"} onSubmit={(a) => run("design", async () => {
            const r = await designVoice(a);
            apply(r.config);
            if (r.previewUrl) setAudioUrl(`${r.previewUrl}?t=${Date.now()}`);
            setMsg({ tone: "ok", text: tr("New voice {0} was added to \"My voices\". The first synthesis with it will charge ¥9.9.", r.voiceId) });
          })} />
          <CloneForm disabled={!!busy || !cfg.apiKey.set} busy={busy === "clone"} onSubmit={(file, a) => run("clone", async () => {
            const r = await cloneVoiceFromFile(file, a);
            apply(r.config);
            if (r.demoUrl) setAudioUrl(`${r.demoUrl}?t=${Date.now()}`);
            setMsg({ tone: "ok", text: tr("Clone ready: {0} (used {1} s of human voice). The first synthesis with it will charge ¥9.9.", r.voiceId, r.seconds.toFixed(1)) });
          })} />
        </div>
        {!cfg.apiKey.set && <div className="sp-muted">{tr("Enter the API Key above and save first.")}</div>}
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
      <select className="vs-input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)} aria-label={tr("Service")}>
        {presets.providers.map((p) => <option key={p} value={p}>{tr(presets.labels[p])}</option>)}
      </select>
      <input className="vs-input vs-grow" placeholder={tr("Voice id, e.g. pcVideoMale1789119355225")} value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
      <input className="vs-input" placeholder={tr("Name")} value={name} onChange={(e) => setName(e.target.value)} />
      <button className="sp-ghost-btn" disabled={busy || !voiceId.trim()} onClick={submit}>{tr("Register")}</button>
    </div>
  );
}

function DesignForm(props: { disabled: boolean; busy: boolean; onSubmit: (a: { prompt: string; previewText: string; name: string }) => void }): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [previewText, setPreviewText] = useState(tr("Look closely, this man is called Xiaoshuai. He stares at the progress bar on the screen and hasn't blinked for a full three hours."));
  const [name, setName] = useState("");
  const submit = () => {
    if (!confirm(tr("Create a new voice from this description?\n\n{0}\n\n{1}", prompt, FEE_NOTE))) return;
    props.onSubmit({ prompt: prompt.trim(), previewText: previewText.trim(), name: name.trim() });
  };
  return (
    <div className="vs-card">
      <div className="vs-card-title">{tr("Voice design")}</div>
      <div className="sp-muted">{tr("Describe the voice you want in one sentence.")}</div>
      <textarea className="vs-input vs-area" rows={2} placeholder={tr("e.g. young male voice, movie-commentary style, fairly fast, with a touch of suspense")} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <input className="vs-input" placeholder={tr("Preview text")} value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
      <div className="vs-row">
        <input className="vs-input vs-grow" placeholder={tr("Name")} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="sp-ghost-btn" disabled={props.disabled || !prompt.trim() || !previewText.trim()} onClick={submit}>
          {props.busy ? tr("Designing…") : tr("Design")}
        </button>
      </div>
    </div>
  );
}

function CloneForm(props: { disabled: boolean; busy: boolean; onSubmit: (file: File, a: { name: string; previewText: string }) => void }): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [previewText, setPreviewText] = useState(tr("Task complete. All thirty-two tests passed, just come back and take a look."));
  const [consent, setConsent] = useState(false);
  const submit = () => {
    if (!file) return;
    if (!confirm(tr("Clone a new voice from the speaker in \"{0}\"?\n\n{1}", file.name, FEE_NOTE))) return;
    props.onSubmit(file, { name: name.trim(), previewText: previewText.trim() });
  };
  return (
    <div className="vs-card">
      <div className="vs-card-title">{tr("Voice cloning")}</div>
      <div className="sp-muted">{tr("Audio or video both work. At least 10 seconds of clear single-speaker speech; only the first 5 minutes are used.")}</div>
      <input className="vs-file" type="file" accept="audio/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <input className="vs-input" placeholder={tr("Preview text (optional)")} value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
      <label className="vs-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{tr("This is my own voice, or I have the speaker's consent")}</span>
      </label>
      <div className="vs-row">
        <input className="vs-input vs-grow" placeholder={tr("Name")} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="sp-ghost-btn" disabled={props.disabled || !file || !consent} onClick={submit}>
          {props.busy ? tr("Cloning…") : tr("Clone")}
        </button>
      </div>
    </div>
  );
}
