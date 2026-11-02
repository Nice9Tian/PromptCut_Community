export const layoutTools = [
  {
    name: "set_position",
    description: "Position a card: place its anchor at a coordinate on the frame, with optional size, scale and rotation. **This is the proper way to put any card at any position**: it is no longer limited by the card's built-in position tiers (center/bottom/…), and there is no need to swap cards just for position. Coordinate system: stage pixels, origin at top left; at 1920×1080 the center is 960,540. anchor decides which point in the box x,y refers to ([0,0] top left, [0.5,0.5] center, [1,1] bottom right), and scale and rotation also pivot around it; for example, to put the card center at the middle of the left half of the screen: { x:480, y:540, anchor:[0.5,0.5] }. Only the fields passed are changed, the rest are kept; pass clear:true to restore filling the whole screen. w/h are the card's **canvas** size (most cards are designed for 1920×1080; shrinking the canvas does not shrink the content, use scale to shrink the whole). space is equivalent for card-level world/local (the parent coordinate system is the stage); it will only differ at part level in the future. **3D**: rotateX / rotateY / translateZ place the card in space, but call set_camera3d first to enable perspective, otherwise you get an affine stretch, not perspective. Returns the layout's local / world and look; for the solid box contentBox, call get_layout separately.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        space: { type: "string", enum: ["world", "local"], description: "Default local; the two are equivalent at card level" },
        x: { type: "number", description: "Horizontal coordinate of the anchor (pixels)" },
        y: { type: "number", description: "Vertical coordinate of the anchor (pixels)" },
        w: { type: "number", description: "Canvas width (pixels), omitted = stage width" },
        h: { type: "number", description: "Canvas height (pixels), omitted = stage height" },
        anchor: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[ax, ay], 0~1; default [0,0]" },
        scale: { type: "number", description: "Scale around the anchor, default 1" },
        rotate: { type: "number", description: "Rotation around the anchor, in degrees, clockwise, default 0. This is an **in-plane** rotation" },
        rotateX: { type: "number", description: "3D: flip around the horizontal axis, in degrees. Positive = **top edge tilts inward, bottom edge lifts toward the viewer** (like leaning a sign backward). **Enable 3D with set_camera3d first**, otherwise you only get an affine stretch instead of perspective. **Only works on cards**; media clips (video/image) are rejected" },
        rotateY: { type: "number", description: "3D: flip around the vertical axis, in degrees. Positive = **right edge turns inward, left edge turns toward the viewer**. Likewise requires set_camera3d first, and likewise only works on cards" },
        translateZ: { type: "number", description: "3D: translate along depth, in stage pixels. Positive moves toward the viewer (larger), negative moves inward (smaller). Likewise requires set_camera3d first, and likewise only works on cards. Note that pushing too far forward crosses the camera: when translateZ approaches the \"camera distance\" (set_camera3d tells you this number), the card grows to fill the whole frame or even larger" },
        clear: { type: "boolean", description: "true = delete the box and restore full-screen fill" },
        clamp: { type: "boolean", description: "true = after computing, clamp the visible box back inside the stage so the card does not leave the frame" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "set_rect",
    description: "Place a card into a rectangle on the frame (two diagonal corner points, any order). **Preferred way to put a card on the \"empty side\"**. mode defaults to fit: the canvas stays as is and is scaled as a whole to just fit inside the rectangle, keeping its proportions, and aligned inside the rectangle per align (centered by default). Most cards are designed at 1920×1080, so after scaling the content is guaranteed to be inside the rectangle. With mode: canvas the canvas becomes the rectangle itself (the content is laid out again by the card's own rules and may overflow; use it only when you really need to change the canvas size). Returns the layout's local / world (check world.visualBox) and look, without contentBox. It edits the same box as set_position / align / nudge, just expressed differently.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        x1: { type: "number" }, y1: { type: "number" },
        x2: { type: "number" }, y2: { type: "number" },
        mode: { type: "string", enum: ["fit", "canvas"], description: "Default fit" },
        align: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Where to sit in the rectangle: [0,0] top left, [0.5,0.5] center (default), [1,1] bottom right" }
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
      "Turn 3D perspective on / off, and adjust its strength. **This is the only 3D switch**, one tier per project, not per card." +
      "While it is off, rotateX / rotateY / translateZ in set_position only produce an affine stretch: the card is skewed but with no near-large far-small effect, so it looks like a sticker rather than standing in space." +
      "Once on, the stage becomes a perspective space: the screen plane is z=0, positive translateZ comes toward the viewer (larger), negative goes inward (smaller)." +
      "\n\n" +
      "Strength is adjusted with fovDeg (field of view), **there is no \"camera distance\" parameter**: the distance is derived from fov and canvas height (d = H / (2·tan(fov/2)))." +
      "It is designed this way because a portrait project has a canvas height of 1920 and a landscape one 1080, so the same distance gives completely different perspective strength in the two aspect ratios, while fov is directly \"how strong the perspective is\" and needs no retuning when the aspect ratio changes." +
      "Tiers: **30° restrained** (close to orthographic, suits tidy information layouts), **40° default**, **50~60° noticeable** (a card has depth as soon as it turns), **80° and above is fisheye**, with exaggerated distortion at the corners." +
      "\n\n" +
      "After changing it, always check the real frames with see_frames: perspective strength can only be judged by eye, not calculated.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "true = turn 3D on (when fovDeg is not passed at the same time: if this project was tuned before it returns to that value, otherwise it uses the default 40°); false = turn it off, back to pure 2D. Existing rotateX/rotateY/translateZ on cards are not cleared, they just no longer have perspective",
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
