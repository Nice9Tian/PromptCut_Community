// 对应 claude-quickstarts/agents/tools/text_editor.py
import fs from 'node:fs';
import path from 'node:path';

const undoStacks = new Map();
const SENTINEL_NOT_EXIST = Symbol('NOT_EXIST');

export function createTextEditorTool(workspaceDir) {
  return {
    name: "text_editor",
    description: "查看/新建/修改工作目录里的文本文件(只限 exports/ai-workspace/)",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["view", "create", "str_replace", "insert", "undo_edit"] },
        path: { type: "string", description: "相对 exports/ai-workspace/ 的路径" },
        file_text: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        insert_line: { type: "integer" },
        view_range: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 }
      },
      required: ["command", "path"]
    },
    async execute(input) {
      if (typeof input.path !== 'string' || input.path.trim() === '') {
         throw new Error("path 参数缺失");
      }
      if (!fs.existsSync(workspaceDir)) {
         fs.mkdirSync(workspaceDir, { recursive: true });
      }

      const root = path.resolve(workspaceDir);
      const target = path.resolve(root, input.path);
      
      if (target !== root && !target.startsWith(root + path.sep)) {
         throw new Error("路径越界:只能访问工作目录内的文件");
      }

      const cmd = input.command;

      if (cmd === 'view') {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
           let out = [];
           function walk(dir, depth) {
             if (depth > 2) return;
             const items = fs.readdirSync(dir);
             for (const item of items) {
               if (item.startsWith('.')) continue;
               const p = path.join(dir, item);
               const rel = path.relative(root, p).replace(/\\/g, '/');
               const isDir = fs.statSync(p).isDirectory();
               out.push(isDir ? `${rel}/` : rel);
               if (isDir) {
                  walk(p, depth + 1);
               }
             }
           }
           walk(target, 1);
           return out.length ? out.join('\n') : '(空目录)';
        } else {
           if (!fs.existsSync(target)) {
              throw new Error("文件或目录不存在");
           }
           const text = fs.readFileSync(target, 'utf8');
           const lines = text.split('\n');
           let start = 1;
           let end = lines.length;
           if (input.view_range) {
              start = input.view_range[0];
              end = input.view_range[1] === -1 ? lines.length : input.view_range[1];
           }
           
           let out = [];
           for (let i = start; i <= end; i++) {
              if (i >= 1 && i <= lines.length) {
                 const lineNum = String(i).padStart(6, ' ');
                 out.push(`${lineNum}\t${lines[i - 1]}`);
              }
           }
           return out.join('\n');
        }
      } else if (cmd === 'create') {
         if (fs.existsSync(target)) {
            throw new Error(`文件已存在,不能覆盖:${input.path}`);
         }
         if (!undoStacks.has(target)) undoStacks.set(target, []);
         undoStacks.get(target).push(SENTINEL_NOT_EXIST);
         
         fs.mkdirSync(path.dirname(target), { recursive: true });
         fs.writeFileSync(target, input.file_text || '', 'utf8');
         return 'ok';
      } else if (cmd === 'str_replace') {
         if (!fs.existsSync(target)) throw new Error("文件不存在");
         const text = fs.readFileSync(target, 'utf8');
         const oldStr = input.old_str || '';
         const count = text.split(oldStr).length - 1;
         if (count === 0) {
            throw new Error("没有找到要替换的内容");
         }
         if (count > 1) {
            throw new Error(`old_str 命中 ${count} 处,必须唯一`);
         }
         
         if (!undoStacks.has(target)) undoStacks.set(target, []);
         undoStacks.get(target).push(text);
         
         const newText = text.split(oldStr).join(input.new_str || '');
         fs.writeFileSync(target, newText, 'utf8');
         return 'ok';
      } else if (cmd === 'insert') {
         if (!fs.existsSync(target)) throw new Error("文件不存在");
         const text = fs.readFileSync(target, 'utf8');
         const lines = text.split('\n');
         
         const insertLine = input.insert_line;
         if (insertLine < 0 || insertLine > lines.length) {
            throw new Error("行号越界");
         }
         
         if (!undoStacks.has(target)) undoStacks.set(target, []);
         undoStacks.get(target).push(text);
         
         lines.splice(insertLine, 0, input.new_str || '');
         fs.writeFileSync(target, lines.join('\n'), 'utf8');
         return 'ok';
      } else if (cmd === 'undo_edit') {
         if (!undoStacks.has(target) || undoStacks.get(target).length === 0) {
            throw new Error("没有可撤销的编辑");
         }
         const lastContent = undoStacks.get(target).pop();
         if (lastContent === SENTINEL_NOT_EXIST) {
            fs.unlinkSync(target);
         } else {
            fs.writeFileSync(target, lastContent, 'utf8');
         }
         return 'ok';
      }
      
      throw new Error(`未知的命令 ${cmd}`);
    }
  };
}
