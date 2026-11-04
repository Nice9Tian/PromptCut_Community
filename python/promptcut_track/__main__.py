"""Command-line entry: python -m promptcut_track <subcommand>

Subcommands: status / install / track
The output convention matches promptcut_stt and promptcut_shots: stdout has one JSON per line,
stderr carries hints for humans.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional

# Reuse the speech-to-text JSONL helpers: UTF-8 and newline handling on the Windows console is tricky, and we want to maintain only one copy.
from promptcut_stt.jsonl import emit, emit_error, emit_log, warn

from . import __version__, is_media_url
from .tracker import MODEL_FILENAME

REQUIREMENTS = "requirements-track.txt"


# Global command-line options (placed before the subcommand) override environment variables. When the Cloud Agent service starts this process through the workspace,
# the workspace strips all PROMPTCUT_* environment variables (so the service's own configuration does not leak into the child process),
# so the interpreter, dependency directory, weights directory, and ffmpeg are passed in by the service through these options according to the deployment configuration.
# They come only from the deployer's configuration, never from parameters supplied by the model.
_OVERRIDES: Dict[str, Optional[str]] = {}


def env_paths() -> Dict[str, Optional[str]]:
    return {
        "pylibs": _OVERRIDES.get("pylibs") or os.environ.get("PROMPTCUT_PYLIBS") or None,
        "models": _OVERRIDES.get("models") or os.environ.get("PROMPTCUT_MODELS") or None,
        "data_dir": os.environ.get("PROMPTCUT_DATA_DIR") or None,
        "ffmpeg": _OVERRIDES.get("ffmpeg") or os.environ.get("PROMPTCUT_FFMPEG") or shutil.which("ffmpeg"),
    }


def models_dir(paths: Dict[str, Optional[str]]) -> str:
    if paths["models"]:
        return paths["models"]
    if paths["data_dir"]:
        return os.path.join(paths["data_dir"], "models")
    return os.path.join(os.path.expanduser("~"), ".promptcut", "models")


def add_pylibs(pylibs: Optional[str]) -> None:
    if pylibs and os.path.isdir(pylibs) and pylibs not in sys.path:
        sys.path.insert(0, pylibs)


def model_path(paths: Dict[str, Optional[str]]) -> str:
    return os.path.join(models_dir(paths), MODEL_FILENAME)


def probe(paths: Dict[str, Optional[str]]) -> Dict[str, Any]:
    """Report which tier it can run at.

    ready only describes the neural-network tier (torch installed + weights present). **It does not mean "whether tracking is possible"**:
    when it is not ready there is still the numpy template-matching fallback, and that tier runs as long as numpy and ffmpeg are present,
    and numpy is in the base runtime. The two must be reported separately, otherwise the caller would read "extension not installed"
    as "this feature is unavailable".
    """
    add_pylibs(paths["pylibs"])
    runtime: Dict[str, Any] = {"installed": False, "version": None}
    try:
        import torch  # noqa: F401

        runtime = {"installed": True, "version": torch.__version__}
    except Exception as exc:
        runtime["error"] = str(exc)

    mp = model_path(paths)
    model = {"path": mp, "exists": os.path.isfile(mp)}
    if model["exists"]:
        model["bytes"] = os.path.getsize(mp)

    fallback: Dict[str, Any] = {"available": False}
    try:
        import numpy  # noqa: F401

        fallback = {"available": bool(paths["ffmpeg"]), "numpy": numpy.__version__}
        if not paths["ffmpeg"]:
            fallback["error"] = "ffmpeg not found"
    except Exception as exc:
        fallback["error"] = str(exc)

    ready = bool(runtime["installed"] and model["exists"])
    return {
        "ready": ready,
        "engine": "bootstapir" if ready else ("template" if fallback["available"] else None),
        "runtime": runtime,
        "model": model,
        "fallback": fallback,
        "ffmpeg": paths["ffmpeg"],
    }


def cmd_status(_args: argparse.Namespace) -> int:
    info = probe(env_paths())
    emit({"event": "status", "version": __version__, **info})
    return 0


def cmd_install(_args: argparse.Namespace) -> int:
    paths = env_paths()
    target = paths["pylibs"]
    if not target:
        emit_error("PROMPTCUT_PYLIBS is not set, so it is unknown where to install the dependencies.", code="pylibs-missing")
        return 2

    # --requirements is for deployers only (it points to a manifest with pinned versions and hashes); the default is the one shipped inside the package
    req = _OVERRIDES.get("requirements") or os.path.join(os.path.dirname(os.path.abspath(__file__)), REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"Dependency manifest {REQUIREMENTS} not found", code="requirements-missing")
        return 2

    os.makedirs(target, exist_ok=True)
    # Must use sys.executable: the built-in interpreter's own pip. Hard-coding "python" would end up using the system's
    # This process was started in isolated mode (-I) (Cloud Agent service: the working directory is the chat workspace), and pip is also started in isolated mode, otherwise `-m pip` would put the current directory at the very front of the module search path.
    isolated = ["-I"] if sys.flags.isolated else []
    cmd = [sys.executable, *isolated, "-m", "pip", "install", "--target", target, "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
    except OSError as exc:
        emit_error(f"Cannot start pip: {exc}")
        return 2

    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(
            f"pip install failed (exit code {code}). torch is over 190 MB, "
            "so the usual causes are a network interruption or insufficient disk space."
        )
        return 1

    info = probe(paths)
    needs_model = not info["model"]["exists"]
    if needs_model:
        warn(f"Dependencies are installed, but the model file {info['model']['path']} is still missing; it is provided by the extension library package.")
    emit({"event": "installed", "needsModel": needs_model, **info})
    # Same as promptcut_shots: the exit code only says whether pip succeeded. The BootsTAPIR weights are 208 MB,
    # not in requirements, they ship only with the extension library package. If `0 if ready else 1` were used, the user would
    # finish downloading 190 MB of torch and then receive "process exit code 1", even though the dependencies were in fact installed.
    return 0


def _parse_points(raw: str) -> List[List[float]]:
    """--points takes JSON: [[frame number, x, y], ...], with coordinates in original video pixels."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"--points is not valid JSON: {exc}") from exc
    if not isinstance(data, list) or not data:
        raise ValueError("--points needs at least one point")
    out: List[List[float]] = []
    for item in data:
        if not isinstance(item, (list, tuple)) or len(item) != 3:
            raise ValueError("Each point must be written as [frame number, x, y]")
        out.append([float(item[0]), float(item[1]), float(item[2])])
    return out


