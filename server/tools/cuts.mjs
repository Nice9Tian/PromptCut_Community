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
    description: "List all cuts (timelines) in the project. **When the clip the user wants you to change is in another cut, check this tool's result first, do not user_interface_switch_cut**: clips in inactive cuts (id, cardId / label, start and end, track) are in the returned `parkedCuts`; take the clipId and hand it straight to update_clip etc. to edit in place. A project can have multiple cuts; a new project has only \"Cut 1\", the rest are created by the user or by you (add_cut). Each cut is either a **2D cut** (`kind: \"2d\"`, default: flat canvas + track stacking, optional 2D camera pan/zoom/rotate, captions stay screen-locked) or a **3D cut** (`kind: \"3d\"`: perspective 3D space with true depth occlusion, 3D camera dolly/truck/orbit/FOV on the camera lane, and both cards and video/image media placed as 3D boards). The user switches and opens cuts in the tab bar above the timeline and in the \"Cuts\" group of the media library. **Tools such as add_clip / track / export / get_layout only act on the currently active cut** (the one with active:true; see_frames and list_cameras / add_camera / update_camera / remove_camera / set_cut_kind / prerender_cut_to_2d can take a cutId to act on other cuts without switching), and the tracks in get_project are also its content. **But editing existing clips in other cuts does not need user_interface_switch_cut**: the `parkedCuts` in the result already lists the clips of each parked cut (with a cap when there are too many, and it will point you to the next step); to get everything in one cut, pass `cutId` to this tool and it returns that cut's timeline overview (clip ids, start and end, kind, cameras) in addition. Once you have the clipId, hand it straight to update_clip / set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted; they edit the clip in that cut in place, **without switching the active cut**. **Viewing its frames does not need a switch either**: pass cutId to see_frames. Only call user_interface_switch_cut when you need to add / delete / split / duplicate clips in another cut. A cut can be placed into another cut as a **cut segment** (add_cut_segment), by reference rather than by copy. Returns each cut's id, name, kind (\"2d\" | \"3d\"), active, trackCount, clipCount, cameraCount, duration, optional spaceWidth/spaceHeight/camera3dFov, plus referencedBy and references.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "If given, additionally return this cut's timeline overview (ids, start and end of each track and clip, plus camera clips) without switching to it; to change an existing clip inside it, take the clipId and hand it straight to update_clip etc." }
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
    description: "Create a new cut (default name Cut N), with two empty tracks and a duration of 30 seconds. `kind` selects `\"2d\"` (default: 2D canvas + track layering) or `\"3d\"` (3D perspective space where cards and video/image media stand in space with depth occlusion and 3D camera movement). **Create only, no switch**: the active cut stays the same and nobody's interface moves; returns the new cut's id and kind." +
      " To put things into it: to add track clips you must first user_interface_switch_cut to it (camera clips can be added directly by passing cutId to add_camera), or place it into the current cut as a cut segment (add_cut_segment). For a 3D walkthrough segment inside a 2D video, create a `\"3d\"` cut, build the walkthrough there, and place it into the main `\"2d\"` cut via `add_cut_segment` so captions and HUD in the outer 2D cut stay screen-locked on top.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["2d", "3d"], description: "\"2d\" (default) or \"3d\"" },
        spaceWidth: { type: "number", description: "[2D cuts] Optional virtual canvas width in pixels when panning across a wider 2D canvas than the output frame" },
        spaceHeight: { type: "number", description: "[2D cuts] Optional virtual canvas height in pixels when panning across a taller 2D canvas than the output frame" },
        camera3dFov: { type: "number", description: "[3D cuts] Default field of view in degrees (5~120, default 40) when no active camera clip overrides fovDeg" }
      }
    },
    side: "agent"
  },
  {
    name: "set_cut_kind",
    description: "Set a cut's spatial kind (`\"2d\"` or `\"3d\"`) and optional cut-level space metadata (`spaceWidth`, `spaceHeight`, `camera3dFov`). Converting `\"2d\" -> \"3d\"` is lossless (all existing clips sit on z = 0 facing the default straight-on 3D camera). Converting a `\"3d\"` cut back to `\"2d\"` is **never** done by overwriting in place because 3D depth occlusion, `translateZ`/`rotateX`/`rotateY` boards, and 3D camera moves have no lossless 2D track equivalent: passing `kind: \"2d\"` on a 3D cut is rejected and directs you to `prerender_cut_to_2d`, which pre-renders the 3D cut to an `.mp4` media asset in a new 2D cut while preserving the original 3D cut untouched.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "Target cut id from list_cuts; defaults to the currently active cut" },
        kind: { type: "string", enum: ["2d", "3d"], description: "\"2d\" or \"3d\"" },
        spaceWidth: { type: "number", description: "[2D cuts] Optional virtual 2D canvas width in pixels" },
        spaceHeight: { type: "number", description: "[2D cuts] Optional virtual 2D canvas height in pixels" },
        camera3dFov: { type: "number", description: "[3D cuts] Default 3D camera FOV in degrees (5~120)" }
      },
      required: ["kind"]
    },
    side: "agent"
  },
  {
    name: "prerender_cut_to_2d",
    description: "Pre-render a `\"3d\"` cut's exact camera output (picture + audio mix) into an `.mp4` video asset in the media library, and create a new `\"2d\"` cut with that video clip placed on Track 1, **keeping the original `\"3d\"` cut completely untouched** so you or the user can always go back and edit the 3D space later. Does not switch the active cut. Returns the new 2D cut, the imported media asset, and the placed Track 1 clip.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "Id of the 3D cut to pre-render (from list_cuts); defaults to the currently active cut" },
        name: { type: "string", description: "Optional name for the new 2D cut (defaults to \"<3D cut name> (2D)\")" }
      }
    },
    side: "agent",
    timeoutMs: 180000
  },
  {
    name: "list_cameras",
    description: "List all camera clips on a cut's dedicated camera lane (`cut.cameras`). Defaults to the currently active cut, or pass `cutId` to inspect another cut without switching. Returns the cut's `kind` (`\"2d\"` | `\"3d\"`), default uncovered pose, and each camera clip's `id`, `name`, `row` (higher row overrides lower row when active simultaneously), `start`, `end`, `enabled`, and `params`.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "Cut id from list_cuts; defaults to the currently active cut" }
      }
    },
    side: "agent"
  },
  {
    name: "add_camera",
    description: "Add a camera clip to a cut's dedicated camera lane (`cut.cameras`) to drive a continuous one-take camera move across multiple timeline clips. Camera clips **do not** extend `contentEnd` (deleting all track clips shrinks duration even if a camera clip spans 0..60). Within the same `row` (default 0), camera clips cannot overlap (adjacent touching `end === next.start` is allowed); when multiple rows are active at the same moment `t` (`start <= t < end`), the **highest `row` wins** (upper row overrides lower row). Moments not covered by any enabled camera clip fall back to the cut's default pose (2D: `x=0, y=0, zoom=1, rotate=0`; 3D: straight-on `(0, 0, cameraDistance(height, fovDeg))`, `rx=0, ry=0, rz=0`). Every parameter accepts either a **number** OR a deterministic **expression string** in `t` (seconds into this camera clip), `d` (camera clip duration), and `p = t/d` (0..1): for **2D cuts** `params` takes `{ x, y, zoom, rotate }` (captions on `caption-track` stay screen-locked and never pan away!); for **3D cuts** `params` takes `{ x, y, z, rx, ry, rz, fovDeg }`.",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "Target cut id from list_cuts; defaults to the currently active cut" },
        name: { type: "string", description: "Optional display label for the camera clip on the timeline" },
        row: { type: "number", description: "0-based camera lane row (default 0). Higher row overrides lower row at overlapping times" },
        start: { type: "number", description: "Start time in seconds (>= 0)" },
        end: { type: "number", description: "End time in seconds (> start)" },
        enabled: { type: "boolean", description: "Default true; false disables this camera clip without deleting it" },
        params: {
          type: "object",
          description: "Camera pose fields (numbers or t/d/p expression strings such as \"1920 * p\" or \"1500 - 2200 * p\"). 2D cut keys: x, y, zoom (>0), rotate (deg). 3D cut keys: x, y, z, rx, ry, rz (deg), fovDeg (5~120)."
        },
        x: { anyOf: [{ type: "number" }, { type: "string" }], description: "Convenience shorthand for params.x (number or t/d/p expression)" },
        y: { anyOf: [{ type: "number" }, { type: "string" }], description: "Convenience shorthand for params.y (number or t/d/p expression)" },
        z: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.z (number or t/d/p expression)" },
        rx: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.rx pitch in degrees (number or t/d/p expression)" },
        ry: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.ry yaw in degrees (number or t/d/p expression)" },
        rz: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.rz roll in degrees (number or t/d/p expression)" },
        fovDeg: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.fovDeg (5~120, number or t/d/p expression)" },
        zoom: { anyOf: [{ type: "number" }, { type: "string" }], description: "[2D cut] Convenience shorthand for params.zoom (> 0, number or t/d/p expression)" },
        rotate: { anyOf: [{ type: "number" }, { type: "string" }], description: "[2D cut] Convenience shorthand for params.rotate in degrees (number or t/d/p expression)" }
      },
      required: ["start", "end"]
    },
    side: "agent"
  },
  {
    name: "update_camera",
    description: "Update an existing camera clip's timing (`start`, `end`), `row`, `name`, `enabled`, or `params` (numbers or `t`/`d`/`p` expression strings; pass `null` inside `params` to clear a parameter back to default). Validates same-row non-overlap and expression syntax.",
    inputSchema: {
      type: "object",
      properties: {
        cameraId: { type: "string", description: "Camera clip id from list_cameras or add_camera" },
        cutId: { type: "string", description: "Target cut id from list_cuts; defaults to the currently active cut" },
        name: { type: "string" },
        row: { type: "number", description: "0-based camera lane row (higher row overrides lower row)" },
        start: { type: "number" },
        end: { type: "number" },
        enabled: { type: "boolean" },
        params: {
          type: "object",
          description: "Camera pose patch (numbers, t/d/p expression strings, or null to reset a key)"
        },
        x: { anyOf: [{ type: "number" }, { type: "string" }], description: "Convenience shorthand for params.x" },
        y: { anyOf: [{ type: "number" }, { type: "string" }], description: "Convenience shorthand for params.y" },
        z: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.z" },
        rx: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.rx" },
        ry: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.ry" },
        rz: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.rz" },
        fovDeg: { anyOf: [{ type: "number" }, { type: "string" }], description: "[3D cut] Convenience shorthand for params.fovDeg" },
        zoom: { anyOf: [{ type: "number" }, { type: "string" }], description: "[2D cut] Convenience shorthand for params.zoom" },
        rotate: { anyOf: [{ type: "number" }, { type: "string" }], description: "[2D cut] Convenience shorthand for params.rotate" }
      },
      required: ["cameraId"]
    },
    side: "agent"
  },
  {
    name: "remove_camera",
    description: "Remove a camera clip from a cut's dedicated camera lane.",
    inputSchema: {
      type: "object",
      properties: {
        cameraId: { type: "string", description: "Camera clip id from list_cameras" },
        cutId: { type: "string", description: "Target cut id from list_cuts; defaults to the currently active cut" }
      },
      required: ["cameraId"]
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
