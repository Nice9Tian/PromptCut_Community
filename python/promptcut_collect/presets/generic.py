"""Fallback preset: no site-specific handling at all, everything is left to yt-dlp's own extractor."""

from __future__ import annotations

from typing import Any, Dict

NAME = "generic"

notes = (
    "Generic preset. yt-dlp knows more than a thousand sites (YouTube, Douyin, Twitter/X, Vimeo, etc.), "
    "Here only the browser User-Agent is sent, with no other site-specific handling."
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
    """Which errors are worth waiting a moment and retrying. By default only clearly transient errors are recognized."""
    m = message.lower()
    return any(k in m for k in ("timed out", "timeout", "temporarily", "503", "429"))
