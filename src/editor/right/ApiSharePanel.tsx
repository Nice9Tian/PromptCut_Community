import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { AiConfigPatch, KeyState } from "../../ai/types";
import { copyDebugReport } from "../../ai/debug";
import { decryptConfig, looksLikeShareBlob, type SharedApiConfig } from "../../ai/configShare";
import { tr } from "../../i18n/index.ts";

/**
 * Receives a distributed API configuration.
 *
 * Flow: send the "machine ID" to the distributor → the distributor encrypts with it as the
 * passphrase → you paste the ciphertext in, and this machine decrypts it automatically and writes it
 * into the configuration. Only this machine can decrypt the ciphertext, so forwarding it to anyone
 * else is useless.
 *
 * The end that produces the ciphertext is not here: that is the distributor's own business, done
 * with tools/make-api-share.py in the repository. The software keeps only the receiving side, so
 * that "who may distribute keys" does not become a button anyone can click.
 */
export function ApiSharePanel(props: {
  onSaveConfig: (patch: AiConfigPatch) => Promise<void>;
  /** Whether a Key is stored for the Router route (masked) */
  saved?: KeyState | null;
  /** The Router route is the one currently in effect */
  active?: boolean;
  clearing?: boolean;
  onClear?: () => void;
  clearMsg?: string;
}): JSX.Element {
  const { onSaveConfig, saved, active, clearing, onClear, clearMsg } = props;
  const [machineCode, setMachineCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [blob, setBlob] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [needPassphrase, setNeedPassphrase] = useState(false);
  const [parsed, setParsed] = useState<SharedApiConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/ai/machine-code")
      .then((r) => r.json())
      .then((d) => setMachineCode(d.ok ? d.code : null))
      .catch(() => setMachineCode(null));
  }, []);

  const copyCode = async () => {
    if (!machineCode) return;
    try {
      await copyDebugReport(machineCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const attempt = async (text: string, password: string) => {
    setBusy(true);
    setError("");
    setParsed(null);
    try {
      setParsed(await decryptConfig(text, password));
      setNeedPassphrase(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : tr("Cannot decrypt");
      setError(message);
      // A wrong passphrase usually means the distributor used the agreed passphrase instead of the machine ID, so reveal the input box
      if (message.startsWith(tr("Cannot decrypt"))) setNeedPassphrase(true);
    } finally {
      setBusy(false);
    }
  };

  // On paste, try the local machine ID automatically, no extra click needed
  const onBlobChange = (text: string) => {
    setBlob(text);
    setDone(false);
    setParsed(null);
    setError("");
    if (looksLikeShareBlob(text) && machineCode) void attempt(text, machineCode);
  };

  const apply = async () => {
    if (!parsed) return;
    setBusy(true);
    setError("");
    try {
      await onSaveConfig({
        api: {
          // Write the connection config explicitly into the Router route (profiles.router), leaving the one filled in on the custom tab alone
          profiles: { router: { vendor: parsed.vendor, baseUrl: parsed.baseUrl, model: parsed.model } },
          ...(parsed.maxTokens ? { maxTokens: parsed.maxTokens } : {}),
          apiKey: parsed.apiKey,
          // Write it into the Router route (keys/router.key, PCRTR1. wrapped), stored separately from the custom API's Key
          source: "router",
        },
        defaultProvider: "api",
      });
      setDone(true);
      setBlob("");
      setParsed(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Failed to write config"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ais-share">
      {saved?.set && (
        <div className="ais-api-saved-key">
          <span>{tr("Imported ••••{0}{1}", saved.last4, active ? tr("(active)") : tr("(the active one is the custom API entry)"))}</span>
          {onClear && (
            <button className="ais-btn ais-danger-btn" disabled={!!clearing} onClick={(e) => { e.preventDefault(); onClear(); }} title={tr("Delete keys/router.key")}>
              {clearing ? tr("Clearing…") : tr("Clear key")}
            </button>
          )}
        </div>
      )}
      {clearMsg && <div className="ais-detail">{clearMsg}</div>}
      <div className="ais-share-code">
        <span className="ais-detail">{tr("Machine ID")}</span>
        <code>{machineCode ?? tr("Loading…")}</code>
        {machineCode && (
          <button className="ais-btn" onClick={(e) => { e.preventDefault(); copyCode(); }}>
            {copied ? tr("Copied") : tr("Duplicate")}
          </button>
        )}
      </div>
      <div className="ais-detail">
        {tr("This code identifies only this machine and contains no keys. Send it to the distributor, who encrypts with it; the ciphertext can then only be decrypted on this machine.")}
      </div>

      <textarea
        className="ais-share-blob"
        value={blob}
        onChange={(e) => onBlobChange(e.target.value)}
        placeholder={tr("Paste the whole ciphertext from the distributor here (starts with PCAI1.)")}
        spellCheck={false}
        rows={3}
      />
      {needPassphrase && (
        <div className="ais-api-field">
          <input
            type="text"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={tr("If the distributor used an agreed passphrase instead of the machine ID, enter it here")}
          />
          <button className="ais-btn" disabled={busy || !passphrase} onClick={(e) => { e.preventDefault(); attempt(blob, passphrase); }}>
            {tr("Retry with this passphrase")}
          </button>
        </div>
      )}
      {busy && <div className="ais-detail">{tr("Decrypting… (runs a slow hash, about a second or two)")}</div>}
      {error && <div className="ais-fixhint">{error}</div>}
      {done && <span className="ais-status-ok">{tr("Imported and saved, ready to use")}</span>}
      {parsed && (
        <div className="ais-share-preview">
          <div className="ais-detail">{tr("Decrypted. Confirm it is correct before writing:")}</div>
          <dl>
            <dt>{tr("Vendor")}</dt><dd>{parsed.vendor}</dd>
            <dt>{tr("Address")}</dt><dd>{parsed.baseUrl || tr("(default)")}</dd>
            <dt>{tr("Model")}</dt><dd>{parsed.model || tr("(not specified)")}</dd>
            <dt>Key</dt><dd>••••{parsed.apiKey.slice(-4)}</dd>
            {parsed.expiresAt ? <><dt>{tr("Valid until")}</dt><dd>{new Date(parsed.expiresAt).toLocaleDateString()}</dd></> : null}
            {parsed.note ? <><dt>{tr("Message")}</dt><dd>{parsed.note}</dd></> : null}
          </dl>
          <button className="ais-btn ais-primary-btn" disabled={busy} onClick={(e) => { e.preventDefault(); apply(); }}>
            {tr("Import and save")}
          </button>
        </div>
      )}
    </div>
  );
}
