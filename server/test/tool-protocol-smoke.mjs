import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';
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
    prompt: "开始",
    systemPrompt: "系统提示",
    sessionId: null,
    callTool,
    onEvent: (ev) => {
      events.push(ev);
    }
  };

  const run = runTextProtocolLoop({ startRun, opts, onEvent: opts.onEvent });
  await run.done;
  
  console.log("=== 事件日志 ===");
  events.forEach(e => {
    if (e.type === 'text') {
      console.log(`[text] ${e.delta.replace(/\n/g, '\\n')}`);
    } else {
      console.log(`[${e.type}]`, JSON.stringify(e));
    }
  });
  
  // 断言
  let passed = true;
  const statusEvents = events.filter(e => e.type === 'status');
  if (statusEvents.some(e => e.text === '文本协议已达 8 轮上限')) {
     console.log("✅ 8轮上限生效");
  } else {
     console.log("❌ 8轮上限未生效");
     passed = false;
  }
  
  const toolCallEvents = events.filter(e => e.type === 'tool_call');
  if (toolCallEvents.length === 8 * 2) { 
     console.log("✅ 围栏被正确解析");
  } else {
     console.log(`❌ 围栏解析数量不对，预期 16，实际 ${toolCallEvents.length}`);
     passed = false;
  }
  
  const toolResultEvents = events.filter(e => e.type === 'tool_result');
  const unregistered = toolResultEvents.filter(e => e.name === 'bad_tool');
  if (unregistered.length > 0 && unregistered[0].ok === false && unregistered[0].summary.includes('未注册')) {
     console.log("✅ 未注册工具被拒绝");
  } else {
     console.log("❌ 未注册工具未被正确拒绝");
     passed = false;
  }
  
  const badJson = toolResultEvents.filter(e => e.summary.includes('JSON 解析失败'));
  if (badJson.length > 0 && badJson[0].ok === false) {
     console.log("✅ 坏JSON被捕捉并回灌");
  } else {
     console.log("❌ 坏JSON捕捉失败");
     passed = false;
  }
  
  // callToolCount should be exactly 8 (only stt_status is called, once per round)
  if (callToolCount === 8) {
     console.log("✅ callTool只对合法工具调用");
  } else {
     console.log(`❌ callTool被调用了 ${callToolCount} 次`);
     passed = false;
  }
  
  if (!passed) process.exit(1);
}

main().catch(console.error);