def _track_template(paths: Dict[str, Optional[str]], video: str,
                    queries_px: List[List[float]]) -> int:
    """Fallback tier. The output format is **field-for-field identical** to the neural-network tier; only engine differs.

    The identical format is deliberate: callers (the Node server, MCP tools, a future UI) should not have to write
    a separate parser for each of the two tiers. Look at the engine field to see which tier ran; everything else is the same.
    """
    from .template import decode_gray, track_template

    try:
        frames, src, dst = decode_gray(paths["ffmpeg"], video)
    except Exception as exc:
        emit_error(str(exc))
        return 1
    emit({"event": "progress", "phase": "decoded",
          "frames": int(len(frames)), "width": src[0], "height": src[1]})

    # The user gives original pixels but decoding scaled the frames, so convert to the decode resolution before matching
    sx, sy = dst[0] / src[0], dst[1] / src[1]
    queries = [(p[0], p[1] * sx, p[2] * sy) for p in queries_px]

    def on_progress(done: int, total: int) -> None:
        emit({"event": "progress", "phase": "track",
              "percent": round(done * 100 / max(total, 1), 1),
              "points": done, "total": total})

    try:
        result = track_template(frames, queries, on_progress=on_progress)
    except Exception as exc:
        emit_error(f"Tracking failed: {exc}")
        return 1

    emit({
        "event": "result",
        "engine": "template",
        "width": src[0],
        "height": src[1],
        "frames": int(len(frames)),
        "points": [
            {
                "query": queries_px[i],
                # Convert back to original pixels, so the frontend does not need to care how large this tier decoded to
                "xy": [[round(float(x) / sx, 2), round(float(y) / sy, 2)]
                       for x, y in result["tracks"][i]],
                "visible": [bool(v) for v in result["visible"][i]],
                **({"note": result["notes"][i]} if result["notes"][i] else {}),
            }
            for i in range(len(queries_px))
        ],
    })
    return 0


