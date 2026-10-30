"""faster-whisper 引擎（CTranslate2 后端）。

默认引擎。CPU 上用 int8 量化，不需要 torch，装机体积比 openai-whisper 小很多。
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
    """探测安装状态。任何异常都要吞掉——status 子命令必须永远能成功返回。"""
    result: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        if importlib.util.find_spec(_MODULE) is None:
            result["error"] = f"未找到模块 {_MODULE}"
            return result
    except Exception as exc:  # find_spec 也可能因为 sys.path 上有坏包而抛
        result["error"] = f"探测 {_MODULE} 失败：{exc}"
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
        result["error"] = f"导入 {_MODULE} 失败：{exc}"
    return result


def _snapshot_has_model(models_dir: str, repo_dir: str) -> bool:
    """huggingface 缓存布局：<models_dir>/<repo_dir>/snapshots/<rev>/model.bin 和 config.json 都在才算权重齐全。"""
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
    """模型目录里已经放齐权重的目录名（只认 catalog 里的名字）。绝不抛异常。"""
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
            "faster-whisper 未安装。请先运行 install --engine faster-whisper"
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
    WhisperModel = _load()
    dev, compute_type = resolve_device(device)

    if offline and model not in local_models(models_dir, catalog or []):
        raise ModelNotInstalled(
            f"这台机器上没有 faster-whisper 的 {model} 模型权重，离线模式不会联网下载。"
            "请联系部署者把权重放进模型目录。"
        )

    whisper_model = WhisperModel(
        model,
        device=dev,
        compute_type=compute_type,
        download_root=models_dir,
        local_files_only=bool(offline),
    )

    kwargs: Dict[str, Any] = {"beam_size": 5, "vad_filter": False}
    # language 为空表示自动检测：不传这个参数，让引擎自己判断。
    if language:
        kwargs["language"] = language

    segments_iter, info = whisper_model.transcribe(wav_path, **kwargs)

    total = getattr(info, "duration", None)
    total = float(total) if total else None

    collected: List[Dict[str, Any]] = []
    # segments 是惰性生成器：真正的解码发生在遍历时，所以进度事件必须在这个
    # 循环里发，不能等它跑完。
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
