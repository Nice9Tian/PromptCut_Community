export const coreTools = [
  /*
   * Wait a moment. Looks redundant, but is actually a necessity.
   *
   * Over a dozen tools take the shape of "return jobId immediately, you poll for it", and the
   * descriptions also say "poll every few seconds": but before this tool existed, **the model had no
   * means of waiting at all**. The only way it could think of was borrowing a shell to run a command
   * (in testing, agy actually issued `powershell -Command "Start-Sleep -Seconds 3"`), and in
   * unattended mode Antigravity automatically rejects its own run_command; once rejected, **the whole
   * round is ruined**: what the user sees is an abrupt end without warning after a string of tool
   * calls, with neither reply nor error.
   *
   * In other words: we told it to wait, but gave it no clock hands. With this added, that detour
   * through the shell is no longer needed.
   */
  {
    name: "wait",
    description: "Wait a number of seconds before continuing (use for the interval between polls). For any tool that returns a jobId for you to poll (collect_job, stt_status, get_transcript, list_shots, etc.), use this to wait between two queries, **do not sleep by yourself with shell commands or other means**: those are rejected in unattended mode and abort the whole conversation turn. Parameter seconds: 1~30, default 3.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", description: "How many seconds to wait, 1~30, default 3" } }
    },
    side: "server",
  },
  {
    name: "report_progress",
    description: "The only progress report channel shown to the user. Call it once after each small stage (final: false), and you must call it once before the whole task ends (final: true); stopping because of an error or getting stuck also counts as ending. Fill in the three booleans first, then the lists; each item is one concise sentence in the user's language, no more than 40 characters in Chinese or Japanese (about 15 words in English), and no more than 8 items per category. When you cannot continue until the user replies (a missing capability, an ambiguous instruction that needs clarifying, candidates for them to pick), set blocked to true and write what you need them to do into todo: the interface will draw this report as \"waiting for your reply\" instead of \"paused\", so they know the ball is in their court; blocked being true means this turn stops here, so do not call any more tools after submitting.",
    inputSchema: {
      type: "object",
      properties: {
        final: { type: "boolean" },
        has_done: { type: "boolean" },
        has_todo: { type: "boolean" },
        has_problem: { type: "boolean" },
        blocked: { type: "boolean", description: "true means stop and wait for the user to reply (they must do something or answer before you can continue); write what they need to do into todo. Defaults to false" },
        stage: { type: "string" },
        done: { type: "array", items: { type: "string" } },
        todo: { type: "array", items: { type: "string" } },
        problems: { type: "array", items: { type: "string" } }
      },
      required: ["final", "has_done", "has_todo", "has_problem", "done", "todo", "problems"]
    },
    side: "server"
  },
  { name: "background_job_status", description: "Query the jobId returned by stt_install or transcribe_media to get done, ok, error and progress; done=true with ok=false means failure, so do not keep polling.", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }, side: "page" },
  {
    name: "auto_workflow",
    description: "For the given media, completes the whole flow from video to transcript to motion graphics cards in one click: if there is no transcript it first transcribes automatically and waits for completion (up to 10 minutes), then splits the transcript into 5 to 15 second paragraphs, assigns each paragraph a suitable motion graphics card using deterministic rules, and then lays one persistent caption-track captions card over the whole transcript (placed on a separate captions track). Parameter mediaId is required, maxCards defaults to 12. Use this tool directly when the user says \"auto make\" or \"one-click effects\". For longer media, after 50 seconds this tool first returns an object with a jobId and running set to true while the flow continues in the background; poll with auto_workflow_status and do not call this tool again.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        style: { type: "string" },
        maxCards: { type: "number" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "auto_workflow_status",
    description: "Poll the progress of the auto_workflow background job; if auto_workflow finishes within 50 seconds it returns the full result directly, so you only need this tool to poll when running is true in the return, and once done becomes true, result holds the full result.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" }
      },
      required: ["jobId"]
    },
    side: "page"
  },
  {
    name: "user_interface_seek",
    description: "**Touches the user's interface**: jumps the playhead in the user's editor to the given second of the timeline. Do not use it to look at the picture at a given moment (pass t to see_frames); use it only when the user asks you to put the playhead somewhere.",
    inputSchema: {
      type: "object",
      properties: { t: { type: "number" } },
      required: ["t"]
    },
    side: "page"
  },
  {
    name: "user_interface_play",
    description: "**Touches the user's interface**: starts playback in the user's editor. Use only when the user asks you to play.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "user_interface_pause",
    description: "**Touches the user's interface**: pauses playback in the user's editor. Use only when the user asks you to pause.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  }
];
