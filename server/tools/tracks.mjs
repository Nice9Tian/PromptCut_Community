export const tracksTools = [
  {
    name: "add_track",
    description: "Add a new track (tracks have no type; card clips and media clips can both be placed on them). If index is not given, it is added at the bottom.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        index: { type: "integer", description: "Position to insert at (starting from 0, 0 = topmost, drawn on the top layer)" }
      }
    },
    side: "agent"
  },
  {
    name: "list_tracks",
    description: "List all tracks of the current cut, very lightweight: for each one it gives trackId, index (0 = topmost, drawn on the top layer), name, clipCount, how many card / media clips, the time range occupied, marks empty tracks with empty:true, and flags hidden / muted / locked ones. Use it when organizing tracks, finding empty tracks, or deciding which layer to place on; do not pull the whole get_project for this.",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "remove_track",
    description: "Delete tracks, several at a time (trackIds), undoable in one step. Empty tracks are deleted directly; tracks that still have clips on them are rejected: deleting a track deletes its clips too, so if you really want to, pass force:true and state the reason in reason (the user will see it). Locked tracks are not deleted; at least one must remain. Transitions attached to deleted clips are removed as well. When the user says \"delete empty tracks / clean up unused tracks\", this is the tool: first use list_tracks to find those with empty:true, then pass them all in at once.",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "Delete one" },
        trackIds: { type: "array", items: { type: "string" }, description: "Delete several, alternative to trackId" },
        force: { type: "boolean", description: "Only needed when the track has clips" },
        reason: { type: "string", description: "Required with force" }
      }
    },
    side: "agent"
  },
  {
    name: "update_track",
    description: "Rename, hide, mute or lock a track; changes whichever one you specify. hidden:true makes it invisible in both preview and export (it is not deleted); muted:true only silences the audio; locked:true means the clips on it can no longer be changed and the track can no longer be deleted. This is the tool for requests like \"rename this track to Soundtrack\", \"hide the captions track for now\", \"mute this track\". Locking is how the user protects content, so do not unlock unless asked to.",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        name: { type: "string" },
        hidden: { type: "boolean" },
        muted: { type: "boolean" },
        locked: { type: "boolean" }
      },
      required: ["trackId"]
    },
    side: "agent"
  },
  {
    name: "move_track",
    description: "Reorder a track vertically by moving it to position index (counting from 0). Tracks nearer the top of the timeline are drawn on top: to put captions or cards over the video, move them up. This only changes how visuals overlap; it does not touch any clip's timing, and audio is unaffected.",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        index: { type: "integer", description: "0 = topmost" }
      },
      required: ["trackId", "index"]
    },
    side: "agent"
  }
];
