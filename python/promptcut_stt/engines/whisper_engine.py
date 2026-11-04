"""openai-whisper engine (PyTorch backend).

Alternative engine. It requires installing torch, which is much bigger; the upside is the official large-series weights and more decoding options.
"""

from __future__ import annotations

import importlib.util
import os
from typing import Any, Callable, Dict, List, Optional

from . import EngineNotInstalled, ModelNotInstalled, cuda_available

ENGINE_NAME = "whisper"

_MODULE = "whisper"
_DIST = "openai-whisper"


def probe() -> Dict[str, Any]:
    """Probe the installation status. Swallow any exception: the status subcommand must always be able to return successfully."""
    result: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        if importlib.util.find_spec(_MODULE) is None:
            result["error"] = f"Module {_MODULE} not found"
            return result
    except Exception as exc:
        result["error"] = f"Probing {_MODULE} failed: {exc}"
        return result

    try:
        module = __import__(_MODULE)
        # Many modules share the name (the name whisper is not exclusive), and one without load_model is not the one we want.
        if not hasattr(module, "load_model"):
            result["error"] = "Found a module named whisper, but it is not openai-whisper"
            return result
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


def _resolve_device(device: Optional[str]) -> str:
    """whisper only recognizes cpu / cuda and has no concept of compute_type."""
    choice = (device or "auto").lower()
    if choice in ("cpu", "cuda"):
        return choice
    return "cuda" if cuda_available() else "cpu"


def local_models(models_dir: Optional[str], catalog: List[str]) -> List[str]:
    """Models for which <name>.pt already exists in the model directory (only names in the catalog are recognized). Never raises an exception."""
    found: List[str] = []
    if not models_dir or not os.path.isdir(models_dir):
        return found
    for name in catalog:
        try:
            if os.path.isfile(os.path.join(models_dir, name + ".pt")):
                found.append(name)
        except Exception:
            continue
    return found


def _load():
    try:
        import whisper  # type: ignore

        return whisper
    except ImportError as exc:
        raise EngineNotInstalled(
            "whisper is not installed. Please run install --engine whisper first "
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
    whisper = _load()
    dev = _resolve_device(device)

    if offline and model not in local_models(models_dir, catalog or []):
        raise ModelNotInstalled(
            f"There are no whisper {model} model weights on this machine, and offline mode does not download over the network. "
            "Please ask the deployer to put the weights into the model directory."
        )

    whisper_model = whisper.load_model(model, device=dev, download_root=models_dir)
    result = whisper_model.transcribe(
        wav_path,
        language=language or None,
        verbose=False,
        fp16=(dev == "cuda"),  # running fp16 on CPU warns and falls back to fp32
    )

    raw_segments = result.get("segments") or []
    total: Optional[float] = None
    if raw_segments:
        total = float(raw_segments[-1].get("end") or 0.0) or None

    collected: List[Dict[str, Any]] = []
    # whisper decodes the whole thing in one go before returning, so the progress here is a "replay" rather than real time.
    # The contract requires emitting segment/progress per segment; it is enough to keep the format consistent.
    for item in raw_segments:
        seg = {
            "start": float(item.get("start") or 0.0),
            "end": float(item.get("end") or 0.0),
            "text": (item.get("text") or "").strip(),
        }
        collected.append(seg)
        on_segment(seg)
        on_progress(seg["end"], total)

    return {
        "segments": collected,
        "language": result.get("language") or language,
        "duration": total,
    }
