"""faster-whisper engine (CTranslate2 backend).

Default engine. Uses int8 quantization on CPU, does not need torch, and its installed size is much smaller than openai-whisper.
"""

from __future__ import annotations

import importlib.util
import os
from typing import Any, Callable, Dict, List, Optional

from . import EngineNotInstalled, ModelNotInstalled, resolve_device

ENGINE_NAME = "faster-whisper"

_MODULE = "faster_whisper"
_DIST = "faster-whisper"


def probe() -> Dict[str, Any]:
    """Probe the installation status. Swallow any exception: the status subcommand must always be able to return successfully."""
    result: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        if importlib.util.find_spec(_MODULE) is None:
            result["error"] = f"Module {_MODULE} not found"
            return result
    except Exception as exc:  # find_spec may also raise because of a broken package on sys.path
        result["error"] = f"Probing {_MODULE} failed: {exc}"
        return result

    try:
        module = __import__(_MODULE)
        result["installed"] = True
        version = getattr(module, "__version__", None)
        if not version:
            try:
                from importlib.metadata import version as dist_version

                version = dist_version(_DIST)
            except Exception:
                version = None
        result["version"] = version
    except Exception as exc:
        result["error"] = f"Importing {_MODULE} failed: {exc}"
    return result


def _snapshot_has_model(models_dir: str, repo_dir: str) -> bool:
    """huggingface cache layout: weights count as complete only if both <models_dir>/<repo_dir>/snapshots/<rev>/model.bin and config.json are present."""
    snapshots = os.path.join(models_dir, repo_dir, "snapshots")
    try:
        revisions = os.listdir(snapshots)
    except OSError:
        return False
    for revision in revisions:
        base = os.path.join(snapshots, revision)
        if os.path.exists(os.path.join(base, "model.bin")) and os.path.exists(os.path.join(base, "config.json")):
            return True
    return False


def local_models(models_dir: Optional[str], catalog: List[str]) -> List[str]:
    """Names of the directories in the model directory whose weights are all in place (only names in the catalog are recognized). Never raises an exception."""
    found: List[str] = []
    if not models_dir or not os.path.isdir(models_dir):
        return found
    for name in catalog:
        try:
            if _snapshot_has_model(models_dir, "models--Systran--faster-whisper-" + name):
                found.append(name)
        except Exception:
            continue
    return found


def _load():
    try:
        from faster_whisper import WhisperModel  # type: ignore

        return WhisperModel
    except ImportError as exc:
        raise EngineNotInstalled(
            "faster-whisper is not installed. Please run install --engine faster-whisper first "
            "(or click \"Download engine\" in the UI)."
        ) from exc


def transcribe(
    wav_path: str,
    model: str,
    language: Optional[str],
    device: Optional[str],
    models_dir: Optional[str],
    on_segment: Callable[[Dict[str, Any]], None],
    on_progress: Callable[[float, Optional[float]], None],
    offline: bool = False,
    catalog: Optional[List[str]] = None,
) -> Dict[str, Any]:
    WhisperModel = _load()
    dev, compute_type = resolve_device(device)

    if offline and model not in local_models(models_dir, catalog or []):
        raise ModelNotInstalled(
            f"There are no faster-whisper {model} model weights on this machine, and offline mode does not download over the network. "
            "Please ask the deployer to put the weights into the model directory."
        )

    whisper_model = WhisperModel(
        model,
        device=dev,
        compute_type=compute_type,
        download_root=models_dir,
        local_files_only=bool(offline),
    )

    kwargs: Dict[str, Any] = {"beam_size": 5, "vad_filter": False}
    # An empty language means auto-detection: do not pass this argument, and let the engine decide by itself.
    if language:
        kwargs["language"] = language

    segments_iter, info = whisper_model.transcribe(wav_path, **kwargs)

    total = getattr(info, "duration", None)
    total = float(total) if total else None

    collected: List[Dict[str, Any]] = []
    # segments is a lazy generator: the real decoding happens during iteration, so progress events must be emitted inside this
    # loop, and cannot wait until it finishes.
    for item in segments_iter:
        seg = {
            "start": float(item.start),
            "end": float(item.end),
            "text": (item.text or "").strip(),
        }
        collected.append(seg)
        on_segment(seg)
        on_progress(seg["end"], total)

    return {
        "segments": collected,
        "language": getattr(info, "language", None) or language,
        "duration": total,
    }
