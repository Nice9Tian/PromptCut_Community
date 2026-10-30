"""转写引擎的公共部分。

每个引擎模块对外暴露三样东西，__main__.py 按名字分发：
  ENGINE_NAME  引擎名（与命令行 --engine 的取值一致）
  probe()      探测是否已安装，绝不抛异常
  transcribe(...) 真正干活，未安装时抛 EngineNotInstalled
"""

from __future__ import annotations

from typing import Optional, Tuple


class EngineNotInstalled(Exception):
    """引擎的第三方依赖没装。消息里要写清楚下一步该干什么。"""


class ModelNotInstalled(Exception):
    """离线模式（--offline）下，要用的模型权重不在模型目录里。

    离线模式不许联网下载权重：云节点的权重由部署者预先放好，缺了如实报告。
    """


def cuda_available() -> bool:
    """有没有可用的 CUDA。没装 torch、torch 装坏了都算没有。

    faster-whisper 走 CTranslate2，本来就不需要 torch，所以这里探测失败必须静默
    降级到 CPU，不能让一个可选依赖把转写整个挡住。
    """
    try:
        import torch  # type: ignore

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def resolve_device(device: Optional[str]) -> Tuple[str, str]:
    """把 --device 解析成 (device, compute_type)。

    auto：有 CUDA 就 cuda + float16，否则 cpu + int8（int8 量化让 small 模型在
    普通 CPU 上也能跑到接近实时）。
    """
    choice = (device or "auto").lower()
    if choice == "cuda":
        return "cuda", "float16"
    if choice == "cpu":
        return "cpu", "int8"
    if cuda_available():
        return "cuda", "float16"
    return "cpu", "int8"
