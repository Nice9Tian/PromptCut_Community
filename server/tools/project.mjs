export const projectTools = [
  {
    name: "get_project",
    description: "Get the whole multi-track Project object, to learn the project configuration, media, and all tracks and clips on the timeline. The transcript of each media item in the result is only a segment-count summary; use get_transcript for the full transcript. **With multiple cuts, note**: `tracks` holds only the content of the currently active cut; clips in the other (inactive) cuts are listed up front in `parkedCuts` (for each cut: cutId, clip id, cardId / label, start and end, and its trackId; when there are too many it is capped and points you to the cutId for list_cuts). **You do not need user_interface_switch_cut to edit those clips**: pass the clipId directly to update_clip / set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted to edit in place (switching flips the interface for all members at once).",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "list_media",
    description: "List all media in the media library, returning for each item its id, name, kind (video / image / audio), duration, width, height, cardUrl, path, hasTranscript, transcriptSegments (number of transcript segments); to get the full transcript use get_transcript. When you need a media item's mediaId, prefer this tool; do not call get_project just to find a mediaId. **To reference a media image / video in card parameters, fill in its cardUrl** (of the form /@media/<filename>, available for preview, render, and export); path is a server disk path for server internal use only, and you have no tool that can read it; to see what a media item looks like use see_frames({ source: \"media\", mediaId }).",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "get_selection",
    description: "Get all clips in the selection along with their current project details. In account cloud mode it returns the selection of every page of all online, active members in the project, labeled with username and initiator; when the initiator is offline, only a non-live snapshot from the time the message was sent is shown. In local/LAN mode it returns all selections of this page.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "set_project_meta",
    description: "Set project metadata: name, canvas width and height, frame rate, theme, and truncating the whole video. The total duration follows the content by default; pass `duration` only when you want to truncate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        width: { type: "number", description: "Canvas width (pixels)" },
        height: { type: "number", description: "Canvas height (pixels)" },
        fps: { type: "number", description: "Frame rate" },
        duration: {
          type: "number",
          description:
            "Truncate the video at this second, in seconds. The duration defaults to the end of the content (contentEnd in the timeline returned by the tool)," +
            "adding content extends it and deleting content shortens it, no need for you to maintain it. A value smaller than contentEnd means truncation: preview and export are both cut off at that moment," +
            "and content added later is also cut off, until canceled. A value equal to or greater than contentEnd cancels the truncation and goes back to following the content: it cannot extend the video."
        },
        themeId: { type: "string", description: "Global theme id" }
      }
    },
    side: "agent"
  },
  {
    name: "set_theme",
    description: "Set the project's global theme (e.g. 'midnight').",
    inputSchema: {
      type: "object",
      properties: { themeId: { type: "string" } },
      required: ["themeId"]
    },
    side: "agent"
  },
  {
    name: "import_media",
    description: "Load a file into the project media library. Two sources: (1) an attachment the user sent with \"+\": attachments live in the chat's working directory, which is separate from the media library, and `list_media` cannot see them; you must import them with this tool first before you can transcribe, add captions, or add motion graphics; url is the \"in-app address\" in the attachment list at the end of the user message (of the form /@pcwork/<session id>/<filename>). When the user sends a video and asks you to process it, call this as the first step; do not reply \"please import it manually first\". (2) A direct image link from the web (https://…), which you find yourself when the media library lacks an image; in that case also pass name (with extension, e.g. asakusa.jpg). It is registered by file content type: videos are placed on a video track; images and audio only go into the media library, not onto the timeline. Returns mediaId, kind, and cardUrl; to reference this image / video in card parameters, fill in cardUrl.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "In-app address of the attachment, taken from the attachment list at the end of the user message" },
        name: { type: "string", description: "File name; if omitted it is taken from the address" }
      },
      required: ["url"]
    },
    side: "page"
  },
  {
    name: "list_media_effects",
    description: "View all effects of a media connection on the current timeline and their order: regular filters, pixel maps, audio effects, and the project effects library definitions. mediaId can be omitted to list all clips. Call this before creating a map, to confirm whether the stage of source/to is origin or after_filters.",
    inputSchema: { type: "object", properties: { mediaId: { type: "string" } } },
    side: "agent"
  }
];
