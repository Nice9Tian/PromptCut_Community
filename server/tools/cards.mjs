export const cardsTools = [
  {
    name: "list_cards",
    description: "List available cards. Without arguments it returns a summary (id, name, description, useWhen for when to use the card, tags, and a list of parameter names, where those marked * are required), so you can scan all cards in one call and pick one. After picking, call again with cardId to get that card's full controls and defaults, and only then add_clip.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Only the full schema of this one card" },
        detail: { type: "string", enum: ["summary", "full"], description: "full means the full schema for all cards, usually not needed" }
      }
    },
    side: "page"
  },
  {
    name: "card_authoring_guide",
    description: "Get the full text of the card-building rules (two styles, remotion-style / motion-style, and the rules of each, the CardDef contract, control types, hard constraints, available dependencies, complete examples). New cards are written only in these two styles, declared with the required frameMode: \"direct\" is remotion style, \"stateful\" is motion style, with no preference for either. **You must call it first** before using create_card to create a new card; do not write from memory.",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "get_card_source",
    description: "Read back the original source of a card. Both user cards and built-in cards can be read. Returns the source of the definition file, plus files: the card / part files this card uses throughout, each with sharedBy (how many cards share it). Pass file to read one of them: the source locations marked by inspect_card_dom often land in shared parts or vendor files. **You must call it before modifying an existing card**: modifying without reading back amounts to rewriting the whole card from memory, and anything not mentioned drifts a little with every round.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "card id" },
        file: { type: "string", description: "Relative path of the file to read; must be in this card's files list; if omitted, reads the card definition file" }
      },
      required: ["cardId"]
    },
    side: "agent"
  },
  {
    name: "edit_card",
    description: "Edit a card's source (works for user cards and built-in cards): replace the `find` segment in the source with `replace`, touching only this one spot and leaving everything else unchanged. **This is the only correct way to modify an existing card**; do not rewrite the whole file with create_card + overwrite. Usage: first read the source back with get_card_source, copy the lines to change verbatim as `find` (indentation and spaces must match), and write the edited version as `replace`. `find` must match exactly once in the source: 0 matches means your copy is stale, and multiple matches mean you should make `find` longer to include the surrounding lines. With `file`, you can edit the parts / vendor files this card uses (they must be in the files returned by get_card_source); files with sharedBy > 1 are shared by several cards, and editing them changes all of those cards. **Only the source can be edited, not the HTML**: the DOM on the stage is rendered from the source, so editing the DOM directly gets overwritten on the next frame. Built-in files are backed up automatically to out/card-edits/ before editing. A syntax check runs before saving, and newly introduced Date.now / setTimeout / setAnimationLoop and similar patterns that do not follow the frame are rejected; cards declared as remotion-style (frameMode: \"direct\") are also checked item by item against the remotion-style rules, and violations are reported with line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        file: { type: "string", description: "Relative path of the file to edit; must be in the files returned by get_card_source; if omitted, edits the card definition file" },
        find: { type: "string", description: "The original text to be replaced, copied verbatim from the source" },
        replace: { type: "string", description: "The new content to replace it with" },
        replaceAll: { type: "boolean", description: "Pass true when `find` intentionally matches multiple places and all of them should be changed" }
      },
      required: ["cardId", "find", "replace"]
    },
    side: "agent"
  },
  {
    name: "inspect_card_dom",
    description: "Read-only view of the HTML (DOM tree) a card renders at a given moment, with each node marked with the component and the source line that rendered it. Use it to match \"this block on screen\" to \"that line in the source\", then use get_card_source + edit_card to change that line. **View only, no editing**: the HTML is rendered from the source, so to change it, edit the source. Wrapper layers that have a single child and no text of their own are collapsed; it expands 3 levels down by default, and nodes beyond that are marked \"…N more descendants, pass ref:N to look deeper\"; pass that number as ref to continue expanding from that node (the tree for the same moment is cached, so looking deeper needs no re-render). When one source line generates multiple sibling nodes (a list), this is marked: change that line and they all change together. It uses the same render pipeline as export, so what you see is the structure of that frame in the final video; the first call has to start a render process, which takes a few seconds.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "ID of the clip to view" },
        t: { type: "number", description: "Which second on the timeline; if omitted, uses the midpoint of this clip" },
        ref: { type: "number", description: "Expand downward from this node (the ref number from the previous return); if omitted, starts from the outermost level" },
        depth: { type: "number", description: "How many levels to expand downward, default 3, max 8" }
      },
      required: ["clipId"]
    },
    // Do not relax timeout: clip is moved to 0.5s starting line before rendering (see /api/cards/dom in vite-plugin-cards),
    // no matter where it sits on timeline only dozens of frames pushed, well within bridge default 60s
    side: "agent"
  },
  {
    name: "create_card",
    description: "Create a reusable card definition: TSX `CardDef`; for multiple inputs or GPU filters, transitions, or audio, write `kind` / `inputs` / `card` / `audio`, and read `card_authoring_guide` first. `frameMode` is required: \"direct\" (remotion-style, the picture is determined only by t, params, and input media, written only with the framework's remotionStyle and react, violations are rejected item by item with line numbers) or \"stateful\" (motion-style, may use Motion, CSS animations, etc.). After creating it, use apply_card to apply it to a clip. To change existing source, use get_card_source and edit_card, not create_card + overwrite to rewrite the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Lowercase kebab-case, globally unique, e.g. price-tag" },
        source: { type: "string", description: "Complete TSX CardDef source" },
        overwrite: { type: "boolean", description: "Pass true only when you really need to replace the whole card of the same name; use edit_card for small changes" }
      },
      required: ["id", "source"]
    },
    side: "agent"
  },
  {
    name: "apply_card",
    description: "Apply a media effect card definition (or a pre-overlay card on a 3D scene host) as an instance. Downstream media effect cards can be used on multiple media clips: clipId is an existing clip; or trackId/start/end creates a new animation or audio clip. Pre-overlay cards (`overlay: \"pre\"`) inject upstream state before a scene renders and **can only attach to a scene host** (`scene-3d` or a `\"3d\"` cut segment; attaching a pre-overlay to an ordinary DOM card or media clip is rejected — for timeline camera moves on a 2D or 3D cut, use `add_camera` / `update_camera` instead). inputs maps names to {clipId} (pointing to a media clip = that media, pointing to a media effect card clip = the output of that media effect card) or {nodeId} for another card's output, and can add offset (seconds) and rate (multiplier); when inputs is omitted: if the clip already has a media effect card, it connects to that card's output, otherwise it connects to the target clip's original media. Multi-input transitions commonly use A/B. params are passed in as instance parameters. nodeId is generated automatically if omitted; pass the current clip.nodeId to edit that instance's parameters and inputs.",
    inputSchema: { type: "object", properties: {
      cardId: { type: "string" }, clipId: { type: "string" }, trackId: { type: "string" }, start: { type: "number" }, end: { type: "number" },
      nodeId: { type: "string" }, params: { type: "object" }, frame: { type: "object" },
      inputs: { type: "object", additionalProperties: { type: "object", properties: {
        clipId: { type: "string" }, nodeId: { type: "string" }, offset: { type: "number" }, rate: { type: "number" }
      } } }
    }, required: ["cardId"] }, side: "agent"
  },
  {
    name: "bake_card",
    description:
      "Render a card **into an image** and save it to the media library, returning its URL. Currently its only use is as a texture for `scene-3d`: " +
      "fill the URL into that card's `texture` parameter, and you get \"a 3D object with this card printed on its surface\"." +
      "\n\n" +
      "The image is drawn by **the renderer that exports the final video** (the same pipeline as see_frames), so after it is applied, the preview and the final video look the same." +
      "\n\n" +
      "**It is a PNG snapshot, not live**: the card's animation freezes at frame `t`; if you change the card's parameters afterwards, the texture **will not** follow," +
      "so you need to render again and fill the new URL back in. So the order is \"tune the card first, then render\"" +
      "(In the 3D view and in export, the texture now plays along with playback and no longer freezes at `t`; what bake_card produces is a PNG snapshot at the specified moment `t`)." +
      "\n\n" +
      "Two looks, decided by `bg`, **fixed at render time**:" +
      "Without bg = transparent background; the object is also see-through wherever the card is not drawn, so the content looks like it floats in space (good for logos and signs);" +
      " With bg = flattened to opaque, giving a solid object with this card printed on its surface: most of the time, this is what \"stick the card on a cube\" calls for." +
      "\n\n" +
      "The aspect ratio is changed to a square before rendering (when applied to a 3D surface, 16:9 would be stretched and distorted); cards are responsive by design, so this is a reflow, not a crop." +
      " A media clip (video / image) does not need rendering; it is already a bitmap, so just use its URL directly as the texture.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "Which card to render (clip ID on the timeline)" },
        t: { type: "number", description: "Which moment to render (seconds, absolute timeline time). If omitted, uses the midpoint of this clip: the start and end are often caught in entrance and exit animations, which render as a semi-transparent intermediate state" },
        size: { type: "number", description: "Texture edge length (pixels, square), 256~2048, default 1024. If the object to be textured is small on screen, lower it to save memory" },
        bg: { type: "string", description: "Background color, six-digit hex such as \"#0b0f17\". If omitted = transparent background (cut-out look); if passed = solid look" },
      },
      required: ["clipId"],
    },
    side: "agent",
    // Like see_frames, launches a Chrome instance on the spot to render a single frame
    timeoutMs: 150000
  }
];
