"""命令行入口：python -m promptcut_subject <子命令>

子命令：status / install / detect
输出约定和 promptcut_shots / promptcut_stt 一致：stdout 一行一个 JSON，
stderr 是给人看的提示。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

# 复用听写那套 JSONL：Windows 控制台的 UTF-8 和换行处理有坑，只想维护一份。
from promptcut_stt.jsonl import emit, emit_error, emit_log, warn

from . import __version__, is_media_url

REQUIREMENTS = {
    "light": "requirements-subject-light.txt",
    "full": "requirements-subject-full.txt",
}

YUNET_FILE = "yunet.onnx"
RTDETR_FILE = "rtdetr_r18vd.onnx"
DINO_DIR = "grounding-dino-tiny"

DEFAULT_MAX_SIDE = 640


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


def _file_entry(path: str) -> Dict[str, Any]:
    entry: Dict[str, Any] = {"path": path, "exists": os.path.isfile(path)}
    if entry["exists"]:
        entry["bytes"] = os.path.getsize(path)
    return entry


def _dir_entry(path: str) -> Dict[str, Any]:
    """DINO 是一整个 HF snapshot 目录，光看目录在不在不够，权重文件也得在。

    判据直接借 dino.model_ready()（config.json + model.safetensors +
    preprocessor_config.json + tokenizer_config.json 都在，且 tokenizer.json /
    vocab.txt 至少有一个，判据的实测依据见 dino.REQUIRED_FILES 上面那段）：
    拷贝中断留下半个目录时，光看「目录在 + 有个 .safetensors」会报 ready 然后
    在加载时炸，判据得和真正加载模型的那段代码是同一份。dino.py 顶层只 import numpy，status 拉它
    进来不会把 torch 带上；万一它自己都 import 不了（包被裁过），退回原来
    那套宽松判据，保证 status 在任何环境下都能出一行合契约的 JSON。
    """
    try:
        from .dino import model_ready

        return {"path": path, "exists": bool(model_ready(path))}
    except Exception:
        ok = os.path.isdir(path) and os.path.isfile(os.path.join(path, "config.json"))
        if ok:
            ok = any(name.endswith(".safetensors") for name in os.listdir(path))
        return {"path": path, "exists": bool(ok)}


def probe(paths: Dict[str, Optional[str]]) -> Dict[str, Any]:
    """报告两档各自能不能跑。没装任何东西时也必须给出完整结构，不能抛。"""
    add_pylibs(paths["pylibs"])
    md = models_dir(paths)

    light_runtime: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        import onnxruntime  # noqa: F401

        light_runtime = {"installed": True, "version": onnxruntime.__version__, "error": None}
    except Exception as exc:
        light_runtime["error"] = str(exc)

    light_models = {
        "yunet": _file_entry(os.path.join(md, YUNET_FILE)),
        "rtdetr": _file_entry(os.path.join(md, RTDETR_FILE)),
    }
    light_ready = bool(light_runtime["installed"]
                       and light_models["yunet"]["exists"]
                       and light_models["rtdetr"]["exists"])

    full_runtime: Dict[str, Any] = {"installed": False, "version": None,
                                    "torch": None, "transformers": None, "error": None}
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401

        full_runtime = {"installed": True, "version": torch.__version__,
                        "torch": torch.__version__,
                        "transformers": transformers.__version__, "error": None}
    except Exception as exc:
        full_runtime["error"] = str(exc)

    full_models = {"dino": _dir_entry(os.path.join(md, DINO_DIR))}
    full_ready = bool(full_runtime["installed"] and full_models["dino"]["exists"])

    # engine 是「现在实际能跑到哪一档」：full 能跑就报 full（它是 light 的超集），
    # 否则退 light，两档都不行就是 null（界面据此提示去装拓展包）。
    engine = "full" if full_ready else ("light" if light_ready else None)

    return {
        "engine": engine,
        "light": {"ready": light_ready, "runtime": light_runtime, "models": light_models},
        "full": {"ready": full_ready, "runtime": full_runtime, "models": full_models},
        "modelsDir": md,
        "ffmpeg": paths["ffmpeg"],
    }


def cmd_status(_args: argparse.Namespace) -> int:
    paths = env_paths()
    info = probe(paths)
    emit({"event": "status", "version": __version__, **info})
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    """把推理依赖装进 pylibs。模型文件由拓展包提供，这里只检查。"""
    paths = env_paths()
    pylibs = paths["pylibs"]
    if not pylibs:
        emit_error("没有设置 PROMPTCUT_PYLIBS，不知道该把依赖装到哪。")
        return 2
    os.makedirs(pylibs, exist_ok=True)

    tier = args.tier
    # 清单放在包内部：这个包会被镜像到 pylibs 下运行，放在包外面就跟丢了。
    # --requirements 由云端部署者给一份锁定版本的清单,盖掉包内那份(模型不能改它)。
    here = os.path.dirname(os.path.abspath(__file__))
    req = args.requirements or os.path.join(here, REQUIREMENTS[tier])
    if not os.path.isfile(req):
        emit_error(f"找不到依赖清单 {os.path.basename(req)}")
        return 2

    # 必须用 sys.executable：写死 "python" 会装进系统解释器
    # 本进程是隔离模式(-I)起的(云端 Agent 服务:工作目录是对话工作区),pip 也用隔离模式起,否则 `-m pip` 会把当前目录排进模块搜索路径最前。
    isolated = ["-I"] if sys.flags.isolated else []
    cmd = [sys.executable, *isolated, "-m", "pip", "install", "--target", pylibs, "-r", req]
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
        emit_error(f"pip 安装失败（退出码 {code}）。常见原因：网络不可达，或该平台没有对应的轮子。")
        return 1

    info = probe(env_paths())
    missing = [k for k, v in info[tier]["models"].items() if not v["exists"]]
    if missing:
        warn(f"依赖装好了，但还缺模型：{'、'.join(missing)}；它们由拓展库包提供。")
    # 退出码只反映**这一步**成没成：pip 装完了就是 0。模型是随拓展包发的，pip
    # 抓不到，用 ready 当退出码的话在线安装这条路注定以 1 收尾（见 shots 那边
    # 同样的注释）。能不能用由 status 回答。
    emit({"event": "installed", "tier": tier, "needsModel": bool(missing), **info})
    return 0


def parse_times(text: str) -> List[float]:
    """只要能认的那些秒数。看不懂的片段交给 parse_times_strict 去报错。"""
    return parse_times_strict(text)[0]


def parse_times_strict(text: str) -> Tuple[List[float], List[str]]:
    """返回 (认出来的秒数, 看不懂的片段)。

    以前是直接 float(chunk)，写错一个字符就一路冒到 main 的兜底 except，报成
    「未预期的错误：could not convert string to float: 'abc'」——看着像内部故障，
    而不是「你的参数写错了」。HTTP 那一侧已经用 Number.isFinite 滤过，所以这条
    只影响直接敲 CLI 的人（打包脚本、排障），但恰恰是那些人最需要一句人话。
    """
    out: List[float] = []
    bad: List[str] = []
    for chunk in (text or "").replace(" ", "").split(","):
        if not chunk:
            continue
        try:
            value = float(chunk)
        except ValueError:
            bad.append(chunk)
            continue
        # nan / inf 也是「不是秒数」：float("nan") 不抛异常，但拿去 seek 只会更难查
        if value != value or value in (float("inf"), float("-inf")):
            bad.append(chunk)
            continue
        out.append(max(0.0, value))
    return out, bad


def pick_engine(info: Dict[str, Any], requested: Optional[str],
                prompt: Optional[str]) -> Optional[str]:
    """定这次用哪一档。

    显式指定就按指定的来（不就绪则由调用处报错）。没指定时：给了 prompt 且 full
    就绪就走 full（只有它认提示词），否则优先 light —— light 在 CPU 上快一个数
    量级，而「人在哪」这件事两档都能答。
    """
    if requested:
        return requested
    if prompt and info["full"]["ready"]:
        return "full"
    if info["light"]["ready"]:
        return "light"
    if info["full"]["ready"]:
        return "full"
    return None


class _FirstInferenceFailed(Exception):
    """第一帧就推理失败。只在 cmd_detect 内部传递，不会冒到 main 的兜底 except。

    单独一个类型是为了把它和「跑到第 37 帧忽然坏了」区分开：后者留给外面的兜底，
    前者说明这一档整个就跑不起来，值得换一档从头再来。
    """

    def __init__(self, cause: BaseException):
        super().__init__(str(cause))
        self.cause = cause


def cmd_detect(args: argparse.Namespace) -> int:
    paths = env_paths()
    add_pylibs(paths["pylibs"])
    info = probe(paths)

    if not paths["ffmpeg"]:
        emit_error("找不到 ffmpeg，无法解码视频。")
        return 2
    if not (is_media_url(args.video) or os.path.isfile(args.video)):
        emit_error(f"找不到视频文件：{args.video}")
        return 2

    times, bad_times = parse_times_strict(args.times)
    if bad_times:
        emit_error(f"--times 里这些不是秒数：{'、'.join(bad_times)}；写成 1.2,5.4,8.8")
        return 2
    if not times:
        emit_error("--times 里一个时刻都没有。")
        return 2

    engine = pick_engine(info, args.engine, args.prompt)
    if engine is None:
        emit_error("主体检测拓展未就绪", detail=info)
        return 3
    if not info[engine]["ready"]:
        emit_error(f"{engine} 档未就绪", detail=info)
        return 3

    from . import frames as F
    from .safezone import analyze

    try:
        width, height = F.probe_size(paths["ffmpeg"], args.video)
    except RuntimeError as exc:
        emit_error(str(exc))
        return 1

    fw, fh = F.target_size(width, height, args.max_side)
    factor = width / float(fw) if fw else 1.0  # 抽出来的帧 → 原始像素

    prompt = args.prompt or ""

    def make_runner(eng: str):
        """按档位造一个「一帧进、框出」的闭包。engine 会在退档时换掉，所以不能闭包 engine。"""
        models = info[eng]["models"]

        def run_one(frame) -> List[Dict[str, Any]]:
            if eng == "light":
                from . import rtdetr, yunet

                boxes = yunet.detect([frame], model_path=models["yunet"]["path"])[0]
                boxes += rtdetr.detect([frame], model_path=models["rtdetr"]["path"])[0]
                return boxes
            # full 档：开放词汇，label 直接来自提示词里的名词
            from .dino import detect as dino_detect

            return dino_detect([frame], model_path=models["dino"]["path"],
                               prompt=prompt or "person . face .")[0]

        return run_one

    def run_all(eng: str):
        """按 eng 档跑完所有时刻，返回 (samples, spent, failed_count)。

        **第一次真正的推理**失败时抛 _FirstInferenceFailed 而不是自己吞掉：那种失败
        （模型目录半残、torch 装坏、内存不够）对后面每一帧都会重演，一帧一帧地炸
        只是把同一句话打印 200 遍。抛出去让调用处决定要不要换一档从头再来。
        注意「第一次推理」不等于 times[0]：头几个时刻可能连帧都抽不出来。
        """
        run_one = make_runner(eng)
        samples: List[Dict[str, Any]] = []
        spent: List[float] = []
        failed = 0
        total = len(times)
        for i, t in enumerate(times, 1):
            try:
                frame = F.grab_frame(paths["ffmpeg"], args.video, t, fw, fh)
            except RuntimeError as exc:
                # 单个时刻抽不出来（超出时长、坏帧）不该让整批失败，但**必须留标记**：
                # 空框 + 四个 0 的 occupancy 和「这一帧真的没有人」在 JSON 里逐字段相同，
                # 不标出来读取侧就会把一串 0 平均进去，给出「这段没人、right 侧安全」的
                # 伪结论 —— 恰好是这个功能最该避免的那种错。safeSide/occupancy 仍然写着
                # 占位值（保持字段形状不变，老读取侧不会因为 null 崩），failed 才是判据。
                warn(str(exc))
                failed += 1
                samples.append({"t": round(float(t), 3), "boxes": [],
                                "failed": True, "reason": str(exc),
                                "safeSide": "right",
                                "occupancy": {"left": 0.0, "right": 0.0,
                                              "top": 0.0, "bottom": 0.0}})
                emit({"event": "progress", "done": i, "total": total})
                continue

            t0 = time.perf_counter()
            try:
                raw = run_one(frame)
            except Exception as exc:
                if not spent:
                    raise _FirstInferenceFailed(exc) from exc
                raise
            spent.append(time.perf_counter() - t0)
            boxes = F.scale_boxes(raw, factor, width, height)
            samples.append({"t": round(float(t), 3), "boxes": boxes,
                            **analyze(width, height, boxes)})
            emit({"event": "progress", "done": i, "total": total})
        return samples, spent, failed

    fell_back_from: Optional[str] = None
    fallback_reason: Optional[str] = None
    try:
        samples, spent, failed = run_all(engine)
    except _FirstInferenceFailed as first:
        exc = first.cause
        detail = f"{type(exc).__name__}: {str(exc)[:300]}"
        dino_path = info["full"]["models"]["dino"]["path"]
        # full 档炸了但 light 就绪：退回去重跑**全部**时刻（不是接着跑，两档的框
        # 对不齐，混在一起的结果没法解释）。「人在哪」这件事 light 也答得了，
        # 只是答不了提示词——总比整批失败强。
        if engine == "full" and info["light"]["ready"]:
            warn(f"full 档第一帧就推理失败（{detail}），退回 light 重跑全部 {len(times)} 个时刻。"
                 f"DINO 模型目录：{dino_path}")
            fell_back_from = "full"
            fallback_reason = detail
            if prompt:
                fallback_reason += "；light 档只认 person/face，这次的提示词没生效"
            engine = "light"
            try:
                samples, spent, failed = run_all(engine)
            except _FirstInferenceFailed as second:
                emit_error(
                    f"退回 light 之后第一帧仍然推理失败："
                    f"{type(second.cause).__name__}: {str(second.cause)[:300]}"
                    f"（full 档原来的错是 {detail}，DINO 模型目录 {dino_path}）",
                    detail=info)
                return 3
        elif engine == "full":
            emit_error(
                f"full 档第一帧推理失败：{detail}；light 档也不可用（"
                f"{info['light']['runtime']['error'] or '模型文件不全'}），没法退回。"
                f"DINO 模型目录：{dino_path}",
                detail=info)
            return 3
        else:
            emit_error(
                f"light 档第一帧推理失败：{detail}。"
                f"模型目录：{info['modelsDir']}（{YUNET_FILE} / {RTDETR_FILE}）",
                detail=info)
            return 3

    result: Dict[str, Any] = {
        "event": "result",
        "engine": engine,
        "width": width,
        "height": height,
        "prompt": prompt,
        "msPerFrame": round(sum(spent) * 1000 / len(spent), 1) if spent else None,
        # 抽帧失败的样本数。读取侧据此知道这段结论是几个采样撑起来的
        "failedCount": failed,
        "samples": samples,
    }
    if fell_back_from:
        result["fellBackFrom"] = fell_back_from
        result["fallbackReason"] = fallback_reason
    emit(result)
    return 0


def apply_globals(args: argparse.Namespace) -> None:
    """云端 Agent 服务起这个包时,环境变量里的 PROMPTCUT_* 一个都不传(工作区的白名单),
    所以模型目录、依赖目录改走命令行。桌面版不用这几个选项,行为不变。"""
    if getattr(args, "models_dir", None):
        os.environ["PROMPTCUT_MODELS"] = args.models_dir
    if getattr(args, "pylibs", None):
        os.environ["PROMPTCUT_PYLIBS"] = args.pylibs
    if getattr(args, "local_only", False):
        from . import frames as F

        F.LOCAL_ONLY = True


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_subject")
    parser.add_argument("--models-dir", default=None, help="权重目录(盖掉 PROMPTCUT_MODELS)")
    parser.add_argument("--pylibs", default=None, help="依赖目录(盖掉 PROMPTCUT_PYLIBS)")
    parser.add_argument("--local-only", action="store_true",
                        help="ffmpeg / ffprobe 只读本地文件,不连任何网络地址")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="报告两档拓展是否就绪").set_defaults(func=cmd_status)

    ins = sub.add_parser("install", help="安装推理依赖")
    ins.add_argument("--tier", choices=["light", "full"], default="light")
    ins.add_argument("--requirements", default=None, help="锁定版本的依赖清单(盖掉包内的)")
    ins.set_defaults(func=cmd_install)

    d = sub.add_parser("detect", help="在若干时刻上检测主体")
    d.add_argument("video")
    d.add_argument("--times", required=True, help="逗号分隔的秒数，例如 1.2,5.4,8.8")
    d.add_argument("--prompt", default=None, help="开放词汇提示词，只有 full 档认")
    d.add_argument("--engine", choices=["light", "full"], default=None)
    d.add_argument("--max-side", type=int, default=DEFAULT_MAX_SIDE,
                   help="抽帧时缩到的最长边（默认 640）")
    d.set_defaults(func=cmd_detect)

    args = parser.parse_args(argv)
    try:
        apply_globals(args)
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # 兜底：绝不让 traceback 直接糊到 stdout 把 JSONL 弄脏
        emit_error(f"未预期的错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
