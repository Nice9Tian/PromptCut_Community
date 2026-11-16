#!/bin/sh
# Fake interpreter for vite-plugin-collect on Linux and macOS: the POSIX twin of
# fake-collect.cmd. It replays the same fixed JSONL, so the endpoints and the job
# table can be tested without yt-dlp or the network.
#
# The test copies this file to a temporary directory, marks the copy executable
# and points PROMPTCUT_PYTHON at it. The plugin invokes it as
#   fake-collect.sh -m promptcut_collect <subcmd> [...]
# so $3 is the subcommand; every other argument is ignored (download also reads
# --out-dir).
#
# Keep the two files in step: every line printed here must be the line the .cmd
# prints for the same subcommand. The JSON goes out through quoted here-documents,
# so backslashes (\\ in the Windows-style paths, \uXXXX escapes) reach the plugin
# untouched; `echo` would rewrite them in some shells.

SUBCMD="$3"

case "$SUBCMD" in
status)
  cat <<'EOF'
{"event":"status","version":"0.1.0","ready":true,"ytdlp":{"installed":true,"version":"fake","error":null},"ffmpeg":"C:\\fake\\ffmpeg","pylibs":null,"presets":[{"name":"bilibili","notes":"fake"},{"name":"generic","notes":"fake"}]}
EOF
  exit 0
  ;;

install)
  cat <<'EOF'
{"event":"log","line":"Collecting yt-dlp"}
{"event":"log","line":"Successfully installed yt-dlp-2026.8.19"}
{"event":"installed","ready":true,"ytdlp":{"installed":true,"version":"2026.8.19","error":null},"ffmpeg":"C:\\fake\\ffmpeg"}
EOF
  exit 0
  ;;

probe)
  if [ -n "$PROMPTCUT_FAKE_FAIL" ]; then
    echo '[BiliBili] fake stderr line' >&2
    cat <<'EOF'
{"event":"error","message":"Unable to download webpage: HTTP Error 404: Not Found"}
EOF
    exit 1
  fi
  cat <<'EOF'
{"event":"retry","attempt":1,"wait":1.5,"message":"HTTP Error 412: Precondition Failed"}
{"event":"done","id":"BV1FAKE00000","title":"Fake Video \u6d4b\u8bd5","duration":12.5,"uploader":"tester","extractor":"BiliBili","site":"bilibili","url":"https://www.bilibili.com/video/BV1FAKE00000","heights":[1080,720],"parts":null,"subtitles":[],"formats":[],"warnings":[]}
EOF
  exit 0
  ;;

search)
  cat <<'EOF'
{"event":"done","query":"fake","site":"bilibili","results":[{"id":"BV1FAKE00000","title":"Fake Search Hit","url":"https://www.bilibili.com/video/BV1FAKE00000","duration":12.5,"uploader":"tester","view_count":1234,"max_height":1080},{"url":"https://www.bilibili.com/video/BV1FAKE00001","error":"HTTP Error 404: Not Found"}],"warnings":[]}
EOF
  exit 0
  ;;

download)
  if [ -n "$PROMPTCUT_FAKE_FAIL" ]; then
    cat <<'EOF'
{"event":"start","url":"BV1FAKE00000","out_dir":"C:\\fake\\media","quality":1080}
EOF
    echo 'ERROR: [BiliBili] fake: Video unavailable' >&2
    cat <<'EOF'
{"event":"error","message":"[BiliBili] fake: Video unavailable"}
EOF
    exit 1
  fi
  # Write the reported file into --out-dir (the plugin's per-job temp dir): after
  # the process exits the plugin ingests it through the asset service. The bytes
  # are the ones the .cmd writes (its `echo` ends the line with CR LF), so the
  # content hash is the same on every platform.
  OUTDIR=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--out-dir" ]; then OUTDIR="$2"; fi
    shift
  done
  if [ -n "$OUTDIR" ]; then printf 'fake video bytes\r\n' > "$OUTDIR/Fake Video [BV1FAKE00000].mp4"; fi
  cat <<'EOF'
{"event":"start","url":"BV1FAKE00000","out_dir":"C:\\fake\\media","quality":1080,"audio_only":false,"all_parts":false}
{"event":"retry","attempt":1,"wait":1.5,"message":"HTTP Error 412: Precondition Failed"}
{"event":"info","id":"BV1FAKE00000","title":"Fake Video \u6d4b\u8bd5","duration":12.5,"uploader":"tester","site":"bilibili","url":"https://www.bilibili.com/video/BV1FAKE00000"}
{"event":"progress","stage":"video","percent":40.0,"overall":36.0,"downloaded":4000,"total":10000,"speed":1000.0,"eta":6,"format":"30080"}
{"event":"progress","stage":"video","percent":100.0,"overall":87.3,"format":"30080"}
{"event":"progress","stage":"audio","percent":100.0,"overall":97.0,"format":"30280"}
{"event":"progress","stage":"merge","percent":0.0}
{"event":"progress","stage":"merge","percent":100.0}
{"event":"item","id":"BV1FAKE00000","title":"Fake Video \u6d4b\u8bd5","path":"C:\\fake\\media\\Fake Video [BV1FAKE00000].mp4","filename":"Fake Video [BV1FAKE00000].mp4","bytes":12345,"vcodec":"h264","width":1920,"height":1080,"fps":30.0,"duration":12.5,"transcoded":false,"audio_only":false}
{"event":"done","items":[],"site":"bilibili","url":"https://www.bilibili.com/video/BV1FAKE00000","warnings":[]}
EOF
  # PROMPTCUT_FAKE_LINGER: stay alive ~2s after "done", like a busy machine where
  # the exit lags behind the last stdout line.
  if [ -n "$PROMPTCUT_FAKE_LINGER" ]; then sleep 2; fi
  exit 0
  ;;
esac

printf '%s\n' "{\"event\":\"error\",\"message\":\"fake-collect: unknown subcommand $SUBCMD\"}"
exit 2
