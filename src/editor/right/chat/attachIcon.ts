/** 按附件种类返回展示图标。输入区里待发的附件卡片和用户气泡里已发出的文件胶囊用同一套 */
export function attachIcon(kind?: string): string {
  switch (kind) {
    case "image": return "🖼";
    case "video": return "🎥";
    case "audio": return "🎵";
    case "pdf": return "📕";
    case "srt": return "💬";
    case "json": return "📋";
    case "text": return "📝";
    default: return "📎";
  }
}
