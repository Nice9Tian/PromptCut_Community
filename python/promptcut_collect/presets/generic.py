"""兜底预设：不加任何站点特化，全交给 yt-dlp 自己的 extractor。"""

from __future__ import annotations

from typing import Any, Dict

NAME = "generic"

notes = (
    "通用预设。yt-dlp 认得一千多个站点（YouTube、抖音、Twitter/X、Vimeo 等），"
    "这里只带浏览器 User-Agent，不做别的站点特化。"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def match(url: str) -> bool:
    return True


def normalize(url: str) -> str:
    url = url.strip()
    if url and not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    return url


def ydl_opts(url: str, quality: int) -> Dict[str, Any]:
    return {
        "http_headers": {"User-Agent": USER_AGENT},
        "noplaylist": True,
    }


def retryable(message: str) -> bool:
    """哪些报错值得等一等再试。默认只认明显的临时性错误。"""
    m = message.lower()
    return any(k in m for k in ("timed out", "timeout", "temporarily", "503", "429"))
