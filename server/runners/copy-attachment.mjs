// AI assistant attachment background copy child process: copy large files in an independent
// process to avoid blocking Dev Server
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const [, , src, dest] = process.argv;
  if (!src || !dest) {
    console.log(JSON.stringify({ ok: false, error: "Missing source file or target file path argument" }));
    process.exit(1);
  }

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    const stat = await fs.stat(dest);
    console.log(JSON.stringify({ ok: true, bytes: stat.size }));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err) }));
    process.exit(1);
  }
}

main();
