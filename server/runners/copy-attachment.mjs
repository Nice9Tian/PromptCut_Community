// AI 助手附件后台复制子进程：在独立进程中复制大文件，避免阻塞 Dev Server
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const [, , src, dest] = process.argv;
  if (!src || !dest) {
    console.log(JSON.stringify({ ok: false, error: "缺少源文件或目标文件路径参数" }));
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
