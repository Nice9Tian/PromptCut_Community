/**
 * 角色提示词。一个角色一个 .md 文件,放进本目录即可,不用改这里。
 *
 * 「一键配特效」就是按 ORDER 里的顺序把这些角色依次跑一遍:
 * 先让剪辑导演把素材排成一条片子,再让特效助理配字幕和动效。
 * 拆成角色而不是一整段长提示词,是因为这两步要的东西不一样 ——
 * 排片得先看全部素材,配特效得先有文字稿 —— 混在一轮里模型容易顾此失彼。
 *
 * 多 Agent 的 `spawn_agent`(计划 agent-workflow-plan.md A3)也从这个目录取预设角色的提示词,
 * 服务端按同样的规则读(`server/agent/agent-roles.mjs`)。
 *
 * 文件名用 ASCII,中文名写在文件里的一级标题上:这些名字会进构建产物和
 * 打包脚本,ASCII 路径在 Windows 的各种命令行环境里最不容易出岔子。
 */

export interface Role {
  /** 文件名去掉扩展名,例如 director */
  id: string;
  /** 文件里的一级标题,例如「剪辑导演」 */
  name: string;
  /** 标题以下的全部正文,发给 AI 的就是它 */
  prompt: string;
  /**
   * 这个角色需要什么样的模型能力。写在 .md 顶部的 frontmatter 里。
   *
   * 现在还没有真的按它路由——所有角色都跑用户选的那个 provider。留这个字段
   * 是为了以后能把「规划」交给强模型、「执行」交给快模型:那时候只要改
   * resolveModelFor,不用回来动每个角色。
   */
  capability: Capability;
}

/** 角色对模型的要求。新增档位时同步 resolveModelFor 的注释。 */
export type Capability = "planning" | "execution";

/**
 * 跑的顺序。没列进来的文件仍然会被读出来(可以单独调用),但不进「一键配特效」。
 * 将来加角色:建好 .md,把 id 放进这个数组。
 */
export const WORKFLOW_ORDER = ["director", "fx-assistant"] as const;

const files = import.meta.glob<string>("./*.md", { eager: true, query: "?raw", import: "default" });

/** 剥掉开头的 --- frontmatter ---,返回里面的键值对和剩下的正文 */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    // 值后面允许跟 # 注释,截掉
    if (kv) meta[kv[1]] = kv[2].replace(/\s+#.*$/, "").trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function parse(path: string, rawFile: string): Role {
  const id = path.replace(/^\.\//, "").replace(/\.md$/, "");
  const { meta, body: raw } = splitFrontmatter(rawFile);
  // 没写就按「执行」算:大多数角色是干活的,规划角色是少数,让少数去显式声明
  const capability: Capability = meta.capability === "planning" ? "planning" : "execution";
  const lines = raw.split(/\r?\n/);
  const headingAt = lines.findIndex((l) => l.startsWith("# "));
  const name = headingAt >= 0 ? lines[headingAt].slice(2).trim() : id;
  const prompt = (headingAt >= 0 ? lines.slice(headingAt + 1) : lines).join("\n").trim();
  return { id, name, prompt, capability };
}

/** 目录里的全部角色,按文件名排序 */
export const ALL_ROLES: Role[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .filter((r) => r.prompt !== "")
  .sort((a, b) => a.id.localeCompare(b.id));

/**
 * 按角色的能力档位挑模型。**现在是占位实现：一律返回 null，表示「用用户选的那个」。**
 *
 * 留这个函数是为了把「谁来干」和「用哪个模型」这两件事分开。以后要让
 * 规划类角色走强模型、执行类走快模型，只改这里一处；以后按角色选模型的调用方
 * 都问它，不用回头改每个角色。
 *
 * 返回 provider id（'claude' | 'codex' | 'agy' | 'api'），null 表示不指定。
 */
export function resolveModelFor(capability: Capability): string | null {
  // 将来大概会是这样：
  //   planning  → 强模型（拆解和取舍错了，后面全白跑）
  //   execution → 快模型（步骤直白，胜在便宜和快）
  void capability;
  return null;
}

/** 「一键配特效」按顺序要跑的那几个角色 */
export const WORKFLOW_ROLES: Role[] = WORKFLOW_ORDER
  .map((id) => ALL_ROLES.find((r) => r.id === id))
  .filter((r): r is Role => !!r);
