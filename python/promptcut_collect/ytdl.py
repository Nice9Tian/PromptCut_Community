"""yt-dlp 的薄封装：探测、下载、进度、重试、转码兜底。

对外只有三个函数：probe / download / status。yt-dlp 只在函数内部按需 import，
没装时 status 如实报告，probe / download 抛 NotInstalled，不抛 ImportError 堆栈。

进度以回调交出去（emit(dict)），由 __main__ 转成 JSONL；本模块不直接写 stdout，
因为 yt-dlp 自己也会往 stdout 画进度条——那会把 JSONL 搅乱，所以这里一律
noprogress + 自定义 logger 把它的话全转到 stderr。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional

from . import presets

Emit = Callable[[Dict[str, Any]], None]


# 编辑台里预览靠浏览器 <video>，avc1(H.264) 在 Windows 的 Chrome 上最稳；
# hvc1 要系统装 HEVC 扩展，av01 解码慢。所以优先 avc1，退而求其次再放开。
def format_selector(quality: int, audio_only: bool = False) -> str:
    if audio_only:
        return "bestaudio[ext=m4a]/bestaudio/best"
    q = int(quality)
    return (
        f"bestvideo[vcodec^=avc1][height<={q}]+bestaudio[ext=m4a]"
        f"/bestvideo[vcodec^=avc1][height<={q}]+bestaudio"
        f"/bestvideo[height<={q}]+bestaudio"
        f"/best[height<={q}]/best"
    )


class NotInstalled(RuntimeError):
    pass


def add_pylibs() -> None:
    p = os.environ.get("PROMPTCUT_PYLIBS")
    if p and os.path.isdir(p) and p not in sys.path:
        sys.path.insert(0, p)


def _import_ytdlp():
    add_pylibs()
    try:
        import yt_dlp  # type: ignore
    except Exception as exc:  # ModuleNotFoundError 或 yt-dlp 自己的 import 错
        raise NotInstalled(f"yt-dlp 没装或坏了：{exc}") from exc
    return yt_dlp


def ffmpeg_dir() -> Optional[str]:
    """ffmpeg 所在目录。PROMPTCUT_FFMPEG 指向 exe 或目录都行，其次看 PATH。"""
    env = os.environ.get("PROMPTCUT_FFMPEG")
    if env:
        return env if os.path.isdir(env) else os.path.dirname(env)
    exe = shutil.which("ffmpeg")
    return os.path.dirname(exe) if exe else None


def _tool(name: str) -> Optional[str]:
    """ffmpeg / ffprobe 的可执行文件：先看 ffmpeg_dir，再看 PATH。"""
    fd = ffmpeg_dir()
    if fd:
        cand = os.path.join(fd, name + (".exe" if os.name == "nt" else ""))
        if os.path.isfile(cand):
            return cand
    return shutil.which(name)


def status() -> Dict[str, Any]:
    add_pylibs()
    info: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        import yt_dlp  # type: ignore

        info["installed"] = True
        info["version"] = getattr(getattr(yt_dlp, "version", None), "__version__", None)
    except Exception as exc:
        info["error"] = str(exc)
    return {
        "ready": bool(info["installed"] and ffmpeg_dir()),
        "ytdlp": info,
        "ffmpeg": ffmpeg_dir(),
        "pylibs": os.environ.get("PROMPTCUT_PYLIBS") or None,
        "presets": presets.describe(),
    }


class _Logger:
    """把 yt-dlp 的输出全导到 stderr，stdout 只留 JSONL。"""

    def __init__(self) -> None:
        self.warnings: List[str] = []

    def debug(self, msg: str) -> None:
        if msg.startswith("[debug]"):
            return
        sys.stderr.write(msg.rstrip("\n") + "\n")

    def info(self, msg: str) -> None:
        sys.stderr.write(msg.rstrip("\n") + "\n")

    def warning(self, msg: str) -> None:
        self.warnings.append(msg)
        sys.stderr.write("WARNING: " + msg.rstrip("\n") + "\n")

    def error(self, msg: str) -> None:
        sys.stderr.write("ERROR: " + msg.rstrip("\n") + "\n")


def _base_opts(preset, url: str, quality: int, cookies: Optional[str],
               cookies_from_browser: Optional[str], logger: _Logger) -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": logger,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
    }
    opts.update(preset.ydl_opts(url, quality))
    if cookies:
        opts["cookiefile"] = cookies
    if cookies_from_browser:
        # yt-dlp 的写法是元组 (browser, profile, keyring, container)，这里只给浏览器名
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    fd = ffmpeg_dir()
    if fd:
        opts["ffmpeg_location"] = fd
    return opts


def _with_retry(fn, preset, attempts: int, emit: Optional[Emit]):
    """站点预设说「值得重试」的错误才重试，其余原样抛。"""
    last: Optional[Exception] = None
    for i in range(max(1, attempts)):
        try:
            return fn()
        except Exception as exc:
            last = exc
            msg = str(exc)
            if i + 1 < attempts and preset.retryable(msg):
                wait = 1.5 * (i + 1)
                if emit:
                    emit({"event": "retry", "attempt": i + 1, "wait": wait,
                          "message": msg.splitlines()[-1][:300]})
                time.sleep(wait)
                continue
            raise
    assert last is not None
    raise last


def _summarize_format(f: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": f.get("format_id"),
        "ext": f.get("ext"),
        "vcodec": f.get("vcodec"),
        "acodec": f.get("acodec"),
        "height": f.get("height"),
        "fps": f.get("fps"),
        "tbr": f.get("tbr"),
        "bytes": f.get("filesize") or f.get("filesize_approx"),
        "note": f.get("format_note"),
    }


def _summarize_info(info: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader"),
        "extractor": info.get("extractor"),
        "webpage_url": info.get("webpage_url") or info.get("original_url"),
        "thumbnail": info.get("thumbnail"),
        "upload_date": info.get("upload_date"),
        "description": (info.get("description") or "")[:500],
        "subtitles": sorted((info.get("subtitles") or {}).keys()),
    }


def _entries(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    if info.get("entries") is None:
        return [info]
    return [e for e in info["entries"] if e]


def probe(url: str, site: Optional[str] = None, quality: int = 1080,
          cookies: Optional[str] = None, cookies_from_browser: Optional[str] = None,
          attempts: int = 3, emit: Optional[Emit] = None) -> Dict[str, Any]:
    """只探测不下载：标题、时长、可选清晰度、分 P 数。"""
    yt_dlp = _import_ytdlp()
    preset = presets.resolve(url, site)
    norm = preset.normalize(url)
    logger = _Logger()
    opts = _base_opts(preset, norm, quality, cookies, cookies_from_browser, logger)
    opts["skip_download"] = True

    def run():
        with yt_dlp.YoutubeDL(opts) as y:
            return y.extract_info(norm, download=False)

    info = _with_retry(run, preset, attempts, emit)
    if info.get("entries") is not None:
        entries = _entries(info)
        first = entries[0] if entries else {}
        result = _summarize_info(first or info)
        result["parts"] = [
            {"index": i + 1, "id": e.get("id"), "title": e.get("title"), "duration": e.get("duration")}
            for i, e in enumerate(entries)
        ]
        formats = first.get("formats") or []
    else:
        result = _summarize_info(info)
        result["parts"] = None
        formats = info.get("formats") or []

    heights = sorted({f.get("height") for f in formats if f.get("height")}, reverse=True)
    result.update({
        "site": preset.NAME,
        "url": norm,
        "heights": heights,
        "formats": [_summarize_format(f) for f in formats],
        "selected_format": format_selector(quality),
        "warnings": logger.warnings,
    })
    return result


#: 各站的搜索前缀(yt-dlp 的搜索抽取器):bilisearchN:关键词 / ytsearchN:关键词
_SEARCH_PREFIX = {"bilibili": "bilisearch", "generic": "ytsearch"}


def search(query: str, site: str = "bilibili", limit: int = 5,
           cookies: Optional[str] = None, cookies_from_browser: Optional[str] = None,
           attempts: int = 3, emit: Optional[Emit] = None) -> Dict[str, Any]:
    """站内搜索,返回候选视频列表(带标题、时长、UP 主、播放量),供 agent 挑选后再 download。

    yt-dlp 的搜索抽取器扁平模式只给链接不给标题(实测 B 站),所以分两步:
    先扁平拿前 N 条链接,再并发探测每条拿元数据。N 限制在 1~10:每条探测约 1~3 秒,
    再多就撞 MCP 桥的 60 秒上限。
    """
    yt_dlp = _import_ytdlp()
    site = site if site in _SEARCH_PREFIX else "bilibili"
    limit = max(1, min(int(limit or 5), 10))
    preset = presets.by_name(site)
    logger = _Logger()
    base = _base_opts(preset, "", 1080, cookies, cookies_from_browser, logger)

    flat_opts = {**base, "extract_flat": True, "skip_download": True}
    # B 站搜索结果里混着课程(cheese)和番剧,那些不是视频页,download 不了,过滤掉
    keep = re.compile(r"bilibili\.com/video/") if site == "bilibili" else re.compile(r".")

    def run_flat():
        with yt_dlp.YoutubeDL(flat_opts) as y:
            return y.extract_info(f"{_SEARCH_PREFIX[site]}{limit + 3}:{query}", download=False)

    flat = _with_retry(run_flat, preset, attempts, emit)
    urls: List[str] = []
    for e in _entries(flat):
        u = e.get("url") or e.get("webpage_url") or ""
        if u and keep.search(u) and u not in urls:
            urls.append(u)
        if len(urls) >= limit:
            break

    probe_opts = {**base, "skip_download": True, "noplaylist": True}

    def one(u: str) -> Optional[Dict[str, Any]]:
        def run():
            with yt_dlp.YoutubeDL(probe_opts) as y:
                return y.extract_info(u, download=False)
        try:
            info = _with_retry(run, preset, attempts, None)
        except Exception as exc:  # 单条失败不拖累整批
            return {"url": u, "error": _first_line(exc)}
        if info.get("entries") is not None:
            info = (_entries(info) or [info])[0]
        out = _summarize_info(info)
        out["url"] = out.get("webpage_url") or u
        out["view_count"] = info.get("view_count")
        out["like_count"] = info.get("like_count")
        out["description"] = (out.get("description") or "")[:120]
        heights = sorted({f.get("height") for f in (info.get("formats") or []) if f.get("height")}, reverse=True)
        out["max_height"] = heights[0] if heights else None
        return out

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = [r for r in pool.map(one, urls) if r]
    return {"query": query, "site": site, "results": results, "warnings": logger.warnings}


def _first_line(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return (text[0] if text else exc.__class__.__name__)[:300]


_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f#%&]+')


def safe_name(title: str, limit: int = 80) -> str:
    """文件名只留安全字符。中文原样保留，Windows 保留字符和 URL 里麻烦的 #%& 去掉。"""
    s = _UNSAFE.sub(" ", title or "")
    s = re.sub(r"\s+", " ", s).strip(" .")
    if len(s) > limit:
        s = s[:limit].rstrip(" .")
    return s or "video"


