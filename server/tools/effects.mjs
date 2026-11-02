export const effectsTools = [
  {
    name: "list_filters",
    description: "List the filter library (those in the \"Transitions/Filters\" tab of the media library), along with the available filter kinds, value ranges and expression syntax. Each entry gives filterId, name, description, params (parameters that can be tuned per clip once attached), ops, summary, animated (whether there are steps that change over time), usedBy (which clips it is attached to). Before attaching a filter, check whether there is an existing one you can reuse.",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "create_filter",
    description: "Create a new filter and put it in the \"Transitions/Filters\" tab of the media library: the user can see and reuse it, and you can attach it to any video / image clip. For full-frame color grading (curves, channel mixing, color cast, tinting by brightness) use the curves / matrix here: they are done by the GPU compositor and do not take the preview's per-tick budget; **do not use create_pixel_map for full-frame color grading** (that is for per-pixel selections). ops is a few steps applied in order. Two lookup-table / matrix kinds (they do not change over time, do not write value): curves { kind:'curves', rgb?:[…], r?:[…], g?:[…], b?:[…] }, each table has 2~33 numbers in 0~1, spread evenly over input 0~1 with linear interpolation between points, rgb is shorthand shared by all three channels, e.g. brighten midtones { kind:'curves', rgb:[0,0.3,0.62,0.86,1] }, darken blue channel highlights { kind:'curves', b:[0,0.5,0.88] }; matrix color matrix { kind:'matrix', values:[rr,rg,rb, gr,gg,gb, br,bg,bb], offset?:[r,g,b] }, each of values is -4~4 (identity is [1,0,0,0,1,0,0,0,1]), offset is -1~1 per channel, added after the mixing is clamped, e.g. teal and orange { kind:'matrix', values:[1.1,0.05,0, 0,1,0.05, 0.02,0,0.9], offset:[-0.02,0,0.03] }. Eight kinds that take a number: brightness (1 is unchanged, 0~3, multiplicative), contrast (1 is unchanged, 0~3), saturate saturation (1 is unchanged, 0~2), hue hue rotation (degrees, -180~180), grayscale black and white (0~1), sepia vintage sepia (0~1), invert color inversion (0~1), blur (pixels within the clip frame, 0~40; if the frame shrinks the blur shrinks with it). value is a number, or an **expression string that changes over time**: t = seconds within the clip (counted from the clip start, so the same filter works the same wherever it is attached), d = clip duration, p = t/d (progress 0~1), and it can reference parameters declared in params; functions include sin cos abs min max pow clamp lerp step smoothstep etc., constant PI. Example: { name:'Breathing', params:{ amount:{ default:0.15, min:0, max:0.5, label:'Amount' } }, ops:[{ kind:'brightness', value:'1 + amount*sin(t*2*PI)' }] }; fade the whole clip to black and white: { kind:'grayscale', value:'p' }. Pass clipId to attach it to that clip right away. Preview, export and see_frames compute the same values.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name shown in the media library, up to 30 characters" },
        description: { type: "string", description: "One sentence on what effect it is and what kind of picture it suits" },
        params: {
          type: "object",
          description: "Optional: parameters that can be tuned per clip; keys are parameter names (starting with a lowercase letter), values are { default, min?, max?, label? }. Use the parameter names directly in expressions",
          additionalProperties: {
            type: "object",
            properties: {
              default: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              label: { type: "string" }
            },
            required: ["default"]
          }
        },
        ops: {
          type: "array",
          description: "Steps applied in order, 1~12 steps",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["brightness", "contrast", "saturate", "hue", "grayscale", "sepia", "invert", "blur", "curves", "matrix"] },
              value: { anyOf: [{ type: "number" }, { type: "string" }], description: "For the eight kinds that take a value: a number, or an expression string containing t / d / p / a parameter name. Not used for curves / matrix" },
              rgb: { type: "array", items: { type: "number" }, description: "curves: sample table shared by all three channels, 2~33 numbers in 0~1" },
              r: { type: "array", items: { type: "number" }, description: "curves: table for the red channel (takes precedence over rgb)" },
              g: { type: "array", items: { type: "number" }, description: "curves: table for the green channel" },
              b: { type: "array", items: { type: "number" }, description: "curves: table for the blue channel" },
              values: { type: "array", items: { type: "number" }, description: "matrix: row-major 3×3, 9 numbers in -4~4" },
              offset: { type: "array", items: { type: "number" }, description: "matrix: optional, [r,g,b] each in -1~1" }
            },
            required: ["kind"]
          }
        },
        clipId: { type: "string", description: "Optional: attach it directly to this clip after creating it (video / image)" },
        clipParams: { type: "object", description: "Optional: parameter values for this clip when attached, overriding the defaults in params" }
      },
      required: ["name", "ops"]
    },
    side: "agent"
  },
  {
    name: "update_filter",
    description: "Edit one filter in the filter library. **All** clips it is attached to change with it (clips reference the filter, they do not hold a copy). If ops / params are given, they replace the whole entry. To change the effect on a single clip only, use apply_filter and pass params to override for that clip, or create a separate filter.",
    inputSchema: {
      type: "object",
      properties: {
        filterId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        params: { type: "object", description: "Same as create_filter" },
        ops: { type: "array", items: { type: "object" }, description: "Same as create_filter" }
      },
      required: ["filterId"]
    },
    side: "agent"
  },
  {
    name: "remove_filter",
    description: "Delete one filter from the filter library. Rejected while it is still attached to clips; if you really need to delete it, pass force:true and state the reason in reason (the user will see it), and the clips carrying it in all cuts are detached together.",
    inputSchema: {
      type: "object",
      properties: {
        filterId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["filterId"]
    },
    side: "agent"
  },
  {
    name: "apply_filter",
    description: "Attach one filter from the filter library to a video / image clip (one per clip; attaching another replaces it); params gives parameter values for this clip alone. Passing an empty string for filterId detaches it. Card clips do not accept filters (cards use their own style parameters). After attaching, use see_frames to check the real result.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        filterId: { type: "string", description: "Empty string = detach the filter from this clip" },
        params: { type: "object", description: "Optional: parameter values for this clip, limited to those declared in this filter's params" }
      },
      required: ["clipId", "filterId"]
    },
    side: "agent"
  },
  {
    name: "list_pixel_maps",
    description: "List the generic pixel maps in the project. A pixel map is only for **selections that need per-pixel decisions** (color keying, selections by position/time, replacing with another media clip); for whole-frame color grading use create_filter's curves / matrix. where allows r/g/b/a/luma/x/y/t, and to can be {kind:'media',mediaId,stage:'origin'|'after_filters'}, {kind:'color',value:'#ff0000'}, {kind:'transparent'} or {kind:'expr',r,g,b,a}. First call list_media to find the asset id, then use list_media_effects to see existing filters and maps.",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "create_pixel_map",
    description: "**For whole-frame color grading use create_filter's curves / matrix; this tool is only for work that needs per-pixel selection.** (Curves, channel mixing, color shifts and luma-based tone replacement are all whole-frame color grading: they are done by the GPU compositor and do not use the preview's per-beat budget; a pixel map runs its own WebGL fragment shader, computed per pixel, with one program compiled per image. A definition passed in that counts as whole-frame color grading is rejected on the spot, and the error includes a create_filter ops you can copy directly.) What fits this tool: color keying (where references r/g/b/luma to make the selection), selections by position or time (referencing x/y/t), to being transparent or another media clip, and nonlinear expressions where channels depend on each other. Once created it runs through a WebGL fragment shader, and an optional clipId attaches it directly to a video/image clip. where is a 0~1 soft selection, for example 'smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))'; to can be {kind:'media',mediaId:'B',stage:'origin'|'after_filters'}, {kind:'color',value:'#ff0000'}, {kind:'transparent'} or a per-channel expression {kind:'expr',r:'r^1.6',g:'g^1.6',b:'b^1.6',a:'a'}. mode=continuous blends, discrete picks discrete colors (the top-level mode decides; the mode inside colorSequence is only an echo). A color sequence can be passed as colorSequence:{from:['#000000','#ffffff'],to:['#001133','#ffcc88']}; colors are picked by RGB nearest neighbor against from, and when the two ends differ in length they are interpolated aligned by first and last. Expressions are only translated, not executed as JavaScript, and the function set is the same as for ordinary filters; for a power whose base may be negative, wrap the base in abs() or write the exponent as an integer constant, otherwise it cannot be translated into a shader. After creating, verify with see_frames.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        source: { type: "object", description: "Map input media, may contain mediaId, stage(origin/after_filters), filterId" },
        where: { type: "string", description: "0~1 selection expression, variables r/g/b/a/luma/x/y/t" },
        to: { description: "The target can be a string '#ff0000', 'transparent', a media id, or a media/color/transparent/expr object; can be omitted when colorSequence is used" },
        mode: { type: "string", enum: ["continuous", "discrete"] },
        colorSequence: { type: "object", description: "Optional from/to color sequence and mode" },
        clipId: { type: "string" }
      },
      required: ["name", "where"]
    },
    side: "agent"
  },
  {
    name: "update_pixel_map",
    description: "Update a pixel map in the project. The fields given replace the definition; all clips it is attached to change with it. After updating, use see_frames to check the real result. Like create_pixel_map, it only accepts work that needs per-pixel selection: if the result becomes whole-frame color grading (where becomes a constant, to is merely a color-to-color function), it is rejected and the equivalent create_filter ops are attached.",
  inputSchema: { type: "object", properties: { pixelMapId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, source: { type: "object" }, where: { type: "string" }, to: { description: "String color/transparent/media id, or a target object" }, mode: { type: "string", enum: ["continuous", "discrete"] }, colorSequence: { type: "object" } }, required: ["pixelMapId"] },
    side: "agent"
  },
  {
    name: "remove_pixel_map",
    description: "Delete a pixel map. While it is still attached to clips, force:true is required, and reason must state a user-visible reason; to detach it from just one clip, use apply_pixel_map with an empty pixelMapId.",
    inputSchema: { type: "object", properties: { pixelMapId: { type: "string" }, force: { type: "boolean" }, reason: { type: "string" } }, required: ["pixelMapId"] },
    side: "agent"
  },
  {
    name: "apply_pixel_map",
    description: "Attach a pixel map to a video/image clip; one per clip, attaching another replaces it. Passing an empty string for pixelMapId detaches it. When to is media, stage decides whether the media's original pixels or its post-filter output is used. After attaching, verify with see_frames.",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, pixelMapId: { type: "string", description: "Empty string = detach" } }, required: ["clipId", "pixelMapId"] },
    side: "agent"
  }
];
