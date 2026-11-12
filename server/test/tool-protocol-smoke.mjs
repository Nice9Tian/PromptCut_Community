import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';
import { tools } from '../mcp-tools.mjs';
import { startRun } from './fake-runner.mjs';

process.env.PROMPTCUT_TEST_PROTOCOL = '1';

async function main() {
  const events = [];
  let callToolCount = 0;
  
  const callTool = async (name, args) => {
    callToolCount++;
    return { status: "mocked" };
  };

  const opts = {
    prompt: "Start",
    systemPrompt: "System prompt",
    sessionId: null,
    callTool,
    onEvent: (ev) => {
      events.push(ev);
    }
  };

  const run = runTextProtocolLoop({ startRun, opts, onEvent: opts.onEvent, tools });
  await run.done;
  
  console.log("=== Event log ===");
  events.forEach(e => {
    if (e.type === 'text') {
      console.log(`[text] ${e.delta.replace(/\n/g, '\\n')}`);
    } else {
      console.log(`[${e.type}]`, JSON.stringify(e));
    }
  });
  
  // Assertions
  let passed = true;
  const statusEvents = events.filter(e => e.type === 'status');
  if (statusEvents.some(e => e.text === 'Text protocol reached the limit of 8 rounds')) {
     console.log("✅ 8-round limit took effect");
  } else {
     console.log("❌ 8-round limit did not take effect");
     passed = false;
  }
  
  const toolCallEvents = events.filter(e => e.type === 'tool_call');
  if (toolCallEvents.length === 8 * 2) { 
     console.log("✅ Fences parsed correctly");
  } else {
     console.log(`❌ Wrong number of fences parsed, expected 16, actual ${toolCallEvents.length}`);
     passed = false;
  }
  
  const toolResultEvents = events.filter(e => e.type === 'tool_result');
  const unregistered = toolResultEvents.filter(e => e.name === 'bad_tool');
  if (unregistered.length > 0 && unregistered[0].ok === false && /unregistered|not registered/i.test(unregistered[0].summary)) {
     console.log("✅ Unregistered tool was rejected");
  } else {
     console.log("❌ Unregistered tool was not rejected correctly");
     passed = false;
  }
  
  const badJson = toolResultEvents.filter(e => e.summary.includes('JSON parse failed'));
  if (badJson.length > 0 && badJson[0].ok === false) {
     console.log("✅ Bad JSON was caught and fed back");
  } else {
     console.log("❌ Failed to catch bad JSON");
     passed = false;
  }
  
  // callToolCount should be exactly 8 (only stt_status is called, once per round)
  if (callToolCount === 8) {
     console.log("✅ callTool only for valid tool calls");
  } else {
     console.log(`❌ callTool was called ${callToolCount} times`);
     passed = false;
  }
  
  if (!passed) process.exit(1);
}

main().catch(console.error);