def _probe_codec(path: str) -> Dict[str, Any]:
    ffprobe = _tool("ffprobe")
    if not ffprobe:
        return {}
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,width,height,r_frame_rate",
             "-show_entries", "format=duration", "-of", "json", path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
        data = json.loads(out.stdout or "{}")
        st = (data.get("streams") or [{}])[0]
        fmt = data.get("format") or {}
        fps = None
        r = st.get("r_frame_rate")
        if r and "/" in r:
            a, b = r.split("/")
            fps = round(float(a) / float(b), 3) if float(b) else None
        return {
            "vcodec": st.get("codec_name"),
            "width": st.get("width"),
            "height": st.get("height"),
            "fps": fps,
            "duration": float(fmt["duration"]) if fmt.get("duration") else None,
        }
    except Exception:
        return {}


def _transcode_h264(src: str, emit: Optional[Emit], duration: Optional[float]) -> str:
    """浏览器播不了的编码（hvc1 / av01）转成 H.264。原文件保留到成功后再删。"""
    ffmpeg = _tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("找不到 ffmpeg，无法转码")
    base, _ = os.path.splitext(src)
    tmp = base + ".h264.mp4"
    cmd = [ffmpeg, "-hide_banner", "-y", "-i", src,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
           "-progress", "pipe:1", "-nostats", tmp]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace")
    assert proc.stdout is not None and proc.stderr is not None

    # stderr 要有人一直读:ffmpeg 转码期间往 stderr 写的东西一旦塞满管道(64 KB),
    # 它就卡在写、我们卡在读 stdout,双向死锁,作业永远停在 transcode。开个线程持续吸走,
    # 只留最后几十行给报错用。
    import threading
    from collections import deque
    err_tail: deque = deque(maxlen=40)

    def drain() -> None:
        for ln in proc.stderr:  # type: ignore[union-attr]
            err_tail.append(ln.rstrip())

    t = threading.Thread(target=drain, daemon=True)
    t.start()

    last = 0.0
    for line in proc.stdout:
        if line.startswith("out_time_ms=") and duration:
            try:
                sec = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            now = time.time()
            if emit and now - last > 0.5:
                last = now
                emit({"event": "progress", "stage": "transcode",
                      "percent": min(99.0, round(sec / duration * 100, 1))})
    code = proc.wait()
    t.join(timeout=5)
    if code != 0 or not os.path.isfile(tmp):
        raise RuntimeError(f"ffmpeg 转码失败（退出码 {code}）：{' | '.join(err_tail)[-800:]}")
    # 先把转好的落到最终名,再删原文件:反过来的话中间出错就两头都没了
    final = base + ".mp4"
    os.replace(tmp, final)
    if os.path.abspath(src) != os.path.abspath(final) and os.path.exists(src):
        os.remove(src)
    return final


