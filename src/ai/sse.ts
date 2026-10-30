/**
 * 解析 SSE 块流,处理跨块拼接、单块多条事件、以及忽略注释行。
 * 返回解析出的 JSON 事件数组和剩余未解析的缓冲区字符串。
 */
export function parseSseChunks(buffer: string, chunk: string): { events: any[]; rest: string } {
  const text = buffer + chunk;
  const events: any[] = [];
  
  // 按照 \n\n 拆分。结尾如果不含 \n\n，则最后一部分是不完整的
  const blocks = text.split(/\n\n/);
  
  // 最后一个元素是剩余未结束的文本（或者是空字符串，如果以 \n\n 结尾）
  const rest = blocks.pop() ?? "";
  
  for (const block of blocks) {
    if (!block.trim()) continue;
    
    const lines = block.split("\n");
    let dataContent = "";
    
    for (const line of lines) {
      if (line.startsWith(":")) {
        // 注释行 (例如 : ping)
        continue;
      }
      if (line.startsWith("data: ")) {
        dataContent += line.substring(6);
      } else if (line.startsWith("data:")) {
        dataContent += line.substring(5);
      }
    }
    
    if (dataContent) {
      try {
        events.push(JSON.parse(dataContent));
      } catch {
        // 解析失败直接忽略或记录
      }
    }
  }
  
  return { events, rest };
}
