"""Line-by-line JSON (JSONL) output.

The caller (node side) parses stdout line by line, so the conventions are:
  - Each output is exactly one line, with one \\n at the end of the line;
  - Flush immediately after writing each line, otherwise the streamed progress gets buffered and cannot be seen;
  - ensure_ascii=False: Chinese text goes into the stream directly as UTF-8, not converted to \\uXXXX.

stderr is not JSON but hints for humans (ffmpeg missing, reasons for pip failures, etc.), written by warn().
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _force_utf8() -> None:
    """Fix stdout/stderr to UTF-8 + \\n newlines.

    The default code page of the Windows console is not UTF-8; if it is not changed, Chinese turns into garbled text or directly raises
    UnicodeEncodeError; if newlines are not fixed to \\n, Windows writes \\r\\n, and although line-by-line parsing
    still works, every line ends with an extra \\r. reconfigure only exists in Python 3.7+, and when the stream is replaced with
    StringIO (as is the case in unit tests) it does not have this method, so the whole block is wrapped in try.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
        except Exception:
            pass


_force_utf8()


def emit(obj: Any) -> None:
    """Output one line of JSON and flush immediately."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_log(line: str) -> None:
    """Forward one line of output from an external process (pip)."""
    emit({"event": "log", "line": line})


def emit_error(message: str, **extra: Any) -> None:
    """Emit an error event; the fields in extra are merged into the same object."""
    obj = {"event": "error", "message": message}
    obj.update(extra)
    emit(obj)


def warn(message: str) -> None:
    """Write one plain-language hint line to stderr (not JSON; the node side forwards it to the UI as is)."""
    sys.stderr.write(message.rstrip("\n") + "\n")
    sys.stderr.flush()
