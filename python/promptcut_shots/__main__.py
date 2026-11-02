"""Command-line entry point: python -m promptcut_shots <subcommand>

Subcommands: status / install / detect
Output convention matches promptcut_stt: stdout is one JSON per line, stderr carries hints for humans.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, Optional

# Reuse the speech-to-text JSONL helpers: UTF-8 and newline handling on the Windows console is tricky, and we want to maintain only one copy.
from promptcut_stt.jsonl import emit, emit_error, emit_log, warn

from . import __version__, is_media_url
from .detector import MODEL_FILENAME

REQUIREMENTS = "requirements-shots.txt"


def env_paths() -> Dict[str, Optional[str]]:
    return {
        "pylibs": os.environ.get("PROMPTCUT_PYLIBS") or None,
        "models": os.environ.get("PROMPTCUT_MODELS") or None,
        "data_dir": os.environ.get("PROMPTCUT_DATA_DIR") or None,
        "ffmpeg": os.environ.get("PROMPTCUT_FFMPEG") or shutil.which("ffmpeg"),
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
    """Report whether it can run. Both conditions are required: onnxruntime is installed and the model file is present."""
    add_pylibs(paths["pylibs"])
    runtime: Dict[str, Any] = {"installed": False, "version": None}
    try:
        import onnxruntime  # noqa: F401

        runtime = {"installed": True, "version": onnxruntime.__version__}
    except Exception as exc:
        runtime["error"] = str(exc)

    mp = model_path(paths)
    model = {"path": mp, "exists": os.path.isfile(mp)}
    if model["exists"]:
        model["bytes"] = os.path.getsize(mp)

    return {
        "ready": bool(runtime["installed"] and model["exists"]),
        "runtime": runtime,
        "model": model,
        "ffmpeg": paths["ffmpeg"],
    }


def cmd_status(_args: argparse.Namespace) -> int:
    paths = env_paths()
    info = probe(paths)
    emit({"event": "status", "version": __version__, **info})
    return 0


def cmd_install(_args: argparse.Namespace) -> int:
    """Install onnxruntime into pylibs. The model file is provided by the extension package; here it is only checked."""
    paths = env_paths()
    pylibs = paths["pylibs"]
    if not pylibs:
        emit_error("PROMPTCUT_PYLIBS is not set, so there is nowhere to install the dependencies.")
        return 2
    os.makedirs(pylibs, exist_ok=True)

    # The manifest lives inside the package: this package is mirrored under pylibs and run from there, so one kept outside it would be lost
    here = os.path.dirname(os.path.abspath(__file__))
    req = os.path.join(here, REQUIREMENTS)
    if not os.path.isfile(req):
        # Compatible with the earlier layout that put the manifest under the python/ root
        req = os.path.join(os.path.dirname(here), REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"Cannot find dependency manifest {REQUIREMENTS}")
        return 2

    # Must use sys.executable: hard-coding "python" would install into the system interpreter
    cmd = [sys.executable, "-m", "pip", "install", "--target", pylibs, "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
    except OSError as exc:
        emit_error(f"Cannot start pip: {exc}")
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(f"pip install failed (exit code {code}). Common causes: network unreachable, or no matching onnxruntime wheel for this platform.")
        return 1

    info = probe(env_paths())
    needs_model = not info["model"]["exists"]
    if needs_model:
        warn(f"Dependencies are installed, but the model file {info['model']['path']} is still missing; it is provided by the extension library package.")
    emit({"event": "installed", "needsModel": needs_model, **info})
    # The exit code only reflects whether **this step** succeeded: 0 once pip has finished installing.
    #
    # It used to be `0 if ready else 1`, and ready also requires the model file to be present, but the model is an ONNX we converted ourselves
    # from the official TF weights; pip cannot fetch it at all, and it ships only with the extension library package. So the online install
    # path was **doomed** to end with exit code 1: the dependencies were installed, yet the UI just said "process exit code 1",
    # and the user knew neither how far the installation got nor what to do next.
    # Whether it is usable is answered by status; it should not be a side job of the install exit code.
    return 0


def apply_globals(args: argparse.Namespace) -> None:
    """When the Cloud Agent service starts this package, none of the PROMPTCUT_* environment variables are passed (the workspace allowlist),
    so the model directory and the dependency directory go through the command line instead. The desktop app does not use these options, and its behavior is unchanged."""
    if getattr(args, "models_dir", None):
        os.environ["PROMPTCUT_MODELS"] = args.models_dir
    if getattr(args, "pylibs", None):
        os.environ["PROMPTCUT_PYLIBS"] = args.pylibs
    if getattr(args, "local_only", False):
        from . import detector as D

        D.LOCAL_ONLY = True


def cmd_detect(args: argparse.Namespace) -> int:
    paths = env_paths()
    add_pylibs(paths["pylibs"])
    info = probe(paths)
    if not info["ready"]:
        emit_error("Shot detection extension is not ready", detail=info)
        return 3
    if not paths["ffmpeg"]:
        emit_error("ffmpeg not found, cannot decode the video.")
        return 2
    if getattr(args, "local_only", False) and is_media_url(args.video):
        emit_error("This run may only read local files and cannot connect to network addresses.")
        return 2
    if not (is_media_url(args.video) or os.path.isfile(args.video)):
        emit_error(f"Video file not found: {args.video}")
        return 2

    from .detector import (decode_frames, load_session, predict,
                           shots_from_transitions, transitions_from_probs)

    try:
        frames = decode_frames(paths["ffmpeg"], args.video)
    except RuntimeError as exc:
        emit_error(str(exc))
        return 1

    fps = args.fps
    duration = len(frames) / fps
    emit({"event": "progress", "phase": "decoded", "frames": int(len(frames)),
          "fps": fps, "duration": round(duration, 3)})

    session = load_session(info["model"]["path"])
    last = [-1]

    def on_progress(done: int, total: int) -> None:
        pct = int(done * 100 / max(1, total))
        # Report once every 5%, so stdout is not flooded
        if pct >= last[0] + 5:
            last[0] = pct
            emit({"event": "progress", "phase": "infer", "percent": pct,
                  "window": done, "windows": total})

    centers, extents = predict(frames, session, on_progress)
    transitions = transitions_from_probs(centers, extents, fps, args.threshold)
    shots = shots_from_transitions(transitions, duration)

    emit({
        "event": "result",
        "engine": "transnetv2",
        "fps": fps,
        "duration": round(duration, 3),
        "frames": int(len(frames)),
        "threshold": args.threshold,
        "transitions": transitions,
        "shots": shots,
    })
    return 0


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_shots")
    parser.add_argument("--models-dir", default=None, help="Weights directory (overrides PROMPTCUT_MODELS)")
    parser.add_argument("--pylibs", default=None, help="Dependency directory (overrides PROMPTCUT_PYLIBS)")
    parser.add_argument("--local-only", action="store_true",
                        help="ffmpeg reads local files only and connects to no network address")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Report whether the extension is ready").set_defaults(func=cmd_status)
    sub.add_parser("install", help="Install the onnxruntime dependency").set_defaults(func=cmd_install)

    d = sub.add_parser("detect", help="Detect shot changes")
    d.add_argument("video")
    d.add_argument("--fps", type=float, required=True,
                   help="Video frame rate, obtained by the caller with ffprobe and passed in")
    d.add_argument("--threshold", type=float, default=0.5)
    d.set_defaults(func=cmd_detect)

    args = parser.parse_args(argv)
    apply_globals(args)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # Fallback: never let a traceback smear onto stdout and dirty the JSONL
        emit_error(f"Unexpected error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
