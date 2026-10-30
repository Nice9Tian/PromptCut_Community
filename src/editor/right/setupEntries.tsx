import type { JSX } from "react";
import type { AiProvider } from "../../ai/types";

/**
 * 设置对话框第一级的五个入口。
 *
 * 前三个各对应一个 CLI;后两个都落到同一个 `api` 驱动上,区别只在**配置怎么进来**:
 * Router 是粘一段密文自动解出来,自定义 API 是自己一个个字段填。
 * 所以 `provider` 有重复,选了哪个「面孔」另外记在 localStorage 里(纯界面偏好)。
 */
export type SetupEntryId = "codex" | "claude" | "agy" | "router" | "custom";

export interface SetupEntry {
  id: SetupEntryId;
  /** 落到后端的哪个驱动 */
  provider: AiProvider;
  name: string;
  /** 卡片上的一句话 */
  tagline: string;
  icon: JSX.Element;
}

const ICON_PROPS = {
  width: 26,
  height: 26,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** 终端提示符:三个 CLI 共用的底,再各自叠一个记号 */
const IconCodex = (
  <svg {...ICON_PROPS}>
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M7 10l2.5 2L7 14" />
    <path d="M12.5 15h4.5" />
  </svg>
);

/** Claude:一个放射状的星芒 */
const IconClaude = (
  <svg {...ICON_PROPS}>
    <path d="M12 3v18M3 12h18" />
    <path d="M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

/** Antigravity:一个向上脱离的箭头 */
const IconAntigravity = (
  <svg {...ICON_PROPS}>
    <path d="M12 20V5" />
    <path d="M7.5 9.5L12 4.5l4.5 5" />
    <path d="M5 20h14" />
    <circle cx="12" cy="13.5" r="1" />
  </svg>
);

/** Router:一个中心节点分发到三处 */
const IconRouter = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="3" />
    <circle cx="4.5" cy="5" r="1.8" />
    <circle cx="19.5" cy="5" r="1.8" />
    <circle cx="12" cy="20.5" r="1.8" />
    <path d="M9.7 10.1L6 6.5M14.3 10.1L18 6.5M12 15v3.7" />
  </svg>
);

/** 自定义 API:一把钥匙 */
const IconCustom = (
  <svg {...ICON_PROPS}>
    <circle cx="8" cy="8" r="4" />
    <path d="M11 11l8 8" />
    <path d="M16.5 16.5l2-2" />
    <path d="M19 19l1.8-1.8" />
  </svg>
);

/** 顺序就是界面上的顺序 */
export const SETUP_ENTRIES: SetupEntry[] = [
  { id: "codex", provider: "codex", name: "Codex CLI", tagline: "OpenAI 官方命令行", icon: IconCodex },
  { id: "claude", provider: "claude", name: "Claude Code CLI", tagline: "Anthropic 官方命令行", icon: IconClaude },
  { id: "agy", provider: "agy", name: "Antigravity CLI", tagline: "Google 的 agentic 命令行", icon: IconAntigravity },
  { id: "router", provider: "api", name: "PromptCut Router", tagline: "粘一段分发密文，自动配好", icon: IconRouter },
  { id: "custom", provider: "api", name: "自定义 API", tagline: "自己填地址、模型和 Key", icon: IconCustom },
];

export const CLI_ENTRY_IDS: SetupEntryId[] = ["codex", "claude", "agy"];

export function isCliEntry(id: SetupEntryId): boolean {
  return CLI_ENTRY_IDS.includes(id);
}

const FACE_KEY = "aiSetupFace";

/** 记住上次选的是 Router 还是自定义 API —— 两者后端是同一个驱动,分不出来 */
export function readFace(): SetupEntryId | null {
  try {
    const saved = localStorage.getItem(FACE_KEY);
    return SETUP_ENTRIES.some((e) => e.id === saved) ? (saved as SetupEntryId) : null;
  } catch {
    return null;
  }
}

export function writeFace(id: SetupEntryId): void {
  try {
    localStorage.setItem(FACE_KEY, id);
  } catch {
    /* 无痕模式之类,记不住就算了,不影响功能 */
  }
}
