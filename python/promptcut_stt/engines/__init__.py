"""Common part of the transcription engines.

Each engine module exposes three things, and __main__.py dispatches by name:
  ENGINE_NAME  engine name (same as the value of the command-line --engine)
  probe()      detect whether it is installed, never raises an exception
  transcribe(...) does the real work, raises EngineNotInstalled if it is not installed
"""

from __future__ import annotations

from typing import Optional, Tuple


class EngineNotInstalled(Exception):
    """The engine's third-party dependencies are not installed. The message must state clearly what to do next."""


class ModelNotInstalled(Exception):
    """In offline mode (--offline), the model weights to be used are not in the model directory.

    Offline mode must not download weights over the network: the weights of a cloud node are put in place beforehand by the deployer, and if they are missing, report it truthfully.
    """


def cuda_available() -> bool:
    """Whether a usable CUDA is available. Torch not installed or torch broken both count as not available.

    faster-whisper goes through CTranslate2 and does not need torch in the first place, so a probe failure here must silently
    downgrade to CPU; an optional dependency must not block transcription altogether.
    """
    try:
        import torch  # type: ignore

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def resolve_device(device: Optional[str]) -> Tuple[str, str]:
    """Resolve --device into (device, compute_type).

    auto: if CUDA is available, cuda + float16, otherwise cpu + int8 (int8 quantization lets the small model run
    at close to real time even on an ordinary CPU).
    """
    choice = (device or "auto").lower()
    if choice == "cuda":
        return "cuda", "float16"
    if choice == "cpu":
        return "cpu", "int8"
    if cuda_available():
        return "cuda", "float16"
    return "cpu", "int8"
