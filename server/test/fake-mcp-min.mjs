import readline from 'node:readline';

const FIXED = {
  curT: 0,
  duration: 60,
  playing: false,
  trackCount: 2,
  cards: [
    { id: "card-1", kind: "punch-pill", name: "金句卡", start: 3, end: 8, track: 0 },
    { id: "card-2", kind: "term-card", name: "术语卡", start: 12, end: 18, track: 1 }
  ]
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      const resp = {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion || "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "promptcut", version: "0.0.1-fake" }
        }
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
    } else if (req.method === 'notifications/initialized' || (!req.id && req.method)) {
      // ignore
    } else if (req.method === 'tools/list') {
      const resp = {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [{
            name: "get_editor_state",
            description: "读取编辑台当前状态",
            inputSchema: { type: "object", properties: {}, required: [] }
          }]
        }
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
    } else if (req.method === 'tools/call' && req.params?.name === 'get_editor_state') {
      const resp = {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(FIXED, null, 2) }]
        }
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
    } else if (req.id) {
      const resp = {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Method not found" }
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
  } catch (e) {
    console.error(e);
  }
});
