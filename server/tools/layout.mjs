export const layoutTools = [
  {
    name: "set_position",
    description: "Position a card (or media board in a 3D cut): place its anchor at a coordinate on the frame, with optional size, scale, rotation, 3D pose, and deterministic per-frame keyframe expressions (`frameExpr`). **This is the proper way to put any card at any position**: it is no longer limited by the card's built-in position tiers (center/bottom/…), and there is no need to swap cards just for position. Coordinate system: stage pixels, origin at top left; at 1920×1080 the center is 960,540. anchor decides which point in the box x,y refers to ([0,0] top left, [0.5,0.5] center, [1,1] bottom right), and scale and rotation also pivot around it; for example, to put the card center at the middle of the left half of the screen: { x:480, y:540, anchor:[0.5,0.5] }. **Keyframe expressions**: any of x, y, w, h, scale, rotate, rotateX, rotateY, translateZ can be passed as an expression string in `t` (seconds into the clip), `d` (clip duration), and `p = t/d` (0..1) — or grouped under `frameExpr` — to animate position/scale/3D pose smoothly over time! Only the fields passed are changed, the rest are kept; pass clear:true to restore filling the whole screen (and clear expressions), or clearFrameExpr:true to clear only expressions. w/h are the card's **canvas** size (most cards are designed for 1920×1080; shrinking the canvas does not shrink the content, use scale to shrink the whole). **3D**: in a `\"3d\"` cut (`add_cut({ kind: \"3d\" })` or `set_cut_kind({ kind: \"3d\" })`), perspective and true depth occlusion are always on and **both cards and video/image media clips** can be placed as 3D boards; in a `\"2d\"` cut, call `set_camera3d` first to enable perspective and 3D fields apply only to cards. Returns the layout's local / world, frameExpr (if any), and look; for the solid box contentBox, call get_layout separately.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        space: { type: "string", enum: ["world", "local"], description: "Default local; the two are equivalent at card level" },
        x: { anyOf: [{ type: "number" }, { type: "string" }], description: "Horizontal coordinate of the anchor (pixels, or t/d/p expression string)" },
        y: { anyOf: [{ type: "number" }, { type: "string" }], description: "Vertical coordinate of the anchor (pixels, or t/d/p expression string)" },
        w: { anyOf: [{ type: "number" }, { type: "string" }], description: "Canvas width (pixels > 0, or t/d/p expression string), omitted = stage width" },
        h: { anyOf: [{ type: "number" }, { type: "string" }], description: "Canvas height (pixels > 0, or t/d/p expression string), omitted = stage height" },
        anchor: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[ax, ay], 0~1; default [0,0]" },
        scale: { anyOf: [{ type: "number" }, { type: "string" }], description: "Scale around the anchor (> 0, or t/d/p expression string), default 1" },
        rotate: { anyOf: [{ type: "number" }, { type: "string" }], description: "In-plane rotation around the anchor in degrees, clockwise (number or t/d/p expression string), default 0" },
        rotateX: { anyOf: [{ type: "number" }, { type: "string" }], description: "3D: flip around the horizontal axis, in degrees (number or t/d/p expression string). Positive = top edge tilts inward. In a 3D cut works on both cards and media boards; in a 2D cut call set_camera3d first and only works on cards" },
        rotateY: { anyOf: [{ type: "number" }, { type: "string" }], description: "3D: flip around the vertical axis, in degrees (number or t/d/p expression string). Positive = right edge turns inward" },
        translateZ: { anyOf: [{ type: "number" }, { type: "string" }], description: "3D: translate along depth, in stage pixels (number or t/d/p expression string). Positive moves toward the default viewer, negative moves deeper into space" },
        frameExpr: { type: "object", description: "Map of keyframe expressions for frame fields (x, y, w, h, scale, rotate, rotateX, rotateY, translateZ) using variables t, d, p; pass null on a key to clear that expression" },
        clearFrameExpr: { type: "boolean", description: "true = clear all frame keyframe expressions on this clip while keeping static frame numbers" },
        clear: { type: "boolean", description: "true = delete the box (and any frameExpr) and restore full-screen fill" },
        clamp: { type: "boolean", description: "true = after computing, clamp the visible box back inside the stage so the card does not leave the frame" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "set_rect",
    description: "Place a card into a rectangle on the frame (two diagonal corner points, any order), with optional `frameExpr` keyframe expressions. **Preferred way to put a card on the \"empty side\"**. mode defaults to fit: the canvas stays as is and is scaled as a whole to just fit inside the rectangle, keeping its proportions, and aligned inside the rectangle per align (centered by default). Most cards are designed at 1920×1080, so after scaling the content is guaranteed to be inside the rectangle. With mode: canvas the canvas becomes the rectangle itself (the content is laid out again by the card's own rules and may overflow; use it only when you really need to change the canvas size). Returns the layout's local / world (check world.visualBox), frameExpr (if any), and look, without contentBox. It edits the same box as set_position / align / nudge, just expressed differently.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        x1: { type: "number" }, y1: { type: "number" },
        x2: { type: "number" }, y2: { type: "number" },
        mode: { type: "string", enum: ["fit", "canvas"], description: "Default fit" },
        align: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Where to sit in the rectangle: [0,0] top left, [0.5,0.5] center (default), [1,1] bottom right" },
        frameExpr: { type: "object", description: "Optional keyframe expressions (x, y, w, h, scale, rotate, rotateX, rotateY, translateZ) in t, d, p" },
        clearFrameExpr: { type: "boolean", description: "true = clear all frame keyframe expressions on this clip" }
      },
      required: ["clipId", "x1", "y1", "x2", "y2"]
    },
    side: "agent"
  },
  {
    name: "align",
    description: "Snap a card to an edge or the center of the frame, with a margin: h is left/center/right, v is top/center/bottom; pass only one and the other direction stays put. The anchor follows the alignment, and for a scaled card the visible box's edge is what gets snapped. **Aligning a card that fills the full screen and is not scaled down has no visible effect** (the canvas and the stage are the same size), and the result carries a note to remind you: use set_rect or nudge scaleBy to shrink it first, then align. Returns the layout's local / world and look, without contentBox.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        h: { type: "string", enum: ["left", "center", "right"] },
        v: { type: "string", enum: ["top", "center", "bottom"] },
        margin: { type: "number", description: "Pixels from the edge, default 0" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "nudge",
    description: "Fine-tune from the current position: dx/dy add pixels (right and down are positive), scaleBy multiplies (0.8 = 20% smaller), rotateBy adds degrees (clockwise). Use it when, after looking at the look, you think \"a bit more to the left, a bit smaller\", instead of recomputing absolute coordinates. Returns the layout's local / world and look, without contentBox.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        dx: { type: "number" }, dy: { type: "number" },
        scaleBy: { type: "number" }, rotateBy: { type: "number" },
        clamp: { type: "boolean", description: "true = after computing, clamp the visible box back inside the stage so the card does not leave the frame; recommended when fine-tuning" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "get_layout",
    description: "Read a card's layout: local (the stored box; null if never set, meaning full-screen fill), world (the computed absolute position on the frame: anchor coordinates, size, box is the canvas rectangle, visualBox is the rectangle the canvas actually occupies after scaling and rotation) and **contentBox (the measured box of solid content: the union of text, images and boxes with a background color; transparent containers do not count)**. To judge \"will this card cover the person\", look at contentBox: the default card's canvas fills the full screen, so box/visualBox always say \"covers\"; to judge \"will it leave the frame\", look at visualBox. contentBox is measured by prerender over the whole scene at a given moment; when the card is not on screen at this moment it is null and comes with contentNote (seek into its time range first). Without clipId, returns all cards and media clips plus the stage size. set_position / set_rect / align / nudge all edit the same box, so after any of them you can read a consistent result here.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" }
      }
    },
    side: "agent"
  },
  {
    name: "set_camera3d",
    description:
      "Configure 3D perspective field of view (`fovDeg`). In a **2D cut** (`kind: \"2d\"`), this turns stage 3D perspective on / off for card tilts (`rotateX` / `rotateY` / `translateZ` without full 3D depth occlusion or camera movement); in a **3D cut** (`kind: \"3d\"`), perspective is always active and `fovDeg` sets the cut's default 3D camera FOV (used whenever no active `CameraClip` on the camera lane overrides `fovDeg`; for moving the 3D camera over time, use `add_camera` / `update_camera`)." +
      "\n\n" +
      "Strength is adjusted with fovDeg (field of view), **there is no \"camera distance\" parameter**: the default straight-on camera distance is derived from fov and canvas height (d = H / (2·tan(fov/2)))." +
      " Tiers: **30° restrained** (close to orthographic, suits tidy information layouts), **40° default**, **50~60° noticeable** (a card has depth as soon as it turns), **80° and above is fisheye**, with exaggerated distortion at the corners." +
      "\n\n" +
      "After changing it, always check the real frames with see_frames: perspective strength can only be judged by eye, not calculated.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "true = turn 3D perspective on; false = turn 3D perspective off on a 2D cut (cannot be turned off on a 3D cut, where perspective is intrinsic to the cut kind)",
        },
        fovDeg: {
          type: "number",
          description: "Field of view (degrees), 5~120; the larger, the more exaggerated the perspective. Passing it also turns 3D on, so there is no need to pass enabled",
        },
      },
    },
    side: "agent",
  }
];
