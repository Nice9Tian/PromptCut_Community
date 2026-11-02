"""Site presets.

A preset is a module that exposes:
  NAME        preset name (used by the command-line --site)
  match(url)  whether this link belongs to this preset
  normalize(url)  turn the various forms (short link, mobile link, bare BV id) into a standard link
  ydl_opts(...)   the yt-dlp options this site needs (request headers, quality cap, multi-part strategy)
  notes           a hint for the agent to read (qualities only available when logged in, anti-scraping and the like)

If nothing matches, use generic: yt-dlp itself knows more than a thousand sites, and generic just adds no site-specific handling.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import bilibili, generic

PRESETS: List[Any] = [bilibili, generic]


def names() -> List[str]:
    return [p.NAME for p in PRESETS]


def by_name(name: Optional[str]) -> Any:
    if not name or name == "auto":
        return None
    for p in PRESETS:
        if p.NAME == name:
            return p
    raise KeyError(f"No preset named {name}, available: {', '.join(names())}")


def resolve(url: str, site: Optional[str] = None) -> Any:
    """Use the one given by --site; if none is given, guess from the link; if neither works, use generic."""
    forced = by_name(site)
    if forced is not None:
        return forced
    for p in PRESETS:
        if p is not generic and p.match(url):
            return p
    return generic


def describe() -> List[Dict[str, Any]]:
    return [{"name": p.NAME, "notes": p.notes} for p in PRESETS]
