"""Command-line entry point: python -m promptcut_subject <subcommand>

Subcommands: status / install / detect
Output convention matches promptcut_shots / promptcut_stt: stdout is one JSON per line,
stderr carries hints for humans.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

# Reuse the speech-to-text JSONL helpers: UTF-8 and newline handling on the Windows console is tricky, and we want to maintain only one copy.
from promptcut_stt.jsonl import emit, emit_error, emit_log, warn

from . import __version__, is_media_url

REQUIREMENTS = {
    "light": "requirements-subject-light.txt",
    "full": "requirements-subject-full.txt",
}

YUNET_FILE = "yunet.onnx"
RTDETR_FILE = "rtdetr_r18vd.onnx"
DINO_DIR = "grounding-dino-tiny"

DEFAULT_MAX_SIDE = 640


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


def _file_entry(path: str) -> Dict[str, Any]:
    entry: Dict[str, Any] = {"path": path, "exists": os.path.isfile(path)}
    if entry["exists"]:
        entry["bytes"] = os.path.getsize(path)
    return entry


def _dir_entry(path: str) -> Dict[str, Any]:
    """DINO is a whole HF snapshot directory; checking only whether the directory exists is not enough, the weight files must be there too.

    The criterion directly borrows dino.model_ready() (config.json + model.safetensors +
    preprocessor_config.json + tokenizer_config.json are all present, and of tokenizer.json /
    vocab.txt at least one is present; the empirical basis of the criterion is described in the passage above dino.REQUIRED_FILES):
    When an interrupted copy leaves half a directory, looking only at "directory exists + has a .safetensors" would report ready and then
    blow up at load time, so the criterion must be the same one used by the code that actually loads the model. dino.py only imports numpy at top level, so status pulling it
    in does not bring torch along; in case even it cannot be imported (the package was trimmed), fall back to the original
    lenient criterion, which guarantees that status can output a contract-conforming line of JSON in any environment.
    """
    try:
        from .dino import model_ready

        return {"path": path, "exists": bool(model_ready(path))}
    except Exception:
        ok = os.path.isdir(path) and os.path.isfile(os.path.join(path, "config.json"))
        if ok:
            ok = any(name.endswith(".safetensors") for name in os.listdir(path))
        return {"path": path, "exists": bool(ok)}


def probe(paths: Dict[str, Optional[str]]) -> Dict[str, Any]:
    """Report whether each of the two tiers can run. A complete structure must be returned even when nothing is installed; it must not raise."""
    add_pylibs(paths["pylibs"])
    md = models_dir(paths)

    light_runtime: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        import onnxruntime  # noqa: F401

        light_runtime = {"installed": True, "version": onnxruntime.__version__, "error": None}
    except Exception as exc:
        light_runtime["error"] = str(exc)

    light_models = {
        "yunet": _file_entry(os.path.join(md, YUNET_FILE)),
        "rtdetr": _file_entry(os.path.join(md, RTDETR_FILE)),
    }
    light_ready = bool(light_runtime["installed"]
                       and light_models["yunet"]["exists"]
                       and light_models["rtdetr"]["exists"])

    full_runtime: Dict[str, Any] = {"installed": False, "version": None,
                                    "torch": None, "transformers": None, "error": None}
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401

        full_runtime = {"installed": True, "version": torch.__version__,
                        "torch": torch.__version__,
                        "transformers": transformers.__version__, "error": None}
    except Exception as exc:
        full_runtime["error"] = str(exc)

    full_models = {"dino": _dir_entry(os.path.join(md, DINO_DIR))}
    full_ready = bool(full_runtime["installed"] and full_models["dino"]["exists"])

    # engine is "which tier can actually run right now": report full if full can run (it is a superset of light),
    # otherwise fall back to light, and if neither tier works it is null (the UI uses this to prompt installing the extension package).
    engine = "full" if full_ready else ("light" if light_ready else None)

    return {
        "engine": engine,
        "light": {"ready": light_ready, "runtime": light_runtime, "models": light_models},
        "full": {"ready": full_ready, "runtime": full_runtime, "models": full_models},
        "modelsDir": md,
        "ffmpeg": paths["ffmpeg"],
    }


def cmd_status(_args: argparse.Namespace) -> int:
    paths = env_paths()
    info = probe(paths)
    emit({"event": "status", "version": __version__, **info})
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    """Install the inference dependencies into pylibs. The model files are provided by the extension package; here they are only checked."""
    paths = env_paths()
    pylibs = paths["pylibs"]
    if not pylibs:
        emit_error("PROMPTCUT_PYLIBS is not set, so there is nowhere to install the dependencies.")
        return 2
    os.makedirs(pylibs, exist_ok=True)

    tier = args.tier
    # The manifest lives inside the package: this package is mirrored under pylibs and run from there, so one kept outside it would be lost.
    # --requirements: the cloud deployer supplies a manifest with pinned versions, overriding the one inside the package (the model cannot change it).
    here = os.path.dirname(os.path.abspath(__file__))
    req = args.requirements or os.path.join(here, REQUIREMENTS[tier])
    if not os.path.isfile(req):
        emit_error(f"Cannot find dependency manifest {os.path.basename(req)}")
        return 2

    # Must use sys.executable: hard-coding "python" would install into the system interpreter
    # This process was started in isolated mode (-I) (Cloud Agent service: the working directory is the chat workspace), and pip is also started in isolated mode, otherwise `-m pip` would put the current directory at the very front of the module search path.
    isolated = ["-I"] if sys.flags.isolated else []
    cmd = [sys.executable, *isolated, "-m", "pip", "install", "--target", pylibs, "-r", req]
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
        emit_error(f"pip install failed (exit code {code}). Common causes: network unreachable, or no matching wheel for this platform.")
        return 1

    info = probe(env_paths())
    missing = [k for k, v in info[tier]["models"].items() if not v["exists"]]
    if missing:
        warn(f"Dependencies are installed, but models are still missing: {', '.join(missing)}; they are provided by the extension library package.")
    # The exit code only reflects whether **this step** succeeded: 0 once pip has finished installing. The models ship with the extension package, and pip
    # cannot fetch them; if ready were used as the exit code, the online install path would be doomed to end with 1 (see the
    # same comment in shots). Whether it is usable is answered by status.
    emit({"event": "installed", "tier": tier, "needsModel": bool(missing), **info})
    return 0


def parse_times(text: str) -> List[float]:
    """Only the seconds that can be recognized. Fragments that cannot be understood are left to parse_times_strict to report as errors."""
    return parse_times_strict(text)[0]


def parse_times_strict(text: str) -> Tuple[List[float], List[str]]:
    """Return (the recognized seconds, the fragments that could not be understood).

    It used to be a direct float(chunk), so a single mistyped character bubbled all the way up to main's fallback except and was reported as
    "Unexpected error: could not convert string to float: 'abc'", which looks like an internal failure,
    rather than "your argument is wrong". The HTTP side already filters with Number.isFinite, so this
    only affects people who type the CLI directly (packaging scripts, troubleshooting), but those are exactly the people who most need a plain-language sentence.
    """
    out: List[float] = []
    bad: List[str] = []
    for chunk in (text or "").replace(" ", "").split(","):
        if not chunk:
            continue
        try:
            value = float(chunk)
        except ValueError:
            bad.append(chunk)
            continue
        # nan / inf are also "not seconds": float("nan") does not raise, but using it for seek only makes it harder to track down
        if value != value or value in (float("inf"), float("-inf")):
            bad.append(chunk)
            continue
        out.append(max(0.0, value))
    return out, bad


def pick_engine(info: Dict[str, Any], requested: Optional[str],
                prompt: Optional[str]) -> Optional[str]:
    """Decide which tier to use this time.

    If one is specified explicitly, use it (if it is not ready, the call site reports the error). If none is specified: when a prompt is given and full
    is ready, go with full (only it understands prompts), otherwise prefer light: light is faster on CPU by an order of
    magnitude, and both tiers can answer "where are the people".
    """
    if requested:
        return requested
    if prompt and info["full"]["ready"]:
        return "full"
    if info["light"]["ready"]:
        return "light"
    if info["full"]["ready"]:
        return "full"
    return None


class _FirstInferenceFailed(Exception):
    """Inference fails on the very first frame. Only passed around inside cmd_detect; it never bubbles up to main's fallback except.

    It is a separate type to distinguish it from "suddenly breaking at frame 37": the latter is left to the outer fallback,
    while the former means this tier cannot run at all, and it is worth switching tier and starting over.
    """

    def __init__(self, cause: BaseException):
        super().__init__(str(cause))
        self.cause = cause


def cmd_detect(args: argparse.Namespace) -> int:
    paths = env_paths()
    add_pylibs(paths["pylibs"])
    info = probe(paths)

    if not paths["ffmpeg"]:
        emit_error("ffmpeg not found, cannot decode the video.")
        return 2
    if not (is_media_url(args.video) or os.path.isfile(args.video)):
        emit_error(f"Video file not found: {args.video}")
        return 2

    times, bad_times = parse_times_strict(args.times)
    if bad_times:
        emit_error(f"These entries in --times are not seconds: {', '.join(bad_times)}; write them as 1.2,5.4,8.8")
        return 2
    if not times:
        emit_error("There is not a single time point in --times.")
        return 2

    engine = pick_engine(info, args.engine, args.prompt)
    if engine is None:
        emit_error("Subject detection extension is not ready", detail=info)
        return 3
    if not info[engine]["ready"]:
        emit_error(f"{engine} tier is not ready", detail=info)
        return 3

    from . import frames as F
    from .safezone import analyze

    try:
        width, height = F.probe_size(paths["ffmpeg"], args.video)
    except RuntimeError as exc:
        emit_error(str(exc))
        return 1

    fw, fh = F.target_size(width, height, args.max_side)
    factor = width / float(fw) if fw else 1.0  # extracted frame → original pixels

    prompt = args.prompt or ""

    def make_runner(eng: str):
        """Build a "one frame in, boxes out" closure for a tier. engine is replaced when falling back to another tier, so engine must not be captured by the closure."""
        models = info[eng]["models"]

        def run_one(frame) -> List[Dict[str, Any]]:
            if eng == "light":
                from . import rtdetr, yunet

                boxes = yunet.detect([frame], model_path=models["yunet"]["path"])[0]
                boxes += rtdetr.detect([frame], model_path=models["rtdetr"]["path"])[0]
                return boxes
            # full tier: open vocabulary, the label comes straight from the nouns in the prompt
            from .dino import detect as dino_detect

            return dino_detect([frame], model_path=models["dino"]["path"],
                               prompt=prompt or "person . face .")[0]

        return run_one

    def run_all(eng: str):
        """Run all time points on the eng tier and return (samples, spent, failed_count).

        When **the first real inference** fails, raise _FirstInferenceFailed instead of swallowing it: that kind of failure
        (half-broken model directory, broken torch install, out of memory) would recur on every later frame, failing frame by frame,
        merely printing the same sentence 200 times. Raise it so the call site can decide whether to switch tier and start over.
        Note that the "first inference" is not times[0]: for the first few time points even the frame may fail to be extracted.
        """
        run_one = make_runner(eng)
        samples: List[Dict[str, Any]] = []
        spent: List[float] = []
        failed = 0
        total = len(times)
        for i, t in enumerate(times, 1):
            try:
                frame = F.grab_frame(paths["ffmpeg"], args.video, t, fw, fh)
            except RuntimeError as exc:
                # A single time point that cannot be extracted (beyond the duration, bad frame) should not fail the whole batch, but **a marker must be left**:
                # empty boxes + an occupancy of four 0s are identical field by field in the JSON to "this frame really has nobody",
                # if not marked, the reader side would average a string of 0s in and give the "nobody in this stretch, right side is safe"
                # false conclusion: exactly the kind of mistake this feature most needs to avoid. safeSide/occupancy are still written with
                # placeholder values (keeping the field shape unchanged so old readers do not crash on null); failed is the real criterion.
                warn(str(exc))
                failed += 1
                samples.append({"t": round(float(t), 3), "boxes": [],
                                "failed": True, "reason": str(exc),
                                "safeSide": "right",
                                "occupancy": {"left": 0.0, "right": 0.0,
                                              "top": 0.0, "bottom": 0.0}})
                emit({"event": "progress", "done": i, "total": total})
                continue

            t0 = time.perf_counter()
            try:
                raw = run_one(frame)
            except Exception as exc:
                if not spent:
                    raise _FirstInferenceFailed(exc) from exc
                raise
            spent.append(time.perf_counter() - t0)
            boxes = F.scale_boxes(raw, factor, width, height)
            samples.append({"t": round(float(t), 3), "boxes": boxes,
                            **analyze(width, height, boxes)})
            emit({"event": "progress", "done": i, "total": total})
        return samples, spent, failed

    fell_back_from: Optional[str] = None
    fallback_reason: Optional[str] = None
    try:
        samples, spent, failed = run_all(engine)
    except _FirstInferenceFailed as first:
        exc = first.cause
        detail = f"{type(exc).__name__}: {str(exc)[:300]}"
        dino_path = info["full"]["models"]["dino"]["path"]
        # the full tier blew up but light is ready: fall back and re-run **all** time points (not continue from where it stopped, since the boxes of the two tiers
        # do not line up, and mixed results cannot be interpreted). Light can also answer "where are the people",
        # it merely cannot answer the prompt, which is still better than failing the whole batch.
        if engine == "full" and info["light"]["ready"]:
            warn(f"Inference failed on the very first frame of the full tier ({detail}); falling back to light and re-running all {len(times)} time points. "
                 f"DINO model directory: {dino_path}")
            fell_back_from = "full"
            fallback_reason = detail
            if prompt:
                fallback_reason += "; the light tier only recognizes person/face, so the prompt this time had no effect"
            engine = "light"
            try:
                samples, spent, failed = run_all(engine)
            except _FirstInferenceFailed as second:
                emit_error(
                    f"Inference still failed on the first frame after falling back to light: "
                    f"{type(second.cause).__name__}: {str(second.cause)[:300]}"
                    f" (the original full-tier error was {detail}, DINO model directory {dino_path})",
                    detail=info)
                return 3
        elif engine == "full":
            emit_error(
                f"Inference failed on the first frame in the full tier: {detail}; the light tier is also unavailable ("
                f"{info['light']['runtime']['error'] or 'model files incomplete'}), so it cannot fall back. "
                f"DINO model directory: {dino_path}",
                detail=info)
            return 3
        else:
            emit_error(
                f"Inference failed on the first frame in the light tier: {detail}. "
                f"Model directory: {info['modelsDir']} ({YUNET_FILE} / {RTDETR_FILE})",
                detail=info)
            return 3

    result: Dict[str, Any] = {
        "event": "result",
        "engine": engine,
        "width": width,
        "height": height,
        "prompt": prompt,
        "msPerFrame": round(sum(spent) * 1000 / len(spent), 1) if spent else None,
        # Number of samples whose frame extraction failed. The reading side uses it to know how many samples this conclusion rests on
        "failedCount": failed,
        "samples": samples,
    }
    if fell_back_from:
        result["fellBackFrom"] = fell_back_from
        result["fallbackReason"] = fallback_reason
    emit(result)
    return 0


def apply_globals(args: argparse.Namespace) -> None:
    """When the Cloud Agent service starts this package, none of the PROMPTCUT_* environment variables are passed (the workspace allowlist),
    so the model directory and the dependency directory go through the command line instead. The desktop app does not use these options, and its behavior is unchanged."""
    if getattr(args, "models_dir", None):
        os.environ["PROMPTCUT_MODELS"] = args.models_dir
    if getattr(args, "pylibs", None):
        os.environ["PROMPTCUT_PYLIBS"] = args.pylibs
    if getattr(args, "local_only", False):
        from . import frames as F

        F.LOCAL_ONLY = True


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_subject")
    parser.add_argument("--models-dir", default=None, help="Weights directory (overrides PROMPTCUT_MODELS)")
    parser.add_argument("--pylibs", default=None, help="Dependency directory (overrides PROMPTCUT_PYLIBS)")
    parser.add_argument("--local-only", action="store_true",
                        help="ffmpeg / ffprobe only read local files and never connect to any network address")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Report whether the two-tier extension is ready").set_defaults(func=cmd_status)

    ins = sub.add_parser("install", help="Install inference dependencies")
    ins.add_argument("--tier", choices=["light", "full"], default="light")
    ins.add_argument("--requirements", default=None, help="Version-pinned dependency manifest (overrides the one inside the package)")
    ins.set_defaults(func=cmd_install)

    d = sub.add_parser("detect", help="Detect the subject at several points in time")
    d.add_argument("video")
    d.add_argument("--times", required=True, help="Comma-separated seconds, e.g. 1.2,5.4,8.8")
    d.add_argument("--prompt", default=None, help="Open-vocabulary prompt, only the full tier recognizes it")
    d.add_argument("--engine", choices=["light", "full"], default=None)
    d.add_argument("--max-side", type=int, default=DEFAULT_MAX_SIDE,
                   help="Longest side to scale down to when extracting frames (default 640)")
    d.set_defaults(func=cmd_detect)

    args = parser.parse_args(argv)
    try:
        apply_globals(args)
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # Fallback: never let a traceback smear onto stdout and dirty the JSONL
        emit_error(f"Unexpected error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
