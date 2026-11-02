"""Command-line entry point: python -m promptcut_collect <subcommand>

Subcommands: status / presets / install / probe / download
Output convention matches promptcut_stt: stdout is one JSON per line, stderr carries hints for humans.

Shortest form for agents to call directly (the bilibili preset is selected automatically from the link, or name it explicitly with --site bilibili):

    python -m promptcut_collect probe    --url BV1BYtB6GEFV
    python -m promptcut_collect download --url https://www.bilibili.com/video/BV1BYtB6GEFV --out-dir <directory> --quality 1080

The last line of download is {"event":"done","items":[{path, title, duration, width, height, ...}]}.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import Any, Dict, Optional

# Reuse the speech-to-text JSONL helpers: UTF-8 and newline handling on the Windows console is tricky, and we want to maintain only one copy.
from promptcut_stt.jsonl import emit, emit_error, emit_log, warn

from . import __version__, presets
from .ytdl import NotInstalled, download, probe, search, status

REQUIREMENTS = "requirements-collect.txt"
QUALITIES = (2160, 1440, 1080, 720, 480, 360)


def cmd_status(_args: argparse.Namespace) -> int:
    emit({"event": "status", "version": __version__, **status()})
    return 0


def cmd_presets(_args: argparse.Namespace) -> int:
    emit({"event": "presets", "presets": presets.describe()})
    return 0


def cmd_install(_args: argparse.Namespace) -> int:
    """Install yt-dlp into pylibs. Pure-Python wheel, about 3 MB, works on any platform."""
    pylibs = os.environ.get("PROMPTCUT_PYLIBS")
    if not pylibs:
        emit_error("PROMPTCUT_PYLIBS is not set, so there is nowhere to install the dependencies.")
        return 2
    os.makedirs(pylibs, exist_ok=True)

    # The manifest lives inside the package: this package is mirrored under pylibs and run from there, so one kept outside it would be lost
    here = os.path.dirname(os.path.abspath(__file__))
    req = os.path.join(here, REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"Cannot find dependency manifest {req}")
        return 2

    # Must use sys.executable: hard-coding "python" would install into the system interpreter
    cmd = [sys.executable, "-m", "pip", "install", "--target", pylibs, "--upgrade", "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
    except OSError as exc:
        emit_error(f"Cannot start pip: {exc}")
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(f"pip install failed (exit code {code}). Common cause: network unreachable.", code=code)
        return 1
    info = status()
    if not info["ffmpeg"]:
        warn("yt-dlp is installed, but ffmpeg was not found; the video and audio streams are downloaded separately and cannot be merged without ffmpeg.")
    emit({"event": "installed", **info})
    return 0


def _common(args: argparse.Namespace) -> Dict[str, Any]:
    return {
        "site": args.site if args.site != "auto" else None,
        "quality": args.quality,
        "cookies": args.cookies,
        "cookies_from_browser": args.cookies_from_browser,
        "attempts": args.attempts,
    }


def cmd_probe(args: argparse.Namespace) -> int:
    try:
        info = probe(args.url, emit=emit, **_common(args))
    except NotInstalled as exc:
        emit_error(str(exc), notInstalled=True)
        return 3
    except Exception as exc:
        emit_error(_last_line(exc))
        return 1
    emit({"event": "done", **info})
    return 0


def cmd_download(args: argparse.Namespace) -> int:
    out_dir = args.out_dir
    if not out_dir:
        data = os.environ.get("PROMPTCUT_DATA_DIR")
        out_dir = os.path.join(data, "media") if data else os.path.join(os.getcwd(), "collected")
    emit({"event": "start", "url": args.url, "out_dir": os.path.abspath(out_dir),
          "quality": args.quality, "audio_only": args.audio_only, "all_parts": args.all_parts})
    try:
        result = download(
            args.url, out_dir, emit=emit,
            audio_only=args.audio_only, all_parts=args.all_parts,
            ensure_h264=not args.keep_codec,
            **_common(args),
        )
    except NotInstalled as exc:
        emit_error(str(exc), notInstalled=True)
        return 3
    except Exception as exc:
        emit_error(_last_line(exc))
        return 1
    emit({"event": "done", **result})
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    """On-site search, for agents to pick media. The last line, done, carries results (each has url / title / duration / uploader / view_count)."""
    try:
        result = search(
            args.query, site=args.site if args.site != "auto" else "bilibili", limit=args.limit,
            cookies=args.cookies, cookies_from_browser=args.cookies_from_browser,
            attempts=args.attempts, emit=emit,
        )
    except NotInstalled as exc:
        emit_error(str(exc), notInstalled=True)
        return 3
    except Exception as exc:
        emit_error(_last_line(exc))
        return 1
    emit({"event": "done", **result})
    return 0


def _last_line(exc: BaseException) -> str:
    """yt-dlp errors often span several lines (ERROR: ... ; caused by ...); take the most informative one."""
    text = str(exc).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    msg = lines[0] if lines else exc.__class__.__name__
    if msg.startswith("ERROR: "):
        msg = msg[len("ERROR: "):]
    return msg[:600]


def _add_fetch_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--url", required=True, help="Video page link, BV id or short link")
    p.add_argument("--site", default="auto", choices=["auto", *presets.names()],
                   help="Site preset; by default it is detected automatically from the link")
    p.add_argument("--quality", type=int, default=1080, choices=QUALITIES,
                   help="Quality cap (pixel height), default 1080")
    p.add_argument("--cookies", default=None, help="cookies.txt in Netscape format; needed for qualities that are only available when logged in")
    p.add_argument("--cookies-from-browser", default=None,
                   help="Read cookies directly from the browser (chrome / edge / firefox); whether this works depends on the browser's encryption method")
    p.add_argument("--attempts", type=int, default=3, help="Number of retries for transient errors (e.g. Bilibili 412)")


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_collect", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Whether yt-dlp is installed, whether ffmpeg is present, which site presets exist").set_defaults(fn=cmd_status)
    sub.add_parser("presets", help="List site presets").set_defaults(fn=cmd_presets)
    sub.add_parser("install", help="pip-install yt-dlp into PROMPTCUT_PYLIBS").set_defaults(fn=cmd_install)

    p = sub.add_parser("probe", help="Probe only: title, duration, available qualities, parts")
    _add_fetch_args(p)
    p.set_defaults(fn=cmd_probe)

    d = sub.add_parser("download", help="Download as an mp4 the editor can use directly")
    _add_fetch_args(d)
    d.add_argument("--out-dir", default=None, help="Directory to save into, default <PROMPTCUT_DATA_DIR>/media")
    d.add_argument("--audio-only", action="store_true", help="Audio only (m4a)")
    d.add_argument("--all-parts", action="store_true", help="Download all parts of a multi-part upload; by default only the part named in the link")
    d.add_argument("--keep-codec", action="store_true",
                   help="Do not convert HEVC / AV1 to H.264 (converted by default, which keeps browser preview stable)")
    d.set_defaults(fn=cmd_download)

    s = sub.add_parser("search", help="On-site search, returns candidate videos (title / duration / uploader / view count) to pick from before download")
    s.add_argument("--query", required=True, help="Keywords")
    s.add_argument("--site", default="bilibili", choices=["auto", "bilibili", "generic"],
                   help="bilibili searches Bilibili; generic searches YouTube")
    s.add_argument("--limit", type=int, default=5, help="Maximum number of results (1~10), each is probed separately, so more is slower")
    s.add_argument("--cookies", default=None)
    s.add_argument("--cookies-from-browser", default=None)
    s.add_argument("--attempts", type=int, default=3)
    s.set_defaults(fn=cmd_search)

    args = parser.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
