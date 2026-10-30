"""openai-whisper 引擎（PyTorch 后端）。

备选引擎。要装 torch，体积大很多；好处是有官方 large 系列权重和更多解码选项。
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
    """探测安装状态。任何异常都要吞掉——status 子命令必须永远能成功返回。"""
    result: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        if importlib.util.find_spec(_MODULE) is None:
            result["error"] = f"未找到模块 {_MODULE}"
            return result
    except Exception as exc:
        result["error"] = f"探测 {_MODULE} 失败：{exc}"
        return result

    try:
        module = __import__(_MODULE)
        # 同名模块很多（whisper 这个名字并不独占），没有 load_model 就不是我们要的那个。
        if not hasattr(module, "load_model"):
            result["error"] = "找到了名为 whisper 的模块，但它不是 openai-whisper"
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
        result["error"] = f"导入 {_MODULE} 失败：{exc}"
    return result


def _resolve_device(device: Optional[str]) -> str:
    """whisper 只认 cpu / cuda，没有 compute_type 的概念。"""
    choice = (device or "auto").lower()
    if choice in ("cpu", "cuda"):
        return choice
    return "cuda" if cuda_available() else "cpu"


def local_models(models_dir: Optional[str], catalog: List[str]) -> List[str]:
    """模型目录里已经有 <名字>.pt 的模型（只认 catalog 里的名字）。绝不抛异常。"""
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
            "whisper 未安装。请先运行 install --engine whisper"
            "（或在界面上点「下载引擎」）。"
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
            f"这台机器上没有 whisper 的 {model} 模型权重，离线模式不会联网下载。"
            "请联系部署者把权重放进模型目录。"
        )

    whisper_model = whisper.load_model(model, device=dev, download_root=models_dir)
    result = whisper_model.transcribe(
        wav_path,
        language=language or None,
        verbose=False,
        fp16=(dev == "cuda"),  # CPU 上跑 fp16 会 warn 并退回 fp32
    )

    raw_segments = result.get("segments") or []
    total: Optional[float] = None
    if raw_segments:
        total = float(raw_segments[-1].get("end") or 0.0) or None

    collected: List[Dict[str, Any]] = []
    # whisper 一次性把整段解码完才返回，所以这里的进度是「回放」而不是实时。
    # 契约要求逐段输出 segment/progress，格式保持一致即可。
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
