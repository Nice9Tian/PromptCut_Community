"""哔哩哔哩预设。

实测（2026-09-08，yt-dlp 2026.08.19）：
  - 不带浏览器 User-Agent 直接请求，B 站回 412 Precondition Failed；带上 Chrome 的
    UA 和 Referer 就正常。同一台机器连着请求偶尔仍会 412，隔一两秒重试就过——
    所以 412 在这里算「值得重试」，不是「链接坏了」。
  - 未登录能拿到 1080p（30080）、720p、480p、360p，视频流和音频流分开，
    要 ffmpeg 合并；编码有 avc1 / hvc1 / av01 三种，编辑台里浏览器播 avc1 最稳。
  - 1080p60、4K、杜比这些只有登录（且大会员）才给，要的话得传 cookies。
  - 多 P 稿件：链接带 ?p=N 就只下那一 P；不带 p 时 yt-dlp 会当播放列表，
    默认只取第一 P（noplaylist），--all-parts 才全下。
"""

from __future__ import annotations

import re
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

NAME = "bilibili"

notes = (
    "哔哩哔哩。支持 BV 号 / av 号 / b23.tv 短链 / 移动端链接；未登录最高 1080p，"
    "1080p60 与 4K 要登录（传 --cookies）。多 P 稿件默认只取链接指定的那一 P。"
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
    """把各种写法归成 https://www.bilibili.com/video/<id>[?p=N]。

    b23.tv 短链不在这里展开——那要发网络请求，交给 yt-dlp 跟随重定向。
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
        # 带 p= 的链接 yt-dlp 只取那一 P；不带的默认也只取第一 P，全下要显式开
        "noplaylist": True,
    }


def retryable(message: str) -> bool:
    m = message.lower()
    return "412" in m or "precondition failed" in m or "timed out" in m or "429" in m
