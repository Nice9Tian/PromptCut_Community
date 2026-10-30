"""命令行入口：python -m promptcut_stt <子命令>

子命令：status / models / install / transcribe
所有正常输出都是一行一个 JSON（见 jsonl.py），给 node 侧逐行解析。
人话提示走 stderr。
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

# 各模型的大致体积，只用于 models 子命令的展示
MODEL_CATALOG: Dict[str, List[Dict[str, str]]] = {
    "faster-whisper": [
        {"name": "tiny", "size": "约 75 MB", "note": "最快，准确率最低，适合快速预览"},
        {"name": "base", "size": "约 145 MB", "note": "比 tiny 稳一些，中文仍然吃力"},
        {"name": "small", "size": "约 480 MB", "note": "默认；CPU int8 下接近实时，中文可用"},
        {"name": "medium", "size": "约 1.5 GB", "note": "明显更准；CPU 上约 3-5 倍实时耗时"},
        {"name": "large-v3", "size": "约 3.1 GB", "note": "最准；建议配 CUDA，显存约 5 GB"},
    ],
    "whisper": [
        {"name": "tiny", "size": "约 75 MB", "note": "最快，准确率最低"},
        {"name": "base", "size": "约 145 MB", "note": "轻量"},
        {"name": "small", "size": "约 480 MB", "note": "默认；CPU 上可跑但比 faster-whisper 慢"},
        {"name": "medium", "size": "约 1.5 GB", "note": "较准，CPU 上很慢"},
        {"name": "large", "size": "约 2.9 GB", "note": "最准；需要 CUDA 才实用"},
    ],
}


# --------------------------------------------------------------------------
# 环境
# --------------------------------------------------------------------------

def env_paths() -> Dict[str, Optional[str]]:
    """集中读取环境变量，避免散落各处。"""
    pylibs = os.environ.get("PROMPTCUT_PYLIBS") or None
    models = os.environ.get("PROMPTCUT_MODELS") or None
    data_dir = os.environ.get("PROMPTCUT_DATA_DIR") or None
    return {"pylibs": pylibs, "models": models, "data_dir": data_dir}


def resolve_models_dir(paths: Dict[str, Optional[str]], quiet: bool = False) -> str:
    """模型下载目录：PROMPTCUT_MODELS → PROMPTCUT_DATA_DIR/models → 临时目录。"""
    if paths["models"]:
        return paths["models"]
    if paths["data_dir"]:
        return os.path.join(paths["data_dir"], "models")
    fallback = os.path.join(tempfile.gettempdir(), "promptcut-models")
    if not quiet:
        warn(
            f"未设置 PROMPTCUT_MODELS 和 PROMPTCUT_DATA_DIR，模型将下载到临时目录 {fallback}，"
            "系统清理临时文件后需要重新下载。"
        )
    return fallback


def add_pylibs_to_path(pylibs: Optional[str]) -> None:
    """把 PROMPTCUT_PYLIBS 挂到 sys.path 最前面。

    -I 隔离模式下 PYTHONPATH 仍然生效，但调用方可能忘了设；这里自己插一遍，
    保证只要环境变量在就一定能 import 到装好的引擎。
    """
    if pylibs and os.path.isdir(pylibs) and pylibs not in sys.path:
        sys.path.insert(0, pylibs)


def _writable(path: str) -> bool:
    """目录能不能写。不存在就先试着建；建不出来算不可写，不抛异常。"""
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
    """扫模型目录，列出一级子目录和 .pt 文件。"""
    items: List[Dict[str, Any]] = []
    if not models_dir or not os.path.isdir(models_dir):
        return items
    try:
        entries = sorted(os.listdir(models_dir))
    except OSError:
        return items
    for name in entries:
        # huggingface-hub 会在缓存根下放 .locks / .no_exist 这类内部目录，不是模型
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
        # _writable 可能刚刚把目录建出来
        pylibs_info["exists"] = os.path.isdir(pylibs)

    engines: Dict[str, Any] = {}
    for name, module in ENGINES.items():
        try:
            engines[name] = module.probe()
        except Exception as exc:  # 引擎探测绝不能让 status 崩
            engines[name] = {"installed": False, "version": None, "error": str(exc)}

    # 每个引擎在模型目录里已经放齐权重的模型名。离线转写（--offline）只用这些。
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
                    "note": "CPU 上默认用 int8 量化，显存/内存占用约为体积的一半；"
                            "有 CUDA 时自动切 float16。",
                },
                "whisper": {
                    "default": DEFAULT_MODEL,
                    "models": MODEL_CATALOG["whisper"],
                    "note": "依赖 PyTorch；CPU 上只建议用到 small，再大需要 CUDA。",
                },
            },
        }
    )
    return 0


# --------------------------------------------------------------------------
# install
# --------------------------------------------------------------------------

def find_requirements(engine: str) -> Optional[str]:
    """定位 requirements-<engine>.txt。

    开发期包在 <repo>/python/promptcut_stt/，上一级就是 python/；
    装进 site-packages 后包在 <prefix>/Lib/site-packages/promptcut_stt/，
    上一级不是 python/，所以还要试 sys.prefix。两条都试，失败时把找过的路径报出来。
    """
    filename = f"requirements-{engine}.txt"
    package_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(os.path.dirname(package_dir), filename),   # 开发期：python/
        os.path.join(sys.prefix, filename),                     # 打包后：runtime/python/
        os.path.join(sys.prefix, "python", filename),
        os.path.join(package_dir, filename),                    # 兜底：跟包放一起
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    warn("未找到 requirements 文件，已尝试：\n  " + "\n  ".join(candidates))
    return None


def cmd_install(args: argparse.Namespace) -> int:
    paths = env_paths()
    target = paths["pylibs"]
    if not target:
        emit_error("环境变量 PROMPTCUT_PYLIBS 未设置，无法确定第三方库的安装目录。")
        return 1

    # --requirements：调用方（云节点的受控安装作业）指定一份锁定版本的依赖文件，
    # 不走 find_requirements 的默认查找。只认文件，不认别的东西。
    if getattr(args, "requirements", None):
        req = os.path.abspath(args.requirements)
        if not os.path.isfile(req):
            emit_error(f"指定的依赖文件不存在：{req}", kind="requirements-missing")
            return 1
    else:
        req = find_requirements(args.engine)
    if not req:
        emit_error(
            f"未找到 requirements-{args.engine}.txt（已在包目录上一级、"
            f"{sys.prefix} 等位置查找），无法安装。"
        )
        return 1

    if not _writable(target):
        emit_error(f"安装目录不可写：{target}")
        return 1

    # 必须用 sys.executable —— 内置解释器自己的 pip。写死 "python" 会打到系统里
    # 那个解释器上，库就装错地方了。
    # 本进程是隔离模式(-I)起的(云端 Agent 服务:工作目录是对话工作区),pip 也用隔离模式起,否则 `-m pip` 会把当前目录排进模块搜索路径最前。
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
        emit_error(f"无法启动 pip：{exc}")
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
            "内置解释器缺少 pip，无法安装引擎。请重新运行 prepare-python 脚本以装回 pip。",
            code=code,
        )
    else:
        emit_error(
            f"pip 安装失败（退出码 {code}）。常见原因：网络不可达、"
            f"索引地址不对、磁盘空间不足。完整日志见上面的 log 事件。",
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
            f"未知引擎 {engine_name}，可选：{', '.join(sorted(ENGINES))}。"
        )
        return 1

    offline = bool(getattr(args, "offline", False))
    if offline:
        # 离线模式：模型权重只用本地已有的，一个字节也不联网下载（huggingface 的开关要在 import 之前设）
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        known = [m["name"] for m in MODEL_CATALOG.get(engine_name, [])]
        if args.model not in known:
            emit_error(
                f"离线模式只认固定的模型名（{', '.join(known)}），收到：{args.model}",
                kind="model-missing",
            )
            return 1

    src = args.input
    if not os.path.isfile(src):
        emit_error(f"输入文件不存在：{src}", kind="input-missing")
        return 1

    # --language auto 或空串 → 自动检测
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
        emit_error(f"无法创建模型目录 {models_dir}：{exc}")
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
            emit_error(f"转写失败（{engine_name} / {args.model}）：{exc}", kind="transcribe-failed")
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
# 入口
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="promptcut_stt",
        description="PromptCut 语音转文字：输出逐行 JSON。",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="报告解释器、引擎安装情况、CUDA 和已下载模型")
    sub.add_parser("models", help="列出可选模型和大致体积")

    install = sub.add_parser("install", help="把引擎依赖装到 PROMPTCUT_PYLIBS")
    install.add_argument("--engine", choices=sorted(ENGINES), default=DEFAULT_ENGINE)
    install.add_argument("--index-url", dest="index_url", default=None)
    install.add_argument("--extra-index-url", dest="extra_index_url", default=None)
    install.add_argument("--upgrade", action="store_true")
    install.add_argument(
        "--requirements",
        dest="requirements",
        default=None,
        help="用这份依赖文件（锁定版本）代替默认的 requirements-<engine>.txt",
    )

    transcribe = sub.add_parser("transcribe", help="转写一个媒体文件")
    transcribe.add_argument("--input", required=True, help="任意音视频文件或 wav")
    transcribe.add_argument("--engine", choices=sorted(ENGINES), default=DEFAULT_ENGINE)
    transcribe.add_argument("--model", default=DEFAULT_MODEL)
    transcribe.add_argument(
        "--language",
        default=DEFAULT_LANGUAGE,
        help="语言代码，默认 zh；填 auto 表示自动检测",
    )
    transcribe.add_argument(
        "--device", choices=["auto", "cpu", "cuda"], default="auto"
    )
    transcribe.add_argument("--out", default=None, help="把 done 事件另存为 JSON 文件")
    transcribe.add_argument(
        "--offline",
        action="store_true",
        help="离线模式（云节点用）：只用本地已有权重、不联网下载；ffmpeg 只读本地文件",
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
        emit_error("已中断。")
        return 130
    except Exception as exc:  # 兜底：绝不把 traceback 当成输出扔给 node
        emit_error(f"{args.command} 执行失败：{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
