/**
 * Parses an SSE chunk stream, handling joins across chunks, several events in a single chunk, and
 * ignoring comment lines.
 * Returns the array of parsed JSON events and the remaining unparsed buffer string.
 */
export function parseSseChunks(buffer: string, chunk: string): { events: any[]; rest: string } {
  const text = buffer + chunk;
  const events: any[] = [];
  
  // Split on \n\n. If the end does not contain \n\n, the last part is incomplete
  const blocks = text.split(/\n\n/);
  
  // The last element is the remaining unfinished text (or an empty string if it ends with \n\n)
  const rest = blocks.pop() ?? "";
  
  for (const block of blocks) {
    if (!block.trim()) continue;
    
    const lines = block.split("\n");
    let dataContent = "";
    
    for (const line of lines) {
      if (line.startsWith(":")) {
        // Comment line (e.g. : ping)
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
        // If parsing fails, just ignore it or log it
      }
    }
  }
  
  return { events, rest };
}
