"""命令行入口：python -m promptcut_collect <子命令>

子命令：status / presets / install / probe / download
输出约定和 promptcut_stt 一致：stdout 一行一个 JSON，stderr 是给人看的提示。

agent 直接调的最短写法（bilibili 预设会按链接自动选中，也可以 --site bilibili 点名）：

    python -m promptcut_collect probe    --url BV1BYtB6GEFV
    python -m promptcut_collect download --url https://www.bilibili.com/video/BV1BYtB6GEFV --out-dir <目录> --quality 1080

download 的最后一行是 {"event":"done","items":[{path, title, duration, width, height, ...}]}。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import Any, Dict, Optional

# 复用听写那套 JSONL：Windows 控制台的 UTF-8 和换行处理有坑，只想维护一份。
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
    """把 yt-dlp 装进 pylibs。纯 Python 轮子，约 3 MB，不挑平台。"""
    pylibs = os.environ.get("PROMPTCUT_PYLIBS")
    if not pylibs:
        emit_error("没有设置 PROMPTCUT_PYLIBS，不知道该把依赖装到哪。")
        return 2
    os.makedirs(pylibs, exist_ok=True)

    # 清单放在包内部：这个包会被镜像到 pylibs 下运行，放在包外面就跟丢了
    here = os.path.dirname(os.path.abspath(__file__))
    req = os.path.join(here, REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"找不到依赖清单 {req}")
        return 2

    # 必须用 sys.executable：写死 "python" 会装进系统解释器
    cmd = [sys.executable, "-m", "pip", "install", "--target", pylibs, "--upgrade", "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
    except OSError as exc:
        emit_error(f"无法启动 pip：{exc}")
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(f"pip 安装失败（退出码 {code}）。常见原因：网络不可达。", code=code)
        return 1
    info = status()
    if not info["ffmpeg"]:
        warn("yt-dlp 装好了，但找不到 ffmpeg；视频流和音频流是分开下的，没有 ffmpeg 合不起来。")
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
    """站内搜索,给 agent 挑素材用。末行 done 带 results(每条有 url / title / duration / uploader / view_count)。"""
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
    """yt-dlp 的报错常常带好几行（ERROR: ... ; caused by ...），取最有信息量的那句。"""
    text = str(exc).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    msg = lines[0] if lines else exc.__class__.__name__
    if msg.startswith("ERROR: "):
        msg = msg[len("ERROR: "):]
    return msg[:600]


def _add_fetch_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--url", required=True, help="视频页链接、BV 号或短链")
    p.add_argument("--site", default="auto", choices=["auto", *presets.names()],
                   help="站点预设，默认按链接自动判断")
    p.add_argument("--quality", type=int, default=1080, choices=QUALITIES,
                   help="清晰度上限（像素高度），默认 1080")
    p.add_argument("--cookies", default=None, help="Netscape 格式的 cookies.txt，登录才有的清晰度要它")
    p.add_argument("--cookies-from-browser", default=None,
                   help="直接读浏览器的 cookie（chrome / edge / firefox），能不能读取决于浏览器的加密方式")
    p.add_argument("--attempts", type=int, default=3, help="临时性错误（如 B 站 412）的重试次数")


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_collect", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="yt-dlp 装没装、ffmpeg 在不在、有哪些站点预设").set_defaults(fn=cmd_status)
    sub.add_parser("presets", help="列出站点预设").set_defaults(fn=cmd_presets)
    sub.add_parser("install", help="pip 装 yt-dlp 到 PROMPTCUT_PYLIBS").set_defaults(fn=cmd_install)

    p = sub.add_parser("probe", help="只探测：标题、时长、可选清晰度、分 P")
    _add_fetch_args(p)
    p.set_defaults(fn=cmd_probe)

    d = sub.add_parser("download", help="下载成编辑台能直接用的 mp4")
    _add_fetch_args(d)
    d.add_argument("--out-dir", default=None, help="落盘目录，默认 <PROMPTCUT_DATA_DIR>/media")
    d.add_argument("--audio-only", action="store_true", help="只要音频（m4a）")
    d.add_argument("--all-parts", action="store_true", help="多 P 稿件全部下载，默认只取链接指定的那一 P")
    d.add_argument("--keep-codec", action="store_true",
                   help="不把 HEVC / AV1 转成 H.264（默认会转，浏览器预览才稳）")
    d.set_defaults(fn=cmd_download)

    s = sub.add_parser("search", help="站内搜索,返回候选视频(标题 / 时长 / UP 主 / 播放量),供挑选后 download")
    s.add_argument("--query", required=True, help="关键词")
    s.add_argument("--site", default="bilibili", choices=["auto", "bilibili", "generic"],
                   help="bilibili 搜 B 站;generic 搜 YouTube")
    s.add_argument("--limit", type=int, default=5, help="最多几条(1~10),每条要单独探测,多了慢")
    s.add_argument("--cookies", default=None)
    s.add_argument("--cookies-from-browser", default=None)
    s.add_argument("--attempts", type=int, default=3)
    s.set_defaults(fn=cmd_search)

    args = parser.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
