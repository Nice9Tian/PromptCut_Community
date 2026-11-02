/** Returns the display icon by attachment kind. The pending attachment cards in the input area and the sent file capsules in the user bubble use the same set */
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
