export async function listProviders() {
  return [
    { id: "claude", label: "Claude Code", available: true, version: "2.1.221" },
    { id: "agy", label: "Antigravity", available: true, version: "1.1.27" },
    { id: "codex", label: "Codex", available: true, version: "0.136.0" }
  ];
}

export function startRun(opts) {
  let isAborted = false;
  let isFinished = false;
  let onEvent = opts.onEvent;
  
  let abortResolve = null;
  // eslint-disable-next-line no-async-promise-executor -- fake runner uses await to order events, for testing
  const donePromise = new Promise(async (resolve) => {
    abortResolve = resolve;
    
    if (process.env.PROMPTCUT_TEST_PROTOCOL === '1') {
       if (isAborted) return resolve();
       onEvent({ type: "session", sessionId: "fake-protocol-session" });
       await new Promise(r => setTimeout(r, 10));
       
       if (opts.prompt.includes("[Round 8]")) {
          // This should never happen if 8 limit works, but just in case
          onEvent({ type: "text", delta: "Finished\n" });
       } else {
          // Output blocks
          const txt = "I will call two tools\n```promptcut-tool\n{\"name\":\"stt_status\"}\n```\nand there is also a wrong tool\n```promptcut-tool\n{\"name\":\"bad_tool\"}\n```\nand there is also a broken JSON\n```promptcut-tool\n{\"name\"\n```\n";
          onEvent({ type: "text", delta: txt });
       }
       onEvent({ type: "done", sessionId: "fake-protocol-session" });
       isFinished = true;
       return resolve();
    }

    if (isAborted) { isFinished = true; return resolve(); }
    onEvent({ type: "session", sessionId: "fake-session-123" });
    
    await new Promise(r => setTimeout(r, 100));
    if (isAborted) { isFinished = true; return resolve(); }
    onEvent({ type: "text", delta: "Carrying out the operation for you...\n" });
    
    await new Promise(r => setTimeout(r, 100));
    if (isAborted) { isFinished = true; return resolve(); }
    onEvent({ type: "tool_call", name: "get_editor_state", input: {} });
    onEvent({ type: "tool_result", name: "get_editor_state", ok: true, summary: "Fetched successfully" });
    
    await new Promise(r => setTimeout(r, 100));
    if (isAborted) { isFinished = true; return resolve(); }
    onEvent({ type: "done", sessionId: "fake-session-123", usage: { tokens: 100 } });
    
    isFinished = true;
    resolve();
  });

  return {
    abort() {
      if (isFinished) return;
      isAborted = true;
      onEvent({ type: "error", message: "Aborted by user" });
      if (abortResolve) abortResolve();
    },
    done: donePromise
  };
}
