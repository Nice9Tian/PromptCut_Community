export const collectTools = [
  {
    name: "collect_status",
    description: "Check the status of the media collection extension: whether yt-dlp is installed (and its version), whether ffmpeg is present, which site presets exist (bilibili / generic), and the login state cookies for each site (keys are site ids, values have loggedIn / expired / userId / expiresAt). collect_probe / collect_download work only when ready is true; when it is false, check ytdlp.installed: if not installed, call collect_install; other causes (no ffmpeg, no built-in Python) cannot be fixed by a tool, so tell the user honestly. Call it before fetching a link.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "collect_install",
    description: "Install the media collection extension (install yt-dlp with pip, a pure Python wheel of about 3 MB, takes tens of seconds). Returns a jobId immediately; check this jobId with background_job_status, or call collect_status again to see whether ready has become true. Do not start it repeatedly.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "collect_search",
    description: "Search videos on a site, for requests like \"find media on Bilibili\": returns a candidate list, each with url, title, duration (seconds), uploader, view_count, max_height. **Use this to find media, do not use web_open to browse search pages**: clicking results on a search page opens a new tab, web_click cannot handle it, and it cannot get the BV id either. After getting candidates, pick by title, duration and view count, then collect_probe / collect_download that url. Parameter query is required; site is optional (bilibili by default, generic searches YouTube); limit is optional (default 5, max 10, each one is probed separately, so more is slower). An error on a single item means that probe failed; just skip it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, Chinese is fine" },
        site: { type: "string", enum: ["bilibili", "generic"], description: "Default bilibili" },
        limit: { type: "number", description: "Maximum number of results, 1~10, default 5" }
      },
      required: ["query"]
    },
    side: "page"
  },
  {
    name: "collect_probe",
    description: "Probe only, no download: give a web link (Bilibili BV id / av id / b23.tv short link / full link, or other sites supported by yt-dlp), and it returns the title, duration, uploader, available resolutions (heights, pixel heights from high to low), whether it is a multi-part upload (parts list), and whether the site provides captions (subtitles). **Take a look before downloading**: collections, resolutions that need login, and pages that are not video pages at all can all be spotted up front. Bilibili's occasional 412 is retried automatically, visible in notes. Parameter url is required; site is optional (auto / bilibili / generic, by default decided from the link); quality is optional (only affects the selected_format description in the result).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Video page link, BV id or short link" },
        site: { type: "string", enum: ["auto", "bilibili", "generic"], description: "Site preset, default auto decides from the link" },
        quality: { type: "number", description: "Maximum resolution (pixel height), only 2160 / 1440 / 1080 / 720 / 480 / 360 are accepted, other values are treated as 1080" }
      },
      required: ["url"]
    },
    side: "page"
  },
  {
    name: "collect_download",
    description: "Fetch a video from a web link and add it to the media library. The download runs in the background on the server (video and audio streams are downloaded separately and merged with ffmpeg, non-H.264 is transcoded automatically), **returns a jobId immediately**; poll with collect_job, and between polls wait 3 seconds with the wait tool (**do not sleep with a shell command yourself**, it is rejected in unattended mode and interrupts the whole round). It counts as added to the media library only when it is done and has a mediaId. Parameters: url is required; quality is optional (default 1080; logged-out Bilibili tops out at 1080, higher needs cookies); site is optional (auto / bilibili / generic); audioOnly downloads audio only; allParts downloads all parts of a multi-part upload (by default only the part specified by the link); cookies is the disk path of a Netscape-format cookies.txt, needed for resolutions that require login. Calling again while the same link is downloading returns the existing jobId directly (reused: true).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Video page link, BV id or short link" },
        // Do not use enum: Gemini's OpenAI-compatible API requires string enum values; numeric enums 400 the whole request,
        // agent cannot call any tools (caught in diagnostic reports). Allowed values in description, server whitelist fallback.
        quality: { type: "number", description: "Maximum resolution (pixel height), default 1080; only 2160 / 1440 / 1080 / 720 / 480 / 360 are accepted, other values are treated as 1080" },
        site: { type: "string", enum: ["auto", "bilibili", "generic"] },
        audioOnly: { type: "boolean", description: "Audio only (m4a)" },
        allParts: { type: "boolean", description: "Download all parts of a multi-part upload" },
        keepCodec: { type: "boolean", description: "true means do not convert HEVC / AV1 to H.264 (converted by default, which keeps browser preview stable)" },
        cookies: { type: "string", description: "Usually not needed: the login state saved by user_interface_collect_login is attached automatically. If passed, only files under cookies/ in the app data directory are accepted; paths elsewhere are ignored" }
      },
      required: ["url"]
    },
    side: "page"
  },
  {
    name: "collect_job",
    description: "Check the progress and result of collect_download. Returns status (running / done / error), stage (video = video stream / audio = audio stream / merge = merging / transcode = transcoding), percent for overall progress, speed (bytes/second), eta (seconds), info (probed title and duration), and notes (records such as 412 retries). When done, it includes items (path / title / duration / resolution / codec for each file) and mediaIds: the files are already registered in the media library and placed on the video track, visible in list_media, and can be passed straight to transcribe_media / detect_shots. On error, read message. Jobs live only in memory and cannot be queried after a service restart.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"]
    },
    side: "page"
  },
  {
    name: "user_interface_collect_login",
    description: "**Touches the user's interface** (opens a login dialog in the editor): log in to a video site (currently only bilibili) to get the quality available only when logged in (Bilibili 1080p60 / 4K requires a premium member login). It opens a login dialog in the editor: by default method is qr, and the QR code is shown right in the editor for the user to scan with their phone; method browser opens the site's own login page (account and password / SMS / verification code are all handled there), and the user types them in. **Stop right after calling**: tell the user \"The login dialog has popped up. Scan the code or switch to account and password login, then reply to me when done\", and **do not keep calling tools**; call collect_login_check after the user replies. If already logged in and not expired, no dialog is shown and it returns alreadyLoggedIn: true directly. The login state is saved as cookies.txt, and collect_probe / collect_download attach it automatically afterward, so there is no need to pass the cookies parameter. **Never enter the user's account password or verification code for them**.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", enum: ["bilibili"], description: "Default bilibili" },
        method: { type: "string", enum: ["qr", "browser"], description: "qr scans a QR code (default); browser opens the site's login page, where account and password / SMS also work" },
        force: { type: "boolean", description: "Force a fresh login even if already logged in (use when switching accounts)" }
      }
    },
    side: "page"
  },
  {
    name: "collect_login_check",
    description: "Call after the user says they have scanned the code: fetches the login state from the browser, saves it to disk if logged in and hides the window again, and returns loggedIn: true, userId, expiresAt (after expiry, user_interface_collect_login must be called again). When loggedIn: false, read missing / hint, have the user finish logging in in the window, then check once more; do not poll in a row, wait for the user to reply.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", enum: ["bilibili"], description: "Default bilibili" },
        hide: { type: "boolean", description: "Whether to hide the window off-screen again after a successful login, default true" }
      }
    },
    side: "page"
  },
  {
    name: "collect_logout",
    description: "Log out of the site: deletes the saved cookies.txt, after which downloads use logged-out quality. Use when the user says \"log out\", \"switch account\", or \"don't download with my account\".",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string", enum: ["bilibili"], description: "Default bilibili" } }
    },
    side: "page"
  }
];
