"""命令行入口：python -m promptcut_shots <子命令>

子命令：status / install / detect
输出约定和 promptcut_stt 一致：stdout 一行一个 JSON，stderr 是给人看的提示。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, Optional

# 复用听写那套 JSONL：Windows 控制台的 UTF-8 和换行处理有坑，只想维护一份。
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
    """报告能不能跑。两个条件缺一不可：onnxruntime 装了，模型文件在。"""
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
    """把 onnxruntime 装进 pylibs。模型文件由拓展包提供，这里只检查。"""
    paths = env_paths()
    pylibs = paths["pylibs"]
    if not pylibs:
        emit_error("没有设置 PROMPTCUT_PYLIBS，不知道该把依赖装到哪。")
        return 2
    os.makedirs(pylibs, exist_ok=True)

    # 清单放在包内部：这个包会被镜像到 pylibs 下运行，放在包外面就跟丢了
    here = os.path.dirname(os.path.abspath(__file__))
    req = os.path.join(here, REQUIREMENTS)
    if not os.path.isfile(req):
        # 兼容早期把清单放在 python/ 根下的布局
        req = os.path.join(os.path.dirname(here), REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"找不到依赖清单 {REQUIREMENTS}")
        return 2

    # 必须用 sys.executable：写死 "python" 会装进系统解释器
    cmd = [sys.executable, "-m", "pip", "install", "--target", pylibs, "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
    except OSError as exc:
        emit_error(f"无法启动 pip：{exc}")
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(f"pip 安装失败（退出码 {code}）。常见原因：网络不可达，或该平台没有对应的 onnxruntime 轮子。")
        return 1

    info = probe(env_paths())
    needs_model = not info["model"]["exists"]
    if needs_model:
        warn(f"依赖装好了，但还缺模型文件 {info['model']['path']}；它由拓展库包提供。")
    emit({"event": "installed", "needsModel": needs_model, **info})
    # 退出码只反映**这一步**成没成:pip 装完了就是 0。
    #
    # 以前是 `0 if ready else 1`,而 ready 还要求模型文件在 —— 可模型是我们自己
    # 从官方 TF 权重转出来的 ONNX,pip 根本抓不到,只随拓展库包分发。于是在线安装
    # 这条路**注定**以退出码 1 收尾:依赖明明装好了,界面上却是一句「进程退出码 1」,
    # 用户既不知道装到哪一步了,也不知道下一步该干什么。
    # 到底能不能用由 status 回答,不该由 install 的退出码兼职。
    return 0


def apply_globals(args: argparse.Namespace) -> None:
    """云端 Agent 服务起这个包时,环境变量里的 PROMPTCUT_* 一个都不传(工作区的白名单),
    所以模型目录、依赖目录改走命令行。桌面版不用这几个选项,行为不变。"""
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
        emit_error("镜头识别拓展未就绪", detail=info)
        return 3
    if not paths["ffmpeg"]:
        emit_error("找不到 ffmpeg，无法解码视频。")
        return 2
    if getattr(args, "local_only", False) and is_media_url(args.video):
        emit_error("本次只允许读本地文件，不能连网络地址。")
        return 2
    if not (is_media_url(args.video) or os.path.isfile(args.video)):
        emit_error(f"找不到视频文件：{args.video}")
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
        # 每 5% 报一次，别把 stdout 刷爆
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
    parser.add_argument("--models-dir", default=None, help="权重目录(盖掉 PROMPTCUT_MODELS)")
    parser.add_argument("--pylibs", default=None, help="依赖目录(盖掉 PROMPTCUT_PYLIBS)")
    parser.add_argument("--local-only", action="store_true",
                        help="ffmpeg 只读本地文件,不连任何网络地址")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="报告拓展是否就绪").set_defaults(func=cmd_status)
    sub.add_parser("install", help="安装 onnxruntime 依赖").set_defaults(func=cmd_install)

    d = sub.add_parser("detect", help="检测镜头切换")
    d.add_argument("video")
    d.add_argument("--fps", type=float, required=True,
                   help="视频帧率，由调用方用 ffprobe 拿到后传进来")
    d.add_argument("--threshold", type=float, default=0.5)
    d.set_defaults(func=cmd_detect)

    args = parser.parse_args(argv)
    apply_globals(args)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # 兜底：绝不让 traceback 直接糊到 stdout 把 JSONL 弄脏
        emit_error(f"未预期的错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
