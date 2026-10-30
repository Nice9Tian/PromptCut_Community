"""TransNetV2 推理。

模型来自官方 TensorFlow 权重，经官方 convert_weights.py 转 PyTorch（官方自测
10/10 逐帧 100% 一致）后导出为 ONNX，见 tools/build-transnetv2-onnx.md。

输入是 uint8 的 [B, 100, 27, 48, 3]，归一化在模型内部做，所以预处理只要把帧
缩放到 48x27 就行，不要自己除 255。
"""

from __future__ import annotations

import subprocess
from typing import Any, Dict, List, Optional

MODEL_FILENAME = "transnetv2.onnx"

# 官方推理的滑窗：前后各补 25 帧，窗口 100、步长 50，每窗只取中间 [25:75]。
# 这样每一帧都在某个窗口的中段被预测过一次，上下文是完整的。
WINDOW = 100
STRIDE = 50
MARGIN = 25

FRAME_W, FRAME_H = 48, 27

# 云端 Agent 服务把素材取到对话的工作目录后再递路径来:素材是成员传的,伪装成媒体文件的
# 播放列表(HLS、concat)不能让 ffmpeg 去连网络地址。置 True 时输入前加 `-protocol_whitelist file`。
# 桌面版不设(它递的是素材服务上的 http 地址)。
LOCAL_ONLY = False


def decode_frames(ffmpeg: str, video: str):
    """把整段视频解成 48x27 的 RGB 帧。

    模型输入只有 48x27，所以哪怕 4K 素材，这里的内存也只是
    帧数 × 48 × 27 × 3 字节（1 小时 30fps 约 420 MB），可以一次读完。
    真正的大素材由调用方决定要不要分段。
    """
    import numpy as np

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         *(["-protocol_whitelist", "file"] if LOCAL_ONLY else []), "-i", video,
         "-vf", f"scale={FRAME_W}:{FRAME_H}", "-pix_fmt", "rgb24",
         "-f", "rawvideo", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:500] or "ffmpeg 解码失败")
    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    per_frame = FRAME_H * FRAME_W * 3
    if per_frame == 0 or buf.size < per_frame:
        raise RuntimeError("没有解出任何视频帧，这个文件可能没有视频轨")
    return buf[: buf.size // per_frame * per_frame].reshape(-1, FRAME_H, FRAME_W, 3)


def predict(frames, session, on_progress=None):
    """逐帧概率，返回 (center, extent) 两条曲线。

    模型有两个输出，用途不同，两个都要：
      - cut_prob（one_hot）：转场的**中心**在哪。硬切和溶解都只亮很窄的一小段。
      - many_hot：属于转场的**每一帧**。硬切下和 one_hot 一样窄，溶解下会铺满
        整个渐变区间。

    实测 1 秒交叉溶解：one_hot 只给 3 帧（2.44~2.56s），many_hot 给 21 帧
    （2.12~2.96s），后者才是真实跨度。要在时间轴上把溶解画成两张叠画，靠的
    就是 many_hot。
    """
    import numpy as np

    padded = np.concatenate(
        [frames[:1]] * MARGIN + [frames] + [frames[-1:]] * MARGIN
    )
    total_windows = max(1, (len(padded) - WINDOW) // STRIDE + 1)
    centers: List[Any] = []
    extents: List[Any] = []
    ptr = 0
    done = 0
    while ptr + WINDOW <= len(padded):
        window = padded[ptr : ptr + WINDOW][None]
        one, many = session.run(["cut_prob", "many_hot"], {"frames": window})
        centers.append(one[0, MARGIN : WINDOW - MARGIN, 0])
        extents.append(many[0, MARGIN : WINDOW - MARGIN, 0])
        ptr += STRIDE
        done += 1
        if on_progress:
            on_progress(done, total_windows)
    if not centers:
        zero = np.zeros(len(frames), dtype="float32")
        return zero, zero
    return (np.concatenate(centers)[: len(frames)],
            np.concatenate(extents)[: len(frames)])


def transitions_from_probs(centers, extents, fps: float,
                           threshold: float = 0.5) -> List[Dict[str, Any]]:
    """把逐帧概率变成转场。

    先用 centers 定位「这里有一个转场」，再用 extents 把它的真实跨度撑开——
    硬切撑不开（本来就一两帧），溶解会撑到整个渐变区间。
    """
    result: List[Dict[str, Any]] = []
    run: List[int] = []
    n = len(centers)

    def flush() -> None:
        if not run:
            return
        peak = max(run, key=lambda i: centers[i])
        # 从峰值往两边走，直到 many_hot 掉下阈值，得到渐变的真实范围
        start = end = peak
        while start - 1 >= 0 and extents[start - 1] >= threshold:
            start -= 1
        while end + 1 < n and extents[end + 1] >= threshold:
            end += 1
        start, end = min(start, run[0]), max(end, run[-1])
        # 跨度超过 3 帧才算渐变；硬切在两条曲线上都只有一两帧
        kind = "dissolve" if (end - start + 1) > 3 else "cut"
        result.append({
            "kind": kind,
            "startFrame": int(start),
            "endFrame": int(end),
            "frame": int(peak),
            "start": round(start / fps, 3),
            "end": round((end + 1) / fps, 3),
            "time": round(peak / fps, 3),
            "confidence": round(float(centers[peak]), 3),
        })

    for i, p in enumerate(centers):
        if p >= threshold:
            run.append(i)
        elif run:
            flush()
            run = []
    if run:
        flush()
    return result


def shots_from_transitions(transitions: List[Dict[str, Any]], duration: float) -> List[Dict[str, Any]]:
    """转场之间夹着的就是镜头。给 AI 用的主要是这个列表。"""
    shots: List[Dict[str, Any]] = []
    cursor = 0.0
    for t in transitions:
        if t["start"] > cursor:
            shots.append({"start": round(cursor, 3), "end": round(t["start"], 3),
                          "inTransition": None if not shots else transitions[len(shots) - 1]["kind"],
                          "outTransition": t["kind"]})
        cursor = t["end"]
    if duration > cursor:
        shots.append({"start": round(cursor, 3), "end": round(duration, 3),
                      "inTransition": transitions[-1]["kind"] if transitions else None,
                      "outTransition": None})
    return shots


def load_session(model_path: str):
    import onnxruntime as ort

    # 明确只用 CPU：这台机器有没有 CUDA 不该影响结果，而且 GPU provider
    # 缺 DLL 时 onnxruntime 会打一堆吓人的告警。
    return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
