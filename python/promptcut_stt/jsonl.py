"""逐行 JSON（JSONL）输出。

调用方（node 侧）按行解析 stdout，所以约定：
  - 每次输出恰好一行，行尾一个 \\n；
  - 每行写完立刻 flush，否则流式进度会被缓冲住看不到；
  - ensure_ascii=False，中文直接以 UTF-8 落到流里，不转成 \\uXXXX。

stderr 不是 JSON，是给人看的提示（缺 ffmpeg、pip 失败原因等），由 warn() 输出。
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _force_utf8() -> None:
    """把 stdout/stderr 固定成 UTF-8 + \\n 换行。

    Windows 控制台默认代码页不是 UTF-8，不改的话中文会变成乱码或直接抛
    UnicodeEncodeError；换行不固定成 \\n 的话 Windows 会写成 \\r\\n，按行解析虽然
    还能用但每行尾会多一个 \\r。reconfigure 在 Python 3.7+ 才有，且流被替换成
    StringIO（单元测试里就是这样）时没有这个方法，所以整段用 try 包住。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
        except Exception:
            pass


_force_utf8()


def emit(obj: Any) -> None:
    """输出一行 JSON 并立刻 flush。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_log(line: str) -> None:
    """转发一行外部进程（pip）的输出。"""
    emit({"event": "log", "line": line})


def emit_error(message: str, **extra: Any) -> None:
    """输出一个错误事件；extra 里的字段并进同一个对象。"""
    obj = {"event": "error", "message": message}
    obj.update(extra)
    emit(obj)


def warn(message: str) -> None:
    """写一行人话提示到 stderr（不是 JSON，node 侧原样转发给界面）。"""
    sys.stderr.write(message.rstrip("\n") + "\n")
    sys.stderr.flush()
