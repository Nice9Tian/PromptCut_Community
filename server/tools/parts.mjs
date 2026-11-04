export const partsTools = [
  {
    name: "list_parts",
    description: "List the parts available in the **parts library** (the components of composite cards: title, bullet list, ring metric, ranking bar, Lottie...). Without arguments it returns a summary (id, name, description, useWhen for when to use it, role, tags, list of parameter names); call again with partId to get the full controls / defaults / defaultFrame. Parts can only be placed in a composite card (cardId \"composite\"): give parts all at once when creating the card with add_composite, or add them one by one with add_part after creating it.",
    inputSchema: {
      type: "object",
      properties: {
        partId: { type: "string", description: "Only the full schema of this one part" },
        detail: { type: "string", enum: ["summary", "full"] }
      }
    },
    side: "agent"
  },
  {
    name: "add_composite",
    description: "Add a **composite card** to the timeline: a card freely assembled from parts in the parts library; each part has its own box (relative to the card's canvas, default 1920×1080), parameters and entrance timing enterMs. parts can be given all at once (each item { partId, params?, frame?, enterMs?, label?, children? }), or you can create an empty card first and then use add_part. Returns the wrapper of the new clip (the get_clip format; each instance in parts carries id, on-screen position world and settle time), look and timeline. Afterwards edit it with add_part / set_part / remove_part / move_part, or write the whole tree back with set_clip.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "number" },
        duration: { type: "number", description: "Seconds, default 3" },
        trackId: { type: "string" },
        parts: { type: "array", items: { type: "object" }, description: "List of part instances; partId is required, the rest are optional (if frame is omitted the part's defaultFrame is used)" }
      },
      required: ["start"]
    },
    side: "agent"
  },
  {
    name: "add_part",
    description: "Add a part instance to a composite card. partId comes from list_parts; params only needs the values to change, the rest use the part defaults; if frame is omitted, the part's defaultFrame is used (a box relative to the parent frame: x / y are the anchor position (pixels), w / h are the size, anchor [ax, ay] defaults to [0,0], scale and rotate are optional; null fills the parent frame); enterMs is the entrance time in milliseconds relative to the parent; if parentId is omitted = place at the root, if given the part becomes a child of that instance (a child part's frame is relative to its parent part's frame); if index is omitted = append. Returns the new instance id and the wrapper of the whole card.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        partId: { type: "string" },
        params: { type: "object" },
        frame: { type: "object", description: "A box relative to the parent frame: x / y are the anchor position (pixels), w / h are the size, anchor [ax, ay] defaults to [0,0], scale and rotate are optional; null fills the parent frame" },
        enterMs: { type: "number" },
        label: { type: "string" },
        parentId: { type: "string" },
        index: { type: "number" }
      },
      required: ["clipId", "partId"]
    },
    side: "agent"
  },
  {
    name: "set_part",
    description: "Edit a part instance in a composite card: params (sparse merge), frame (replaced as a whole, null fills the parent frame), enterMs, label. partInstanceId is parts[].id in get_clip. Returns the wrapper of the whole card.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        partInstanceId: { type: "string" },
        params: { type: "object" },
        frame: { type: "object", description: "A box relative to the parent frame: x / y are the anchor position (pixels), w / h are the size, anchor [ax, ay] defaults to [0,0], scale and rotate are optional; to fill the parent frame pass { clear: true }" },
        enterMs: { type: "number" },
        label: { type: "string" }
      },
      required: ["clipId", "partInstanceId"]
    },
    side: "agent"
  },
  {
    name: "remove_part",
    description: "Delete a part instance from a composite card (together with its child parts). Returns the wrapper of the whole card.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" }, partInstanceId: { type: "string" } },
      required: ["clipId", "partInstanceId"]
    },
    side: "agent"
  },
  {
    name: "move_part",
    description: "Move a part instance in a composite card to a different parent / a different order: parentId null or omitted = root; index omitted = end. Later items in the order are drawn on top. A part cannot be moved into its own subtree.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" }, partInstanceId: { type: "string" }, parentId: { type: "string", description: "Target parent instance id; omit or pass an empty string = root" }, index: { type: "number" } },
      required: ["clipId", "partInstanceId"]
    },
    side: "agent"
  }
];
