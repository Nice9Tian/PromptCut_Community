"""Bilibili preset.

Tested in practice (2026-09-08, yt-dlp 2026.08.19):
  - A direct request without a browser User-Agent gets 412 Precondition Failed from Bilibili; with Chrome's
    UA and Referer it works fine. Back-to-back requests from the same machine still occasionally get 412, and retrying after a second or two succeeds,
    so 412 counts as "worth retrying" here, not "link broken".
  - Without logging in you get 1080p (30080), 720p, 480p and 360p, with video and audio streams separate,
    so ffmpeg is needed to merge them; the codecs are avc1 / hvc1 / av01, and in the editor browsers play avc1 most reliably.
  - 1080p60, 4K and Dolby are only given when logged in (and with a premium membership); to get them, pass cookies.
  - Multi-part uploads: a link with ?p=N downloads only that part; without p, yt-dlp treats it as a playlist,
    and by default only the first part is taken (noplaylist); only --all-parts downloads them all.
"""

from __future__ import annotations

import re
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

NAME = "bilibili"

notes = (
    "Bilibili. Supports BV id / av id / b23.tv short links / mobile links; up to 1080p without login, "
    "1080p60 and 4K require login (pass --cookies). For multi-part uploads, by default only the part named in the link is fetched."
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

_BV = re.compile(r"(BV[0-9A-Za-z]{10})")
_AV = re.compile(r"\bav(\d+)\b", re.IGNORECASE)
_HOSTS = ("bilibili.com", "b23.tv", "bilibili.tv")


def match(url: str) -> bool:
    u = url.strip()
    if _BV.fullmatch(u) or _AV.fullmatch(u):
        return True
    host = urlparse(u if "://" in u else "https://" + u).netloc.lower()
    return any(host == h or host.endswith("." + h) for h in _HOSTS)


def normalize(url: str) -> str:
    """Normalize the various forms into https://www.bilibili.com/video/<id>[?p=N].

    b23.tv short links are not expanded here: that needs a network request, so it is left to yt-dlp to follow the redirect.
    """
    u = url.strip()
    if _BV.fullmatch(u):
        return f"https://www.bilibili.com/video/{u}"
    if _AV.fullmatch(u):
        return f"https://www.bilibili.com/video/{u.lower()}"
    if "://" not in u:
        u = "https://" + u
    parsed = urlparse(u)
    host = parsed.netloc.lower()
    if host.endswith("b23.tv"):
        return u
    m = _BV.search(parsed.path) or _AV.search(parsed.path)
    if not m:
        return u
    vid = m.group(0) if m.re is _BV else "av" + m.group(1)
    page = parse_qs(parsed.query).get("p", [None])[0]
    out = f"https://www.bilibili.com/video/{vid}"
    if page and page.isdigit() and int(page) > 1:
        out += f"?p={int(page)}"
    return out


def ydl_opts(url: str, quality: int) -> Dict[str, Any]:
    return {
        "http_headers": {
            "User-Agent": USER_AGENT,
            "Referer": "https://www.bilibili.com/",
        },
        # For a link with p=, yt-dlp takes only that part; without it, only the first part is taken by default too; downloading them all must be turned on explicitly
        "noplaylist": True,
    }


def retryable(message: str) -> bool:
    m = message.lower()
    return "412" in m or "precondition failed" in m or "timed out" in m or "429" in m
