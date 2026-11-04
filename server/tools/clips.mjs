/**
 * Parameter description for update_clip: shared between the static version in the tool definition
 * and the real schema injected by cardId (server/card-params-schema.mjs).
 */
export const PARAMS_PATCH_DESC = "Incremental patch: write only the parameter keys to change this time; keys not written keep their current values (they are not reset); do not bring back the whole old set of parameters from memory, as that would write back values the user just changed or undid. To know the current values, call get_clip first.";

export const clipsTools = [
  {
    name: "add_clip",
    description: "Add a new card to the timeline. cardId and a start time are required. params are merged with the card's defaults, so write only the items you want to change; but key names must be parameters the card really has, and parameters marked required cannot be empty, otherwise it errors out directly: first use list_cards({cardId}) to check the schema, then create. For captions cards, do not hand-write lines, use fill_captions. Returns the new clip, plus `look` (a prepared see_frames call for this card; for decisions involving position and occlusion, follow it to inspect the real picture) and `timeline` (an overview of all current tracks and clip ids, starts and ends; refer to it for clipId afterwards; its `duration` is how long the whole video is and `contentEnd` is where the content actually ends; if the two numbers do not match, use set_project_meta to set duration to contentEnd).",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        start: { type: "number" },
        duration: { type: "number" },
        trackId: { type: "string" },
        params: { type: "object" }
      },
      required: ["cardId", "start"]
    },
    side: "agent"
  },
  {
    name: "update_clip",
    description: "Update a card: you can change its params, time range, card type (cardId), plus opacity / fade in-out / label / track. **Use this to edit a card that is already on the timeline**; do not remove_clip and then add_clip to rebuild it. **params is an incremental patch, not a full replacement**: pass only the keys you are changing this time (to change only the color, pass only {color:\"…\"}); keys you omit keep their current values and are not reset; **do not bring back a whole params object from memory of an earlier read**: those values may already have been changed by the user or another operation (for example the user just clicked \"Undo this step\"), and bringing the whole object back would silently write them back. Call get_clip first to learn the current values. **A clip in another (inactive) cut can be edited directly, no need for user_interface_switch_cut** (use the clipId from list_cuts({cutId}); trackId must be that cut's own track id, marked `cut` in the response). `changedParams` in the return lists the keys that actually changed (from → to), and `params` is the params after the edit (only key names if too large). opacity 0~1 (lower it when it covers a person and cannot be moved away); fadeIn/fadeOut are in seconds; trackId moves it to another track: **on the timeline, upper tracks cover lower ones** (in get_project, tracks[0] is the topmost track and also the top layer); to put a card over another one, move it to a higher track. Position, size and scale are not changed here; use set_rect / set_position / align / nudge; sound volume is not changed here either, use set_clip_volume (passing volume is rejected). **Clips with a transition attached** (visible in list_transitions) have a locked relative timing: shifting the whole group by passing only start is allowed (the group moves together), but changing duration / switching track / hand-editing the fadeIn·fadeOut on the transition side is rejected; run remove_transition first. Returns `look` (the see_frames call to view the card's real picture) and `timeline` (overview of all current clip ids and their start/end, plus `duration` / `contentEnd`; if they do not match, fix them with set_project_meta).",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        cardId: { type: "string" },
        params: { type: "object", description: PARAMS_PATCH_DESC },
        opacity: { type: "number", description: "0~1, default 1" },
        fadeIn: { type: "number", description: "Fade-in seconds" },
        fadeOut: { type: "number", description: "Fade-out seconds" },
        label: { type: "string", description: "Name shown on the timeline" },
        trackId: { type: "string", description: "Which track to move it to; upper tracks on the timeline are on the upper layer (tracks[0] is the top layer)" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "remove_clip",
    description: "Delete a card (by clipId). Gated: deleting a card you just created yourself with add_clip, or deleting more than 5 in a row, is rejected; use update_clip to edit a card; if you really must delete, pass force:true and state the reason in reason (the user will see this sentence). Returns `timeline` (overview of all clip ids and their start/end after deletion; use it as the reference for clipId afterwards. **After deleting, check `duration` and `contentEnd` in particular**: the duration does not shrink by itself, so a stretch of black easily hangs at the end; fix it with set_project_meta).",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        force: { type: "boolean", description: "Bypass the gate (deleting a card you just created / deleting more than 5 in a row). reason must be given as well." },
        reason: { type: "string", description: "Why this card is being deleted. Required when force is true; echoed to the user verbatim." }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "duplicate_clip",
    description: "Duplicate a card right after the original card, identical to it.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "split_clip",
    description: "Split a card into two segments at the given time point (t). A clip with a transition attached cannot be split (the two ends of the transition would no longer match); run remove_transition first.",
    inputSchema: {
      type: "object",
      properties: { 
        clipId: { type: "string" },
        t: { type: "number" }
      },
      required: ["clipId", "t"]
    },
    side: "agent"
  },
  {
    name: "get_clip",
    description: "Read a card's **card contract**: card (which card + lifecycle: how long the entrance takes to settle (settleMs), then hold = stay still / loop = repeat / evolve = keep changing, supported exit), time (start / end / duration), frame (local = the stored box, null means fill the stage; world = the computed absolute position on screen, read-only), blend (opacity / fadeIn / fadeOut), motion (whether a trajectory is bound), parts (parts tree: each part carries its own param values and entrance timing), params (all params). To judge \"the animation finished long ago and everything after is static\", look at lifecycle.settleMs and time.duration; to know which param controls which area, look at parts. To edit it use set_clip, or single-purpose tools such as update_clip / set_rect: they change the same data.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "set_clip",
    description: "Edit a card via the card contract: modify the object returned by get_clip and pass the whole thing back (you may also pass only the sections to change). Writable: card.id (switch card), params (**full**: this section is a whole replacement, keys not written revert to the card defaults, unlike the incremental patch of update_clip; to change only a few params use update_clip, or first get_clip to get the current whole object and then edit it) or the params of each part in parts, time.start / time.end, frame.local (x / y / w / h / anchor / scale / rotate, and the 3D rotateX / rotateY / translateZ: 3D only has perspective after set_camera3d turns it on, and only works on card clips, media clips are rejected; or null to fill the stage), blend.opacity / fadeIn / fadeOut (sound volume is not in blend, use set_clip_volume). Write only the sections that differ; if any part is invalid, nothing is written; frame.world, motion and card.lifecycle are read-only and are ignored if passed. Returns which sections changed, the new contract and look.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        envelope: { type: "object", description: "The object returned by get_clip (modified), or only the sections to change" }
      },
      required: ["clipId", "envelope"]
    },
    side: "agent"
  },
  {
    name: "set_emphasis",
    description: "Add \"emphasis\" to a clip: kind is shadow or outline, none removes it. **Both follow the edge of the opaque parts of the picture** (CSS drop-shadow works on the alpha channel), so what gets drawn is the edge of text, shapes and cut-out people, not the bounding box. It is most visible on cards with a transparent background; for a fully opaque picture (video, full-frame image) you only see a border outside the box. Params: color CSS color (shadow defaults to black, outline defaults to white), size in stage pixels (blur radius for shadow, line width for outline, 0~80), opacity 0~1, dx/dy shadow offset (not used by outline). When captions or titles are hard to read over a busy background, prefer this; it hurts the picture less than lowering the background opacity.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        kind: { type: "string", description: "shadow / outline / none" },
        color: { type: "string", description: "CSS color, e.g. #000000" },
        size: { type: "number", description: "Stage pixels: shadow = blur radius, outline = line width" },
        opacity: { type: "number", description: "0~1" },
        dx: { type: "number", description: "Shadow horizontal offset (stage pixels)" },
        dy: { type: "number", description: "Shadow vertical offset (stage pixels)" }
      },
      required: ["clipId", "kind"]
    },
    side: "agent"
  }
];
