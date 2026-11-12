export const visionTools = [
  {
    name: "see_frames",
    /*
     * Originally two tools: see_preview(final video) and see_sequences(media). Combined into one,
     * with preview no longer in the name:
     * The word "preview" implies "a quick look, draft", and the model lowers its standards
     * accordingly. Now uniformly called "video frames".
     */
    description:
      "View video frames. There are two sources, distinguished by source:\n\n" +
      "**source: \"timeline\" : final video frames.** Renders a given moment of the timeline as an image and returns it, using the same render pipeline as export, so what you see is what you get on export." +
      " If t is omitted, the current playhead time is used; if clipId is passed, only that one card is rendered and all other tracks are left undrawn, which helps tell \"this card itself is wrong\" from \"it is covered by another card above it\"" +
      "(if t is not passed as well, the clip's midpoint is used, avoiding the intermediate states of entrance and exit animations). To compare several moments, pass a times array, up to 10 at a time." +
      "**To view the frames of another cut (one that is not active), pass cutId** (the cut id from list_cuts); if omitted, the currently active cut is used. It does not switch the active cut, does not change the project, and does not touch anyone's interface," +
      "Do not call user_interface_switch_cut just to view frames. When cutId is passed, t / times are seconds within that cut, and if t is omitted the position where that cut last stopped is used; clipId must also be a clip in that cut. For **3D cuts**, `view: \"camera\"` (default) renders the exact first-person output frame seen by the cut's active camera, while `view: \"space\"` renders a whole-scene overview framing all 3D boards plus the active output camera's frustum wireframe so you can verify spatial layout and diagnose why a board is off-screen or behind the camera! The cut field of the response says which cut was viewed (id and name). **After changing a card's style, take a look before drawing conclusions**; do not imagine the result from the source code." +
      " Each call starts a render process and takes roughly a few seconds to over ten seconds, so do not call it repeatedly in a row. **The gray checkerboard in a frame means \"transparent\", not content**: nothing is drawn there;" +
      " The checkerboard is not visible where a card covers it. So \"a full checkerboard\" = there is truly nothing at this moment, so do not keep trying different values of t.\n\n" +
      "**source: \"media\" : the media itself.** Splits the video into thumbnail mosaics by shot (as divided by list_shots), one 4-cell or 9-cell mosaic per shot" +
      "(frames sampled at equal intervals; cells correspond, row by row from left to right, to the frames seconds in the response), returning at most N per page at a time; page through to see later shots." +
      "**To judge what a piece of media actually contains, which side the people are on, what tone the picture has, and which parts are usable, do not guess from the captions alone: captions tell \"what was said\", while this shows \"what the picture is\".** " +
      "Usage: 1) Call see_frames({ source: \"media\", mediaId }) directly; if shot detection has not been run, it runs automatically and waits for it (about 36 seconds for 5 minutes of media; if detection is not possible, it cuts into 10-second segments and marks fallback in the response);" +
      "2) In the response, pages is the total number of pages and nextPage is the next page; keep paging until nextPage is null;" +
      "3) If a shot is hard to make out, use see_frames({ source: \"media\", mediaId, scene: shot number, grid: 9 }) to enlarge it on its own;" +
      "4) To look at only a certain time range, narrow it with from / to seconds. Each mosaic comes with the shot's start and end seconds, its in and out transitions, the caption text for that period (if transcribed) and the subject side (if detected); match them up when viewing the image." +
      " Do not request too much per page: default 6, maximum 12. Stop once you can give a clear answer; do not page through everything just to \"see it all\".",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["timeline", "media"], description: "timeline = final video frames on the timeline; media = thumbnail mosaics of the media itself, by shot" },
        t: { type: "number", description: "[timeline] Which second of the timeline; if omitted, the current playhead is used" },
        clipId: { type: "string", description: "[timeline] View only this one clip's frames" },
        cutId: { type: "string", description: "[timeline] Which cut's frames to view (the cut id from list_cuts); if omitted, the currently active cut is used. Does not switch the active cut and does not touch anyone's interface; an id that does not exist causes an error" },
        view: { type: "string", enum: ["camera", "space"], description: "[timeline, 3D cuts] \"camera\" (default) = exact output camera frame; \"space\" = third-person spatial overview showing all 3D boards and the output camera's frustum wireframe" },
        times: { type: "array", items: { type: "number" }, description: "[timeline] View several moments at once (seconds), up to 10, returning one image each in order; if times is given, t is ignored. Use it to compare shot pacing, or to see the same card midway through its entrance and after it settles" },
        mediaId: { type: "string", description: "[media, required] The media id from list_media. Videos are mosaicked by shot; for images the image itself is returned directly (paging, grid and scene are meaningless for images); audio has no picture and is rejected" },
        page: { type: "number", description: "[media] Which page, starting from 1; default 1" },
        perPage: { type: "number", description: "[media] How many shots per page, default 6, maximum 12. One mosaic per shot" },
        grid: { type: "number", description: "[media] How many cells per mosaic: 4 (2×2) or 9 (3×3), default 4. Use 9 when the shot is long, changes a lot, or you need to see detail" },
        scene: { type: "number", description: "[media] View only this one shot (the number in list_shots, starting from 1), ignoring paging; defaults to 9 cells" },
        from: { type: "number", description: "[media] Only view shots starting from this second (seconds within the media)" },
        to: { type: "number", description: "[media] Only view shots up to this second (seconds within the media)" }
      },
      required: ["source"]
    },
    side: "agent",
    // Launching Chrome on the fly to render a frame (timeline), or running shot detection first then
    // stitching a dozen images (media), exceeds the default 60 s limit
    timeoutMs: 180000
  },
  {
    name: "get_gif",
    description:
      "Samples 8 frames evenly from start to end of a card and makes an animated GIF to show the user, and also stitches the 8 frames into a 4×2 image and hands it to you." +
      " Cell k corresponds to the k-th moment in times in the response (row by row from left to right). Use it to see the card's whole motion graphics at a glance: how the entrance plays, what it looks like once settled, and whether there is an exit." +
      " Renders only that one card and leaves other tracks undrawn (same as passing clipId to see_frames). It has to render 8 frames at once, which is slower than viewing a single frame, so do not call it repeatedly in a row.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The card to view (clip id on the timeline)" },
      },
      required: ["clipId"],
    },
    side: "agent",
    // 8 frames rendered in one pass (renderFrames advances sequentially, capturing along the way),
    // then encoded into a GIF with ffmpeg; cold-starting Chrome can take over a minute
    timeoutMs: 180000
  }
];