def _overall(weights: Dict[str, float], fid: str, pct: float) -> Optional[float]:
    """按流的字节权重把「当前流的百分比」折成整体百分比。下载顺序就是 weights 的插入顺序。"""
    if fid not in weights:
        return None
    acc = 0.0
    for k, w in weights.items():
        if k == fid:
            acc += w * pct
            break
        acc += w * 100.0
    # 合并 / 收尾留 3%
    return round(min(97.0, acc * 0.97), 1)


def download(url: str, out_dir: str, site: Optional[str] = None, quality: int = 1080,
             audio_only: bool = False, all_parts: bool = False,
             cookies: Optional[str] = None, cookies_from_browser: Optional[str] = None,
             ensure_h264: bool = True, attempts: int = 3,
             emit: Optional[Emit] = None) -> Dict[str, Any]:
    """下载到 out_dir，返回 {items: [...]}。每个文件落地时 emit 一个 item 事件。"""
    yt_dlp = _import_ytdlp()
    preset = presets.resolve(url, site)
    norm = preset.normalize(url)
    os.makedirs(out_dir, exist_ok=True)
    logger = _Logger()
    opts = _base_opts(preset, norm, quality, cookies, cookies_from_browser, logger)
    if all_parts:
        opts["noplaylist"] = False

    # 文件名自己算：yt-dlp 的模板会把 ? # 之类留在名字里，进 URL 时麻烦。
    # 中途一直用 id 当名字，落地后再改成「标题 [id].ext」。
    # out_dir 里的 % 要翻倍转义：outtmpl 整条都会被 yt-dlp 当模板解析，目录名里
    # 真出现一个 % 就会被当成字段占位符的开头，抛 ValueError: incomplete format。
    # 正常路径（%LOCALAPPDATA%\promptcut 展开后）不含 %，但 out_dir 是外面传进来的。
    opts["outtmpl"] = os.path.join(out_dir.replace("%", "%%"), "%(id)s.%(ext)s")
    opts["format"] = format_selector(quality, audio_only)
    if not audio_only:
        opts["merge_output_format"] = "mp4"

    weights: Dict[str, float] = {}  # format_id → 该流占总字节的比例（插入顺序 = 下载顺序）
    last_emit = [0.0]

    def stage_of(info: Dict[str, Any]) -> str:
        no_video = info.get("vcodec") in (None, "none")
        has_audio = info.get("acodec") not in (None, "none")
        return "audio" if (no_video and has_audio) else "video"

    def hook(d: Dict[str, Any]) -> None:
        if not emit:
            return
        st = d.get("status")
        info = d.get("info_dict") or {}
        fid = str(info.get("format_id"))
        if st == "downloading":
            now = time.time()
            if now - last_emit[0] < 0.5:
                return
            last_emit[0] = now
            done = d.get("downloaded_bytes") or 0
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            pct = round(done / total * 100, 1) if total else None
            emit({"event": "progress", "stage": stage_of(info), "percent": pct,
                  "overall": _overall(weights, fid, pct) if pct is not None else None,
                  "downloaded": done, "total": total or None,
                  "speed": d.get("speed"), "eta": d.get("eta"), "format": fid})
        elif st == "finished":
            emit({"event": "progress", "stage": stage_of(info), "percent": 100.0,
                  "overall": _overall(weights, fid, 100.0), "format": fid})

    def pp_hook(d: Dict[str, Any]) -> None:
        if emit and d.get("postprocessor") == "Merger":
            emit({"event": "progress", "stage": "merge",
                  "percent": 0.0 if d.get("status") == "started" else 100.0})

    opts["progress_hooks"] = [hook]
    opts["postprocessor_hooks"] = [pp_hook]

    class _BeforeDl(yt_dlp.postprocessor.PostProcessor):
        """下载前跑一次：记下各流的字节数（进度加权用），并把标题时长先报出去。"""

        def run(self, info):
            sizes: Dict[str, float] = {}
            for f in info.get("requested_formats") or [info]:
                sizes[str(f.get("format_id"))] = float(f.get("filesize") or f.get("filesize_approx") or 0)
            total = sum(sizes.values())
            for k, b in sizes.items():
                weights[k] = (b / total) if total else (1.0 / max(1, len(sizes)))
            if emit:
                emit({"event": "info", **_summarize_info(info), "site": preset.NAME, "url": norm})
            return [], info

    def run():
        with yt_dlp.YoutubeDL(opts) as y:
            y.add_post_processor(_BeforeDl(y), when="before_dl")
            return y.extract_info(norm, download=True)

    info = _with_retry(run, preset, attempts, emit)
    items: List[Dict[str, Any]] = []
    for e in _entries(info):
        rd = e.get("requested_downloads") or []
        src = rd[0].get("filepath") if rd else None
        if not src or not os.path.isfile(src):
            raise RuntimeError(f"下载完成但找不到文件：{src}")
        meta = _probe_codec(src) if not audio_only else {}
        vcodec = meta.get("vcodec")
        transcoded = False
        if ensure_h264 and not audio_only and vcodec and vcodec != "h264":
            if emit:
                emit({"event": "progress", "stage": "transcode", "percent": 0.0,
                      "note": f"视频编码是 {vcodec}，浏览器不一定播得了，转成 H.264"})
            src = _transcode_h264(src, emit, meta.get("duration") or e.get("duration"))
            meta = _probe_codec(src)
            transcoded = True
        ext = os.path.splitext(src)[1]
        title = safe_name(e.get("title") or e.get("id") or "video")
        final = os.path.join(out_dir, f"{title} [{e.get('id')}]{ext}")
        if os.path.abspath(final) != os.path.abspath(src):
            if os.path.exists(final):
                os.remove(final)
            os.replace(src, final)
        item = {
            **_summarize_info(e),
            "path": os.path.abspath(final),
            "filename": os.path.basename(final),
            "bytes": os.path.getsize(final),
            "vcodec": meta.get("vcodec") or e.get("vcodec"),
            "width": meta.get("width") or e.get("width"),
            "height": meta.get("height") or e.get("height"),
            "fps": meta.get("fps") or e.get("fps"),
            "duration": meta.get("duration") or e.get("duration"),
            "transcoded": transcoded,
            "audio_only": audio_only,
        }
        items.append(item)
        if emit:
            emit({"event": "item", **item})
    return {"items": items, "site": preset.NAME, "url": norm, "warnings": logger.warnings}
