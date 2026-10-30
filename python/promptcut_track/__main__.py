"""命令行入口：python -m promptcut_track <子命令>

子命令：status / install / track
输出约定和 promptcut_stt、promptcut_shots 一致：stdout 一行一个 JSON，
stderr 是给人看的提示。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional

# 复用听写那套 JSONL：Windows 控制台的 UTF-8 和换行处理有坑，只想维护一份。
from promptcut_stt.jsonl import emit, emit_error, emit_log, warn

from . import __version__, is_media_url
from .tracker import MODEL_FILENAME

REQUIREMENTS = "requirements-track.txt"


# 命令行总开关(放在子命令前面)覆盖环境变量。云端 Agent 服务经工作区起这个进程时,
# 工作区会把所有 PROMPTCUT_* 环境变量剥掉(不让服务自己的配置泄进子进程),
# 所以解释器、依赖目录、权重目录、ffmpeg 由服务按部署配置用这几个参数递进来。
# 它们只来自部署者的配置,从不来自模型给的参数。
_OVERRIDES: Dict[str, Optional[str]] = {}


def env_paths() -> Dict[str, Optional[str]]:
    return {
        "pylibs": _OVERRIDES.get("pylibs") or os.environ.get("PROMPTCUT_PYLIBS") or None,
        "models": _OVERRIDES.get("models") or os.environ.get("PROMPTCUT_MODELS") or None,
        "data_dir": os.environ.get("PROMPTCUT_DATA_DIR") or None,
        "ffmpeg": _OVERRIDES.get("ffmpeg") or os.environ.get("PROMPTCUT_FFMPEG") or shutil.which("ffmpeg"),
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
    """报告能跑到哪一档。

    ready 只说神经网络那档（torch 装了 + 权重在）。**它不等于「能不能追」**——
    未就绪时还有 numpy 的模板匹配兜底，那一档只要 numpy 和 ffmpeg 在就能跑，
    而 numpy 在基础运行时里。两者要分开报，否则调用方会把「没装拓展」
    读成「这个功能用不了」。
    """
    add_pylibs(paths["pylibs"])
    runtime: Dict[str, Any] = {"installed": False, "version": None}
    try:
        import torch  # noqa: F401

        runtime = {"installed": True, "version": torch.__version__}
    except Exception as exc:
        runtime["error"] = str(exc)

    mp = model_path(paths)
    model = {"path": mp, "exists": os.path.isfile(mp)}
    if model["exists"]:
        model["bytes"] = os.path.getsize(mp)

    fallback: Dict[str, Any] = {"available": False}
    try:
        import numpy  # noqa: F401

        fallback = {"available": bool(paths["ffmpeg"]), "numpy": numpy.__version__}
        if not paths["ffmpeg"]:
            fallback["error"] = "找不到 ffmpeg"
    except Exception as exc:
        fallback["error"] = str(exc)

    ready = bool(runtime["installed"] and model["exists"])
    return {
        "ready": ready,
        "engine": "bootstapir" if ready else ("template" if fallback["available"] else None),
        "runtime": runtime,
        "model": model,
        "fallback": fallback,
        "ffmpeg": paths["ffmpeg"],
    }


def cmd_status(_args: argparse.Namespace) -> int:
    info = probe(env_paths())
    emit({"event": "status", "version": __version__, **info})
    return 0


def cmd_install(_args: argparse.Namespace) -> int:
    paths = env_paths()
    target = paths["pylibs"]
    if not target:
        emit_error("没有设置 PROMPTCUT_PYLIBS，不知道该把依赖装到哪。", code="pylibs-missing")
        return 2

    # --requirements 只给部署者用(指向锁定了版本与哈希的清单);缺省是包里随发的那份
    req = _OVERRIDES.get("requirements") or os.path.join(os.path.dirname(os.path.abspath(__file__)), REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"找不到依赖清单 {REQUIREMENTS}", code="requirements-missing")
        return 2

    os.makedirs(target, exist_ok=True)
    # 必须用 sys.executable —— 内置解释器自己的 pip。写死 "python" 会打到系统里
    # 本进程是隔离模式(-I)起的(云端 Agent 服务:工作目录是对话工作区),pip 也用隔离模式起,否则 `-m pip` 会把当前目录排进模块搜索路径最前。
    isolated = ["-I"] if sys.flags.isolated else []
    cmd = [sys.executable, *isolated, "-m", "pip", "install", "--target", target, "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
    except OSError as exc:
        emit_error(f"无法启动 pip：{exc}")
        return 2

    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(
            f"pip 安装失败（退出码 {code}）。torch 有 190 MB 以上，"
            "常见原因是网络中断或磁盘空间不足。"
        )
        return 1

    info = probe(paths)
    needs_model = not info["model"]["exists"]
    if needs_model:
        warn(f"依赖装好了，但还缺模型文件 {info['model']['path']}；它由拓展库包提供。")
    emit({"event": "installed", "needsModel": needs_model, **info})
    # 同 promptcut_shots:退出码只说 pip 成没成。BootsTAPIR 的权重有 208 MB,
    # 不在 requirements 里,只随拓展库包发。用 `0 if ready else 1` 的话,用户会
    # 下完 190 MB 的 torch 再收到一句「进程退出码 1」,而依赖其实装好了。
    return 0


def _parse_points(raw: str) -> List[List[float]]:
    """--points 收 JSON：[[帧号, x, y], ...]，坐标是原始视频像素。"""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"--points 不是合法 JSON：{exc}") from exc
    if not isinstance(data, list) or not data:
        raise ValueError("--points 至少要有一个点")
    out: List[List[float]] = []
    for item in data:
        if not isinstance(item, (list, tuple)) or len(item) != 3:
            raise ValueError("每个点要写成 [帧号, x, y]")
        out.append([float(item[0]), float(item[1]), float(item[2])])
    return out


def _track_template(paths: Dict[str, Optional[str]], video: str,
                    queries_px: List[List[float]]) -> int:
    """兜底档。输出格式和神经网络那档**逐字段一致**，只有 engine 不同。

    格式一致是刻意的：调用方（Node 服务端、MCP 工具、将来的界面）不该为两档
    各写一套解析。哪一档跑的看 engine 字段，别的都一样。
    """
    from .template import decode_gray, track_template

    try:
        frames, src, dst = decode_gray(paths["ffmpeg"], video)
    except Exception as exc:
        emit_error(str(exc))
        return 1
    emit({"event": "progress", "phase": "decoded",
          "frames": int(len(frames)), "width": src[0], "height": src[1]})

    # 用户给的是原始像素，解码时缩过，要换到解码分辨率上再匹配
    sx, sy = dst[0] / src[0], dst[1] / src[1]
    queries = [(p[0], p[1] * sx, p[2] * sy) for p in queries_px]

    def on_progress(done: int, total: int) -> None:
        emit({"event": "progress", "phase": "track",
              "percent": round(done * 100 / max(total, 1), 1),
              "points": done, "total": total})

    try:
        result = track_template(frames, queries, on_progress=on_progress)
    except Exception as exc:
        emit_error(f"追踪失败：{exc}")
        return 1

    emit({
        "event": "result",
        "engine": "template",
        "width": src[0],
        "height": src[1],
        "frames": int(len(frames)),
        "points": [
            {
                "query": queries_px[i],
                # 换回原始像素，前端不用关心这一档解码到了多大
                "xy": [[round(float(x) / sx, 2), round(float(y) / sy, 2)]
                       for x, y in result["tracks"][i]],
                "visible": [bool(v) for v in result["visible"][i]],
                **({"note": result["notes"][i]} if result["notes"][i] else {}),
            }
            for i in range(len(queries_px))
        ],
    })
    return 0


def cmd_track(args: argparse.Namespace) -> int:
    paths = env_paths()
    info = probe(paths)
    if not paths["ffmpeg"]:
        emit_error("找不到 ffmpeg，无法解码视频。", code="ffmpeg-missing")
        return 2
    if not (is_media_url(args.video) or os.path.isfile(args.video)):
        emit_error(f"找不到视频文件：{args.video}", code="video-missing")
        return 2

    try:
        queries_px = _parse_points(args.points)
    except ValueError as exc:
        emit_error(str(exc), code="bad-points")
        return 2

    engine = args.engine or info["engine"]
    if engine is None:
        emit_error("既没装运动追踪拓展，兜底档也用不了", code="engine-unavailable", detail=info)
        return 2
    if engine == "bootstapir" and not info["ready"]:
        emit_error("运动追踪拓展未就绪", code="engine-unavailable", detail=info)
        return 2

    # 整段视频要解进内存:先估一下帧数,超过上限**直接拒**,不截断。
    # 截断会让轨迹只盖住视频的前半段,而 attach_clip_motion 按「轨迹覆盖整段素材」对时间,
    # 悄悄截断等于悄悄对错时间。
    if args.max_frames:
        from .tracker import estimate_frames

        est = estimate_frames(paths["ffmpeg"], args.video)
        if est is not None and est > args.max_frames:
            emit_error(
                f"视频约 {est} 帧,超过这台机器一次能追的 {args.max_frames} 帧;请先把素材剪短再追。",
                code="too-long", frames=est, limit=args.max_frames,
            )
            return 2
    if engine == "template":
        return _track_template(paths, args.video, queries_px)

    from .tracker import decode_frames, load_model, scale_points, track

    try:
        frames, src = decode_frames(paths["ffmpeg"], args.video)
    except Exception as exc:
        emit_error(str(exc))
        return 1
    emit({"event": "progress", "phase": "decoded",
          "frames": int(len(frames)), "width": src[0], "height": src[1]})

    # 点的坐标换到模型空间；帧号不变
    xy = scale_points([[p[1], p[2]] for p in queries_px], src, to_model=True)
    queries = [(queries_px[i][0], float(xy[i][0]), float(xy[i][1]))
               for i in range(len(queries_px))]

    model = load_model(info["model"]["path"])

    def on_progress(done: int, total: int) -> None:
        emit({"event": "progress", "phase": "track",
              "percent": round(done * 100 / max(total, 1), 1),
              "frames": done, "total": total})

    try:
        result = track(model, frames, queries, on_progress=on_progress)
    except Exception as exc:
        emit_error(f"追踪失败：{exc}")
        return 1

    # 轨迹换回原始像素坐标再交出去，前端不用关心模型的 256 空间
    back = scale_points(result["tracks"], src, to_model=False)
    emit({
        "event": "result",
        "engine": "bootstapir",
        "width": src[0],
        "height": src[1],
        "frames": int(len(frames)),
        "points": [
            {
                "query": queries_px[i],
                "xy": [[round(float(x), 2), round(float(y), 2)] for x, y in back[i]],
                "visible": [bool(v) for v in result["visible"][i]],
            }
            for i in range(len(queries_px))
        ],
    })
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_track")
    parser.add_argument("--pylibs", default=None, help="第三方库目录(覆盖 PROMPTCUT_PYLIBS)")
    parser.add_argument("--models", default=None, help="权重目录(覆盖 PROMPTCUT_MODELS)")
    parser.add_argument("--ffmpeg", default=None, help="ffmpeg 可执行文件(覆盖 PROMPTCUT_FFMPEG)")
    parser.add_argument("--requirements", default=None, help="install 用的依赖清单(缺省是包里随发的)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="报告拓展是否就绪").set_defaults(func=cmd_status)
    sub.add_parser("install", help="安装 torch 等依赖").set_defaults(func=cmd_install)

    t = sub.add_parser("track", help="追踪视频里的点")
    t.add_argument("--video", required=True)
    t.add_argument("--points", required=True,
                   help='JSON：[[帧号, x, y], ...]，坐标为原始视频像素')
    t.add_argument("--engine", choices=["bootstapir", "template"], default=None,
                   help="强制用哪一档。默认按 status 报的 engine 自动选")
    t.add_argument("--max-frames", type=int, default=0,
                   help="视频超过这么多帧就拒绝(0 = 不限)")
    t.set_defaults(func=cmd_track)

    args = parser.parse_args(argv)
    _OVERRIDES.clear()
    for key in ("pylibs", "models", "ffmpeg", "requirements"):
        value = getattr(args, key, None)
        if value:
            _OVERRIDES[key] = value
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001
        emit_error(f"未预期的错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