def cmd_track(args: argparse.Namespace) -> int:
    paths = env_paths()
    info = probe(paths)
    if not paths["ffmpeg"]:
        emit_error("ffmpeg not found, cannot decode the video.", code="ffmpeg-missing")
        return 2
    if not (is_media_url(args.video) or os.path.isfile(args.video)):
        emit_error(f"Video file not found: {args.video}", code="video-missing")
        return 2

    try:
        queries_px = _parse_points(args.points)
    except ValueError as exc:
        emit_error(str(exc), code="bad-points")
        return 2

    engine = args.engine or info["engine"]
    if engine is None:
        emit_error("The motion tracking extension is not installed and the fallback tier is unavailable too", code="engine-unavailable", detail=info)
        return 2
    if engine == "bootstapir" and not info["ready"]:
        emit_error("The motion tracking extension is not ready", code="engine-unavailable", detail=info)
        return 2

    # The whole video has to be decoded into memory: estimate the frame count first and **reject outright** if it exceeds the limit, no truncation.
    # Truncation would make the trajectory cover only the first half of the video, while attach_clip_motion aligns times assuming "the trajectory covers the whole asset",
    # Truncating silently means silently getting the timing wrong.
    if args.max_frames:
        from .tracker import estimate_frames

        est = estimate_frames(paths["ffmpeg"], args.video)
        if est is not None and est > args.max_frames:
            emit_error(
                f"The video has about {est} frames, more than the {args.max_frames} frames this machine can track at once; please trim the media shorter before tracking.",
                code="too-long", frames=est, limit=args.max_frames,
            )
            return 2
    if engine == "template":
        return _track_template(paths, args.video, queries_px)

    from .tracker import decode_frames, load_model, scale_points, track

    try:
        frames, src = decode_frames(paths["ffmpeg"], args.video)
    except Exception as exc:
        emit_error(str(exc))
        return 1
    emit({"event": "progress", "phase": "decoded",
          "frames": int(len(frames)), "width": src[0], "height": src[1]})

    # Convert the point coordinates to model space; frame numbers stay unchanged
    xy = scale_points([[p[1], p[2]] for p in queries_px], src, to_model=True)
    queries = [(queries_px[i][0], float(xy[i][0]), float(xy[i][1]))
               for i in range(len(queries_px))]

    model = load_model(info["model"]["path"])

    def on_progress(done: int, total: int) -> None:
        emit({"event": "progress", "phase": "track",
              "percent": round(done * 100 / max(total, 1), 1),
              "frames": done, "total": total})

    try:
        result = track(model, frames, queries, on_progress=on_progress)
    except Exception as exc:
        emit_error(f"Tracking failed: {exc}")
        return 1

    # Convert the trajectories back to original pixel coordinates before handing them out, so the frontend does not need to care about the model's 256 space
    back = scale_points(result["tracks"], src, to_model=False)
    emit({
        "event": "result",
        "engine": "bootstapir",
        "width": src[0],
        "height": src[1],
        "frames": int(len(frames)),
        "points": [
            {
                "query": queries_px[i],
                "xy": [[round(float(x), 2), round(float(y), 2)] for x, y in back[i]],
                "visible": [bool(v) for v in result["visible"][i]],
            }
            for i in range(len(queries_px))
        ],
    })
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_track")
    parser.add_argument("--pylibs", default=None, help="Third-party library directory (overrides PROMPTCUT_PYLIBS)")
    parser.add_argument("--models", default=None, help="Weights directory (overrides PROMPTCUT_MODELS)")
    parser.add_argument("--ffmpeg", default=None, help="ffmpeg executable (overrides PROMPTCUT_FFMPEG)")
    parser.add_argument("--requirements", default=None, help="Dependency manifest used by install (the default is the one shipped in the package)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Report whether the extension is ready").set_defaults(func=cmd_status)
    sub.add_parser("install", help="Install torch and other dependencies").set_defaults(func=cmd_install)

    t = sub.add_parser("track", help="Track points in a video")
    t.add_argument("--video", required=True)
    t.add_argument("--points", required=True,
                   help='JSON: [[frame number, x, y], ...], coordinates in original video pixels')
    t.add_argument("--engine", choices=["bootstapir", "template"], default=None,
                   help="Force which tier to use. By default it is chosen automatically from the engine reported by status")
    t.add_argument("--max-frames", type=int, default=0,
                   help="Reject videos with more frames than this (0 = unlimited)")
    t.set_defaults(func=cmd_track)

    args = parser.parse_args(argv)
    _OVERRIDES.clear()
    for key in ("pylibs", "models", "ffmpeg", "requirements"):
        value = getattr(args, key, None)
        if value:
            _OVERRIDES[key] = value
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001
        emit_error(f"Unexpected error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
