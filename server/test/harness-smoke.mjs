import { startRun } from '../runners/api.mjs';
import { createTextEditorTool } from '../harness/tools/textEditor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let fails = 0;
function runTest(name, fn) {
  try {
    const p = fn();
    if (p instanceof Promise) {
      return p.then(() => {
        console.log(`PASS: ${name}`);
      }).catch(err => {
        console.error(`FAIL: ${name}\n${err.stack || err}`);
        fails++;
      });
    } else {
      console.log(`PASS: ${name}`);
    }
  } catch (err) {
    console.error(`FAIL: ${name}\n${err.stack || err}`);
    fails++;
  }
}

async function main() {
  let mockEvents = [];
  let sessionId = '';
  let mockHistoryFile = '';
  let cwdMock = '';
  
  await runTest('Group 1 - Setup Mock', async () => {
    cwdMock = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-mock-'));
    const { done } = startRun({
      provider: 'api',
      apiConfig: { vendor: 'mock', model: 'mock-1' },
      prompt: '时间轴上有什么',
      systemPrompt: '测试',
      cwd: cwdMock,
      callTool: async (name, _args) => {
        if (name === 'get_editor_state') return { curT: 0, duration: 60, cards: [{id: 'c1'}, {id: 'c2'}] };
        throw new Error('unknown');
      },
      onEvent: (ev) => mockEvents.push(ev)
    });
    await done;
  });

  await runTest('Group 1 - Session event present', () => {
    const s = mockEvents.find(e => e.type === 'session');
    if (!s) throw new Error('Missing session event');
    if (mockEvents[0].type !== 'session') throw new Error('Session event is not the first event');
    sessionId = s.sessionId;
    mockHistoryFile = path.join(os.tmpdir(), 'promptcut', 'harness-sessions', `${sessionId}.json`);
  });

  await runTest('Group 1 - tool_call get_editor_state present', () => {
    if (!mockEvents.some(e => e.type === 'tool_call' && e.name === 'get_editor_state')) throw new Error('Missing tool_call');
  });

  await runTest('Group 1 - tool_result present', () => {
    if (!mockEvents.some(e => e.type === 'tool_result' && e.ok === true)) throw new Error('Missing successful tool_result');
  });

  await runTest('Group 1 - text event present', () => {
    if (!mockEvents.some(e => e.type === 'text')) throw new Error('Missing text event');
  });

  await runTest('Group 1 - done event present', () => {
    if (!mockEvents.some(e => e.type === 'done')) throw new Error('Missing done event');
    if (mockEvents[mockEvents.length - 1].type !== 'done') throw new Error('Done event is not the last event');
  });

  await runTest('Group 1 - Clean up and apiKey absent', () => {
    const historyContent = fs.readFileSync(mockHistoryFile, 'utf8');
    if (historyContent.includes('apiKey')) throw new Error('History contains apiKey');
    fs.unlinkSync(mockHistoryFile);
    fs.rmSync(cwdMock, { recursive: true, force: true });
  });


  await runTest('Group 2 - Text Editor tests', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-te-'));
    const tool = createTextEditorTool(cwd);
    
    // 1. create 新文件 → 再 view 能看到带行号的内容
    await tool.execute({ command: 'create', path: 'test.txt', file_text: 'hello\nworld' });
    const view = await tool.execute({ command: 'view', path: 'test.txt' });
    if (!view.includes('     1\thello')) throw new Error('view output incorrect');
    
    // 2. create 同名文件 → 抛错(文件已存在)
    try {
      await tool.execute({ command: 'create', path: 'test.txt', file_text: 'fail' });
      throw new Error('should fail on existing file');
    } catch (e) {
      if (!e.message.includes('文件已存在')) throw e;
    }
    
    // 3. str_replace 唯一命中 → 内容变了; 命中 0 次 / 多次抛错
    await tool.execute({ command: 'str_replace', path: 'test.txt', old_str: 'hello', new_str: 'hi' });
    const view2 = await tool.execute({ command: 'view', path: 'test.txt' });
    if (!view2.includes('hi')) throw new Error('str_replace failed');
    try {
      await tool.execute({ command: 'str_replace', path: 'test.txt', old_str: 'foo', new_str: 'bar' });
      throw new Error('should fail on 0 matches');
    } catch (e) {
      if (!e.message.includes('没有找到要替换的内容')) throw e;
    }
    
    // 4. insert 在第 1 行后插入 → 行数加一且位置正确
    await tool.execute({ command: 'insert', path: 'test.txt', insert_line: 1, new_str: 'inserted' });
    const view3 = await tool.execute({ command: 'view', path: 'test.txt' });
    if (!view3.includes('     2\tinserted')) throw new Error('insert failed');
    
    // 5. undo_edit → 恢复到 insert 之前的内容
    await tool.execute({ command: 'undo_edit', path: 'test.txt' });
    const view4 = await tool.execute({ command: 'view', path: 'test.txt' });
    if (view4.includes('inserted')) throw new Error('undo_edit failed to revert insert');
    
    await tool.execute({ command: 'undo_edit', path: 'test.txt' });
    const view5 = await tool.execute({ command: 'view', path: 'test.txt' });
    if (!view5.includes('hello')) throw new Error('undo_edit failed to revert str_replace');
    
    await tool.execute({ command: 'undo_edit', path: 'test.txt' });
    if (fs.existsSync(path.join(cwd, 'test.txt'))) throw new Error('undo_edit failed to revert create');
    
    try {
      await tool.execute({ command: 'undo_edit', path: 'test.txt' });
      throw new Error('should fail on empty stack');
    } catch (e) {
      if (!e.message.includes('没有可撤销的编辑')) throw e;
    }
    
    // 6. 越界路径全部被拒
    const evilPaths = ['..\\..\\evil.txt', 'C:\\Windows\\System32\\drivers\\etc\\hosts', '../evil.txt'];
    for (const ep of evilPaths) {
      try {
        await tool.execute({ command: 'view', path: ep });
        throw new Error(`should block evil path: ${ep}`);
      } catch (e) {
        if (!e.message.includes('路径越界')) throw new Error(`Wrong error message for evil path ${ep}: ${e.message}`);
      }
    }
    
    // 7. view 一个目录
    await tool.execute({ command: 'create', path: 'dirtest.txt', file_text: 'hello' });
    await tool.execute({ command: 'create', path: 'sub/deep.txt', file_text: 'deep' });
    const dirView = await tool.execute({ command: 'view', path: '.' });
    if (!dirView.includes('dirtest.txt')) throw new Error('dir view missing dirtest.txt');
    if (!dirView.includes('sub/')) throw new Error('dir view missing sub/');
    if (!dirView.includes('sub/deep.txt')) throw new Error('dir view missing sub/deep.txt');
    
    fs.rmSync(cwd, { recursive: true, force: true });
  });


  async function runProviderDryRun(vendor) {
    let firstUrl, firstOptions;
    let callCount = 0;
    
    const fakeFetch = async (url, options) => {
      callCount++;
      if (callCount === 1) {
        firstUrl = url;
        firstOptions = options;
      }
      
      let sseData = '';
      if (callCount === 1) {
        if (vendor === 'anthropic') {
          sseData = `event: message_start\ndata: {"message":{"usage":{"input_tokens":10}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"get_editor_state"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"}"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
        } else if (vendor === 'openai') {
          sseData = `data: {"choices":[{"delta":{"content":"hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_editor_state"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\ndata: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n`;
        } else if (vendor === 'gemini') {
          sseData = `data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_editor_state","args":{}}}]}}]}\n\ndata: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20}}\n\n`;
        }
      } else {
        if (vendor === 'anthropic') {
          sseData = `event: message_start\ndata: {"message":{"usage":{"input_tokens":10}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"end "}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"turn"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
        } else if (vendor === 'openai') {
          sseData = `data: {"choices":[{"delta":{"content":"end "}}]}\n\ndata: {"choices":[{"delta":{"content":"turn"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n`;
        } else if (vendor === 'gemini') {
          sseData = `data: {"candidates":[{"content":{"parts":[{"text":"end "}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"turn"}]}}]}\n\ndata: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20}}\n\n`;
        }
      }
      
      const encoder = new TextEncoder();
      const chunks = [encoder.encode(sseData)];
      async function* generateChunks() {
        for (const c of chunks) yield c;
      }
      
      return {
        ok: true,
        status: 200,
        body: generateChunks()
      };
    };

    const events = [];
    let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-dry-'));
    
    const sessionId = `dryrun-${vendor}`;
    const historyDir = path.join(os.tmpdir(), 'promptcut', 'harness-sessions');
    fs.mkdirSync(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, `${sessionId}.json`);
    const mockHistory = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'prev_call', name: 'think', input: { thought: 'test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prev_call', content: 'ok', is_error: false }] }
    ];
    fs.writeFileSync(historyFile, JSON.stringify(mockHistory), 'utf8');

    const { done } = startRun({
      provider: 'api',
      apiConfig: { vendor, model: 'test-model', apiKey: 'FAKE-KEY-FOR-TEST' },
      prompt: 'hello',
      systemPrompt: 'sys',
      cwd,
      sessionId,
      fetchImpl: fakeFetch,
      callTool: async () => 'ok',
      onEvent: (ev) => events.push(ev)
    });
    
    await done;
    
    if (vendor === 'anthropic' && !firstUrl.endsWith('/v1/messages')) throw new Error('Bad URL');
    if (vendor === 'openai' && !firstUrl.endsWith('/v1/chat/completions')) throw new Error('Bad URL');
    if (vendor === 'gemini' && (!firstUrl.includes(':streamGenerateContent?alt=sse') || !firstUrl.includes('test-model'))) throw new Error('Bad URL');
    
    const lowerHeaders = Object.keys(firstOptions.headers || {}).reduce((acc, k) => {
       acc[k.toLowerCase()] = true;
       return acc;
    }, {});
    
    if (vendor === 'anthropic' && (!lowerHeaders['x-api-key'] || !lowerHeaders['anthropic-version'])) throw new Error('Bad Headers');
    if (vendor === 'openai' && !lowerHeaders['authorization']) throw new Error('Bad Headers');
    if (vendor === 'gemini' && !lowerHeaders['x-goog-api-key']) throw new Error('Bad Headers');
    
    const parsedBody = JSON.parse(firstOptions.body);
    if (vendor === 'anthropic') {
      if (!parsedBody.model || !parsedBody.max_tokens || !parsedBody.messages || !parsedBody.stream || !parsedBody.tools[0].input_schema) throw new Error('Bad Body');
      const msgs = parsedBody.messages;
      const toolUseMsg = msgs.find(m => m.role === 'assistant' && m.content.some(b => b.type === 'tool_use'));
      if (!toolUseMsg) throw new Error('Missing tool_use in message conversion');
      const toolResMsg = msgs.find(m => m.role === 'user' && m.content.some(b => b.type === 'tool_result'));
      if (!toolResMsg) throw new Error('Missing tool_result in message conversion');
    } else if (vendor === 'openai') {
      if (!parsedBody.model || !parsedBody.messages || !parsedBody.stream || !parsedBody.tools[0].function) throw new Error('Bad Body');
      const msgs = parsedBody.messages;
      const toolUseMsg = msgs.find(m => m.role === 'assistant' && m.tool_calls);
      if (!toolUseMsg) throw new Error('Missing tool_calls in message conversion');
      const toolResMsg = msgs.find(m => m.role === 'tool' && m.tool_call_id === 'prev_call');
      if (!toolResMsg) throw new Error('Missing tool message in message conversion');
    } else if (vendor === 'gemini') {
      if (!parsedBody.contents || !parsedBody.tools[0].functionDeclarations || !parsedBody.systemInstruction) throw new Error('Bad Body');
      const msgs = parsedBody.contents;
      const toolUseMsg = msgs.find(m => m.role === 'model' && m.parts.some(p => p.functionCall));
      if (!toolUseMsg) throw new Error('Missing functionCall in message conversion');
      const toolResMsg = msgs.find(m => m.role === 'user' && m.parts.some(p => p.functionResponse && p.functionResponse.name === 'think'));
      if (!toolResMsg) throw new Error('Missing functionResponse in message conversion');
    }
    
    const texts = events.filter(e => e.type === 'text');
    const toolCalls = events.filter(e => e.type === 'tool_call');
    const doneEvent = events.find(e => e.type === 'done');
    
    if (texts.length < 2 && (vendor === 'anthropic' || vendor === 'openai' || vendor === 'gemini')) throw new Error(`Missing text events for ${vendor}: ${texts.length}`);
    if (toolCalls.length === 0) throw new Error('Missing tool_call event');
    if (toolCalls[0].name !== 'get_editor_state') throw new Error(`Wrong tool call name: ${toolCalls[0].name}`);
    if (!doneEvent) throw new Error('Missing done event');
    if (!doneEvent.usage) throw new Error('Missing usage in done event');
    if (doneEvent.usage.input !== 10 || (vendor !== 'openai' ? doneEvent.usage.output !== 20 : doneEvent.usage.output !== 20)) throw new Error('Usage parsing failed');

    if (callCount !== 2) throw new Error(`Expected exactly 2 fetch calls, got ${callCount}`);
    if (events.some(e => e.type === 'status' && e.text && e.text.includes('已达工具调用上限'))) throw new Error('Hit max iterations limit incorrectly');

    fs.unlinkSync(historyFile);
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  await runTest('Group 3 - Provider dry-run (anthropic)', () => runProviderDryRun('anthropic'));
  await runTest('Group 3 - Provider dry-run (openai)', () => runProviderDryRun('openai'));
  await runTest('Group 3 - Provider dry-run (gemini)', () => runProviderDryRun('gemini'));

  await runTest('Group 4 - Safety checks', () => {
    const checkFile = (file) => {
      const content = fs.readFileSync(file, 'utf8');
      if (content.match(/sk-[a-zA-Z0-9]{20,}/)) throw new Error(`Secret leaked in ${file}`);
      if (content.includes('AIza')) throw new Error(`Secret leaked in ${file}`);
      if (content.includes('xoxb-')) throw new Error(`Secret leaked in ${file}`);
    };
    
    const harnessDir = path.join(__dirname, '..', 'harness');
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.mjs')) checkFile(full);
      }
    };
    walk(harnessDir);
    checkFile(path.join(__dirname, '..', 'runners', 'api.mjs'));
  });

  if (fails > 0) {
    console.error(`\n${fails} tests failed.`);
    process.exit(1);
  } else {
    console.log('\nAll tests passed!');
    process.exit(0);
  }
}
main();
