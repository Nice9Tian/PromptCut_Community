"""Command-line entry point: python -m promptcut_stt <subcommand>

Subcommands: status / models / install / transcribe
All normal output is one JSON per line (see jsonl.py), for the node side to parse line by line.
Human-readable hints go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

from . import __version__
from .engines import EngineNotInstalled, ModelNotInstalled, cuda_available
from .engines import faster_whisper_engine, whisper_engine
from .jsonl import emit, emit_error, emit_log, warn

ENGINES = {
    faster_whisper_engine.ENGINE_NAME: faster_whisper_engine,
    whisper_engine.ENGINE_NAME: whisper_engine,
}

DEFAULT_ENGINE = "faster-whisper"
DEFAULT_MODEL = "small"
DEFAULT_LANGUAGE = "zh"

# Approximate size of each model, used only for display in the models subcommand
MODEL_CATALOG: Dict[str, List[Dict[str, str]]] = {
    "faster-whisper": [
        {"name": "tiny", "size": "about 75 MB", "note": "Fastest, lowest accuracy, suitable for quick preview"},
        {"name": "base", "size": "about 145 MB", "note": "A bit steadier than tiny, still struggles with Chinese"},
        {"name": "small", "size": "about 480 MB", "note": "Default; close to real time on CPU int8, usable for Chinese"},
        {"name": "medium", "size": "about 1.5 GB", "note": "Clearly more accurate; takes about 3-5x real time on CPU"},
        {"name": "large-v3", "size": "about 3.1 GB", "note": "Most accurate; CUDA recommended, about 5 GB of VRAM"},
    ],
    "whisper": [
        {"name": "tiny", "size": "about 75 MB", "note": "Fastest, lowest accuracy"},
        {"name": "base", "size": "about 145 MB", "note": "Lightweight"},
        {"name": "small", "size": "about 480 MB", "note": "Default; runs on CPU but slower than faster-whisper"},
        {"name": "medium", "size": "about 1.5 GB", "note": "Fairly accurate, very slow on CPU"},
        {"name": "large", "size": "about 2.9 GB", "note": "Most accurate; needs CUDA to be practical"},
    ],
}


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------

def env_paths() -> Dict[str, Optional[str]]:
    """Read the environment variables in one place, to avoid scattering them around."""
    pylibs = os.environ.get("PROMPTCUT_PYLIBS") or None
    models = os.environ.get("PROMPTCUT_MODELS") or None
    data_dir = os.environ.get("PROMPTCUT_DATA_DIR") or None
    return {"pylibs": pylibs, "models": models, "data_dir": data_dir}


def resolve_models_dir(paths: Dict[str, Optional[str]], quiet: bool = False) -> str:
    """Model download directory: PROMPTCUT_MODELS → PROMPTCUT_DATA_DIR/models → temporary directory."""
    if paths["models"]:
        return paths["models"]
    if paths["data_dir"]:
        return os.path.join(paths["data_dir"], "models")
    fallback = os.path.join(tempfile.gettempdir(), "promptcut-models")
    if not quiet:
        warn(
            f"Neither PROMPTCUT_MODELS nor PROMPTCUT_DATA_DIR is set; models will be downloaded to the temporary directory {fallback}, "
            "and will have to be downloaded again after the system clears temporary files."
        )
    return fallback


def add_pylibs_to_path(pylibs: Optional[str]) -> None:
    """Put PROMPTCUT_PYLIBS at the very front of sys.path.

    In -I isolated mode PYTHONPATH still takes effect, but the caller may have forgotten to set it; here we insert it ourselves,
    which guarantees that as long as the environment variable is present, the installed engine can always be imported.
    """
    if pylibs and os.path.isdir(pylibs) and pylibs not in sys.path:
        sys.path.insert(0, pylibs)


def _writable(path: str) -> bool:
    """Whether the directory is writable. If it does not exist, try to create it first; if it cannot be created, it counts as not writable, and no exception is raised."""
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        return False
    try:
        probe = os.path.join(path, ".promptcut-write-test")
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("ok")
        os.remove(probe)
        return True
    except Exception:
        return False


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def list_models(models_dir: str) -> List[Dict[str, Any]]:
    """Scan the model directory and list first-level subdirectories and .pt files."""
    items: List[Dict[str, Any]] = []
    if not models_dir or not os.path.isdir(models_dir):
        return items
    try:
        entries = sorted(os.listdir(models_dir))
    except OSError:
        return items
    for name in entries:
        # huggingface-hub puts internal directories such as .locks / .no_exist under the cache root; they are not models
        if name.startswith("."):
            continue
        full = os.path.join(models_dir, name)
        if os.path.isdir(full):
            items.append({"name": name, "path": full, "bytes": _dir_size(full)})
        elif name.endswith(".pt"):
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            items.append({"name": name, "path": full, "bytes": size})
    return items


# --------------------------------------------------------------------------
# status
# --------------------------------------------------------------------------

def cmd_status(_args: argparse.Namespace) -> int:
    paths = env_paths()
    add_pylibs_to_path(paths["pylibs"])
    models_dir = resolve_models_dir(paths, quiet=True)

    pylibs = paths["pylibs"]
    pylibs_info: Dict[str, Any] = {"path": pylibs, "exists": False, "writable": False}
    if pylibs:
        pylibs_info["exists"] = os.path.isdir(pylibs)
        pylibs_info["writable"] = _writable(pylibs)
        # _writable may have just created the directory
        pylibs_info["exists"] = os.path.isdir(pylibs)

    engines: Dict[str, Any] = {}
    for name, module in ENGINES.items():
        try:
            engines[name] = module.probe()
        except Exception as exc:  # engine probing must never crash status
            engines[name] = {"installed": False, "version": None, "error": str(exc)}

    # For each engine, the names of the models whose weights are fully in place in the model directory. Offline transcription (--offline) uses only these.
    available_models: Dict[str, List[str]] = {}
    for name, module in ENGINES.items():
        catalog = [m["name"] for m in MODEL_CATALOG.get(name, [])]
        try:
            available_models[name] = module.local_models(models_dir, catalog)
        except Exception:
            available_models[name] = []

    emit(
        {
            "python": platform.python_version(),
            "executable": sys.executable,
            "package": __version__,
            "pylibs": pylibs_info,
            "models_dir": models_dir,
            "engines": engines,
            "cuda": cuda_available(),
            "models": list_models(models_dir),
            "available_models": available_models,
            "ffmpeg": shutil.which("ffmpeg"),
        }
    )
    return 0


# --------------------------------------------------------------------------
# models
# --------------------------------------------------------------------------

def cmd_models(_args: argparse.Namespace) -> int:
    emit(
        {
            "default_engine": DEFAULT_ENGINE,
            "engines": {
                "faster-whisper": {
                    "default": DEFAULT_MODEL,
                    "models": MODEL_CATALOG["faster-whisper"],
                    "note": "On CPU, int8 quantization is used by default, and VRAM/memory usage is about half of the model size; "
                            "it switches to float16 automatically when CUDA is available.",
                },
                "whisper": {
                    "default": DEFAULT_MODEL,
                    "models": MODEL_CATALOG["whisper"],
                    "note": "Depends on PyTorch; on CPU only up to small is recommended, anything larger needs CUDA.",
                },
            },
        }
    )
    return 0


# --------------------------------------------------------------------------
# install
# --------------------------------------------------------------------------

def find_requirements(engine: str) -> Optional[str]:
    """Locate requirements-<engine>.txt.

    During development the package is in <repo>/python/promptcut_stt/, and the level above is python/;
    once installed into site-packages the package is in <prefix>/Lib/site-packages/promptcut_stt/,
    and the level above is not python/, so sys.prefix must also be tried. Both are tried, and on failure the paths that were searched are reported.
    """
    filename = f"requirements-{engine}.txt"
    package_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(os.path.dirname(package_dir), filename),   # during development: python/
        os.path.join(sys.prefix, filename),                     # after packaging: runtime/python/
        os.path.join(sys.prefix, "python", filename),
        os.path.join(package_dir, filename),                    # fallback: next to the package
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    warn("No requirements file found, tried:\n  " + "\n  ".join(candidates))
    return None


def cmd_install(args: argparse.Namespace) -> int:
    paths = env_paths()
    target = paths["pylibs"]
    if not target:
        emit_error("The environment variable PROMPTCUT_PYLIBS is not set, so the install directory for third-party libraries cannot be determined.")
        return 1

    # --requirements: the caller (the controlled install job of a cloud node) specifies a dependency file with pinned versions,
    # instead of the default lookup in find_requirements. Only files are accepted, nothing else.
    if getattr(args, "requirements", None):
        req = os.path.abspath(args.requirements)
        if not os.path.isfile(req):
            emit_error(f"The specified dependency file does not exist: {req}", kind="requirements-missing")
            return 1
    else:
        req = find_requirements(args.engine)
    if not req:
        emit_error(
            f"requirements-{args.engine}.txt not found (searched the level above the package directory, "
            f"{sys.prefix} and other locations), cannot install."
        )
        return 1

    if not _writable(target):
        emit_error(f"The install directory is not writable: {target}")
        return 1

    # Must use sys.executable: the built-in interpreter's own pip. Hard-coding "python" would end up using the system's
    # interpreter, and the libraries would be installed in the wrong place.
    # This process was started in isolated mode (-I) (Cloud Agent service: the working directory is the chat workspace), and pip is also started in isolated mode, otherwise `-m pip` would put the current directory at the very front of the module search path.
    isolated = ["-I"] if sys.flags.isolated else []
    cmd = [sys.executable, *isolated, "-m", "pip", "install", "--target", target, "-r", req]
    if args.upgrade:
        cmd.append("--upgrade")
    if args.index_url:
        cmd += ["--index-url", args.index_url]
    if args.extra_index_url:
        cmd += ["--extra-index-url", args.extra_index_url]

    emit(
        {
            "event": "start",
            "engine": args.engine,
            "target": target,
            "requirements": req,
            "command": cmd,
        }
    )

    started = time.time()
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError as exc:
        emit_error(f"Cannot start pip: {exc}")
        return 1

    assert proc.stdout is not None
    saw_missing_pip = False
    for line in proc.stdout:
        line = line.rstrip("\r\n")
        if "No module named pip" in line:
            saw_missing_pip = True
        emit_log(line)
    code = proc.wait()
    seconds = round(time.time() - started, 1)

    if code == 0:
        emit(
            {
                "event": "done",
                "engine": args.engine,
                "target": target,
                "seconds": seconds,
            }
        )
        return 0

    if saw_missing_pip:
        emit_error(
            "The built-in interpreter lacks pip, so the engine cannot be installed. Please rerun the prepare-python script to put pip back.",
            code=code,
        )
    else:
        emit_error(
            f"pip install failed (exit code {code}). Common causes: network unreachable, "
            f"wrong index URL, insufficient disk space. See the log events above for the full log.",
            code=code,
        )
    return 1


# --------------------------------------------------------------------------
# transcribe
# --------------------------------------------------------------------------

def cmd_transcribe(args: argparse.Namespace) -> int:
    from .audio import AudioExtractError, FfmpegNotFound, ensure_wav, probe_duration

    paths = env_paths()
    add_pylibs_to_path(paths["pylibs"])
    models_dir = resolve_models_dir(paths)

    engine_name = args.engine
    module = ENGINES.get(engine_name)
    if module is None:
        emit_error(
            f"Unknown engine {engine_name}, available: {', '.join(sorted(ENGINES))}."
        )
        return 1

    offline = bool(getattr(args, "offline", False))
    if offline:
        # Offline mode: only the model weights already present locally are used, not a single byte is downloaded over the network (the huggingface switch must be set before import)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        known = [m["name"] for m in MODEL_CATALOG.get(engine_name, [])]
        if args.model not in known:
            emit_error(
                f"Offline mode only accepts the fixed model names ({', '.join(known)}), got: {args.model}",
                kind="model-missing",
            )
            return 1

    src = args.input
    if not os.path.isfile(src):
        emit_error(f"The input file does not exist: {src}", kind="input-missing")
        return 1

    # --language auto or empty string → auto-detect
    language: Optional[str] = args.language
    if language is not None and language.strip().lower() in ("", "auto"):
        language = None

    emit(
        {
            "event": "start",
            "engine": engine_name,
            "model": args.model,
            "language": language,
            "device": args.device,
            "input": os.path.abspath(src),
            "models_dir": models_dir,
        }
    )

    started = time.time()
    try:
        os.makedirs(models_dir, exist_ok=True)
    except Exception as exc:
        emit_error(f"Cannot create the model directory {models_dir}: {exc}")
        return 1

    with tempfile.TemporaryDirectory(prefix="promptcut-stt-") as tmpdir:
        try:
            wav_path, converted = ensure_wav(src, tmpdir, local_only=offline)
        except FfmpegNotFound as exc:
            emit_error(str(exc), kind="ffmpeg-missing")
            return 1
        except AudioExtractError as exc:
            emit_error(str(exc), kind=getattr(exc, "kind", "audio-extract"))
            return 1

        duration = probe_duration(wav_path)
        emit(
            {
                "event": "audio",
                "wav": wav_path,
                "duration": duration,
                "converted": converted,
            }
        )

        index = {"n": 0}

        def on_segment(seg: Dict[str, Any]) -> None:
            emit(
                {
                    "event": "segment",
                    "index": index["n"],
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                }
            )
            index["n"] += 1

        def on_progress(done: float, total: Optional[float]) -> None:
            emit({"event": "progress", "done": done, "total": total or duration})

        try:
            result = module.transcribe(
                wav_path,
                model=args.model,
                language=language,
                device=args.device,
                models_dir=models_dir,
                on_segment=on_segment,
                on_progress=on_progress,
                offline=offline,
                catalog=[m["name"] for m in MODEL_CATALOG.get(engine_name, [])],
            )
        except EngineNotInstalled as exc:
            emit_error(str(exc), kind="engine-missing")
            return 1
        except ModelNotInstalled as exc:
            emit_error(str(exc), kind="model-missing")
            return 1
        except Exception as exc:
            emit_error(f"Transcription failed ({engine_name} / {args.model}): {exc}", kind="transcribe-failed")
            return 1

    segments = result.get("segments") or []
    payload: Dict[str, Any] = {
        "event": "done",
        "segments": segments,
        "text": "".join(s["text"] for s in segments).strip(),
        "language": result.get("language") or language,
        "engine": engine_name,
        "model": args.model,
        "duration": result.get("duration") or duration,
        "seconds": round(time.time() - started, 1),
    }

    if args.out:
        out_path = os.path.abspath(args.out)
        parent = os.path.dirname(out_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        payload["out"] = out_path

    emit(payload)
    return 0


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="promptcut_stt",
        description="PromptCut speech-to-text: outputs line-by-line JSON.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="Report the interpreter, engine installation status, CUDA and downloaded models")
    sub.add_parser("models", help="List the available models and their approximate sizes")

    install = sub.add_parser("install", help="Install the engine dependencies into PROMPTCUT_PYLIBS")
    install.add_argument("--engine", choices=sorted(ENGINES), default=DEFAULT_ENGINE)
    install.add_argument("--index-url", dest="index_url", default=None)
    install.add_argument("--extra-index-url", dest="extra_index_url", default=None)
    install.add_argument("--upgrade", action="store_true")
    install.add_argument(
        "--requirements",
        dest="requirements",
        default=None,
        help="Use this dependency file (pinned versions) instead of the default requirements-<engine>.txt",
    )

    transcribe = sub.add_parser("transcribe", help="Transcribe a media file")
    transcribe.add_argument("--input", required=True, help="Any audio or video file, or wav")
    transcribe.add_argument("--engine", choices=sorted(ENGINES), default=DEFAULT_ENGINE)
    transcribe.add_argument("--model", default=DEFAULT_MODEL)
    transcribe.add_argument(
        "--language",
        default=DEFAULT_LANGUAGE,
        help="Language code, default zh; use auto for auto-detection",
    )
    transcribe.add_argument(
        "--device", choices=["auto", "cpu", "cuda"], default="auto"
    )
    transcribe.add_argument("--out", default=None, help="Also save the done event as a JSON file")
    transcribe.add_argument(
        "--offline",
        action="store_true",
        help="Offline mode (for cloud nodes): use only the weights already present locally and do not download over the network; ffmpeg reads local files only",
    )

    return parser


HANDLERS = {
    "status": cmd_status,
    "models": cmd_models,
    "install": cmd_install,
    "transcribe": cmd_transcribe,
}


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = HANDLERS[args.command]
    try:
        return handler(args)
    except KeyboardInterrupt:
        emit_error("Interrupted.")
        return 130
    except Exception as exc:  # Fallback: never throw a traceback at node as output
        emit_error(f"{args.command} failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
