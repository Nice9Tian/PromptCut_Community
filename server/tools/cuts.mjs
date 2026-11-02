export const cutsTools = [
  {
    name: "list_transitions",
    description: "List all transitions in the current cut (crossfade / fade in / fade out). **A transition binds the clips it references into a group**: the relative timing of those clips is locked: changing a duration alone, changing the track, or split_clip are all rejected (update_clip with only start, shifting the whole group, still works, and the others in the group move along). To adjust one alone, run remove_transition first. Returns each one's id, kind, aId/bId, dur.",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "add_transition",
    description: "Add a transition and bind the related clips into a group. kind has three values: crossfade needs two **back-to-back** clips (clipId and otherClipId, either order is accepted), pulls the later clip forward to overlap and, if needed, moves it to another track (overlap is not allowed within the same track); fadeIn fades in, only added at a clip's **start**; fadeOut fades out, only added at the **end**. dur is in seconds (default 0.5 for crossfade, 0.6 for fade in/out). After adding, the relative timing of those clips is locked; to adjust one alone, run remove_transition first. Gaps in between, a duration longer than the clip, or a transition already on that end are all rejected with the reason given.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "crossfade / fadeIn / fadeOut" },
        clipId: { type: "string", description: "Fade in/out: that clip; crossfade: either of the two clips" },
        otherClipId: { type: "string", description: "Only needed for crossfade: the other clip" },
        dur: { type: "number", description: "Seconds, 0.1~10" }
      },
      required: ["kind", "clipId"]
    },
    side: "agent"
  },
  {
    name: "remove_transition",
    description: "Remove a transition (get transitionId from list_transitions or from transitions in get_project). Fades are erased, and for a crossfade the later clip is also moved back to where it was before the transition was added where possible; after removal those clips are unlocked and their timing can be changed individually.",
    inputSchema: {
      type: "object",
      properties: { transitionId: { type: "string" } },
      required: ["transitionId"]
    },
    side: "agent"
  },
  {
    name: "list_cuts",
    description: "List all cuts (timelines) in the project. **When the clip the user wants you to change is in another cut, check this tool's result first, do not user_interface_switch_cut**: clips in inactive cuts (id, cardId / label, start and end, track) are in the returned `parkedCuts`; take the clipId and hand it straight to update_clip etc. to edit in place. A project can have multiple cuts; a new project has only \"Cut 1\", the rest are created by the user or by you (add_cut). The user switches and opens them in the tab bar above the timeline and in the \"Cuts\" group of the media library. **Tools such as add_clip / track / export / get_layout only act on the currently active cut** (the one with active:true; see_frames can take a cutId to view other cuts), and the tracks in get_project are also its content. **But editing existing clips in other cuts does not need user_interface_switch_cut**: the `parkedCuts` in the result already lists the clips of each parked cut (with a cap when there are too many, and it will point you to the next step); to get everything in one cut, pass `cutId` to this tool and it returns that cut's timeline overview (clip ids, start and end) in addition. Once you have the clipId, hand it straight to update_clip / set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted; they edit the clip in that cut in place, **without switching the active cut** (the active cut is shared state, and switching flips the interface of every member at once, so do not switch if you can avoid it). **Viewing its frames does not need a switch either**: pass cutId to see_frames. Only call user_interface_switch_cut when you need to add / delete / split / duplicate clips in another cut (tools whose names start with user_interface_ act on the user's interface). A cut can be placed into another cut as a **cut segment** (add_cut_segment), by reference rather than by copy. Returns each cut's id, name, active, trackCount, clipCount, duration, plus referencedBy (which segments of which cuts reference it) and references (which cuts the cut segments inside it reference).",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "If given, additionally return this cut's timeline overview (ids, start and end of each track and clip) without switching to it; to change an existing clip inside it, take the clipId and hand it straight to update_clip etc." }
      }
    },
    side: "agent"
  },
  {
    name: "user_interface_switch_cut",
    description: "**Acts on the user's interface**: switches the active cut shared by all members to another one (by cutId or name, pick one); every member's interface flips over together, the playhead returns to where it was when this cut was last left, and the selection is cleared." +
      "**Use only when the user explicitly says \"switch to / open such-and-such cut\", or when you need to add / delete / split / duplicate clips in another cut.**" +
      "Do not use it just to change existing clips in other cuts (the clipId is in list_cuts or in the parkedCuts of get_project; hand it straight to update_clip etc. to edit in place);" +
      " Do not use it just to view the frames of other cuts either (pass cutId to see_frames). Switching over and back is two redundant writes, and it also interrupts the timeline others are watching." +
      " After switching, what get_project / add_clip / update_clip etc. see and change is this cut's content. Returns the cuts list after switching and a summary of this cut's timeline.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        name: { type: "string", description: "Cut name, pick one of this and cutId" }
      }
    },
    side: "agent"
  },
  {
    name: "add_cut",
    description: "Create a new cut (default name Cut N), with two empty tracks and a duration of 30 seconds. **Create only, no switch**: the active cut stays the same and nobody's interface moves; returns the new cut's id." +
      " To put things into it: to add clips you must first user_interface_switch_cut to it (this moves every member's interface, use it only when the user explicitly asks to switch or it is unavoidable);" +
      "or place it into the current cut as a cut segment (add_cut_segment). When the user says \"start another timeline / make another version\", this is it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }
      }
    },
    side: "agent"
  },
  {
    name: "rename_cut",
    description: "Rename a cut.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        name: { type: "string" }
      },
      required: ["cutId", "name"]
    },
    side: "agent"
  },
  {
    name: "remove_cut",
    description: "Delete a cut. The last one cannot be deleted. If it has content (clipCount > 0), or is referenced by other cuts (referencedBy of list_cuts is not empty), the call is rejected and tells you which segments of which cuts use it; if you really need to delete, pass force:true and state the reason in reason (the user will see it); the cut segments that reference it (together with the transitions bound to them) are deleted too, and removedSegments in the result lists what was deleted; the user can undo. When the deleted cut is the active one, it automatically switches to an adjacent one, and switchedTo in the result says where it went.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["cutId"]
    },
    side: "agent"
  },
  {
    name: "add_cut_segment",
    description: "Place a **cut segment** in the currently active cut: it references another cut (cutId or name, pick one); the picture is that cut's full frame at the corresponding moment, and the sound is its mix. A reference is not a copy: when the referenced cut changes, this follows. start is the second of the current cut to place it at; duration defaults to the remaining length of the referenced cut (from cutOffset), and if given it cannot exceed that; cutOffset is the second of the referenced cut to start from (default 0); trackId defaults to a track that is empty during this time. **It cannot be placed into itself, and cannot form a circular reference** (A references B, B references A again, at any depth); this is rejected with the reason. Once placed, like other clips use update_clip to change start and end / opacity / fades, set_position / set_rect to change the frame, set_clip_volume / set_clip_muted to adjust sound, split_clip to split (the cutOffset of the second half accumulates automatically), duplicate_clip to duplicate; in cutSegment of get_clip you can see which cut is referenced, the offset and the total duration of the referenced cut. Returns segment and timeline.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "Id of the referenced cut (get it from list_cuts)" },
        name: { type: "string", description: "Name of the referenced cut, pick one of this and cutId" },
        start: { type: "number", description: "Second of the current cut to place it at" },
        duration: { type: "number", description: "Seconds; default = the remaining length of the referenced cut, cannot exceed it" },
        cutOffset: { type: "number", description: "Second of the referenced cut to start from, default 0" },
        trackId: { type: "string", description: "Which track to place it on; defaults to one that is empty during this time" }
      },
      required: ["start"]
    },
    side: "agent"
  },
  {
    name: "set_cut_segment",
    description: "Change the second of the referenced cut at which a cut segment starts (cutOffset). An offset beyond the referenced cut's total duration is rejected; when the segment is longer than what remains of the referenced cut after the change, the out point is trimmed to the remaining length. **Which cut a cut segment references cannot be changed**: passing cutId / name is rejected; to replace it, remove_clip to delete this segment and place a new one with add_cut_segment. Start and end, frame, opacity, fades, volume and mute are not changed here (see the description of add_cut_segment). For clips that are not cut segments, use update_clip.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        cutOffset: { type: "number", description: "Seconds, not less than 0" }
      },
      required: ["clipId"]
    },
    side: "agent"
  }
];
