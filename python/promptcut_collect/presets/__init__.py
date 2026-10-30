"""站点预设。

一个预设就是一个模块，暴露：
  NAME        预设名（命令行 --site 用的）
  match(url)  这个链接归不归它管
  normalize(url)  把各种写法（短链、移动端、裸 BV 号）归成标准链接
  ydl_opts(...)   这个站点要的 yt-dlp 选项（请求头、清晰度上限、分 P 策略）
  notes           给 agent 看的一段提示（登录才有的清晰度、反爬之类）

找不到匹配的就用 generic：yt-dlp 自己认得一千多个站，generic 只是不加站点特化。
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
    raise KeyError(f"没有叫 {name} 的预设，可选：{', '.join(names())}")


def resolve(url: str, site: Optional[str] = None) -> Any:
    """按 --site 指定，没指定就按链接猜；都猜不出来用 generic。"""
    forced = by_name(site)
    if forced is not None:
        return forced
    for p in PRESETS:
        if p is not generic and p.match(url):
            return p
    return generic


def describe() -> List[Dict[str, Any]]:
    return [{"name": p.NAME, "notes": p.notes} for p in PRESETS]
