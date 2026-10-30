"""RT-DETR-R18 人体检测（ONNX / onnxruntime）。

权重从 HF 的 PekingU/rtdetr_r18vd（Apache-2.0）用 torch.onnx.export 导出，
取法见 tools/subject/README.md。输入 pixel_values [1,3,640,640] float32，
输出 logits [1,300,80] 与 pred_boxes [1,300,4]（cxcywh，归一化到 0~1）。

预处理照 HF 的 RTDetrImageProcessor：**直接 resize 到 640×640，不保比例**，
只做 /255，**不做 ImageNet 均值方差归一化** —— 该模型的 preprocessor_config.json
里 do_normalize 就是 false（do_rescale=true, rescale_factor=1/255）。这一点和
最初的口头约定不一样，以模型自带的配置为准；按 ImageNet 归一化喂进去，实测
同一帧上的人体分数会从 0.95 掉到 0.3 上下。

RT-DETR 是 DETR 系的，300 个 query 各自出一个框，没有 NMS —— 官方后处理就是
sigmoid 之后按分数挑，重复框由模型自己压掉。
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from .frames import resize_bilinear

MODEL_FILENAME = "rtdetr_r18vd.onnx"

INPUT_SIZE = 640
PERSON_CLASS = 0  # COCO 的 person；导出脚本会核对 config 的 id2label，对不上就不给导
DEFAULT_THRESHOLD = 0.5

_SESSIONS: Dict[str, Any] = {}


def load_session(model_path: str):
    sess = _SESSIONS.get(model_path)
    if sess is None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        sess = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
        _SESSIONS[model_path] = sess
    return sess


def _sigmoid(x: np.ndarray) -> np.ndarray:
    # 直接 1/(1+exp(-x)) 在 x 很负时会 overflow 出 warning，分段写掉
    out = np.empty_like(x, dtype=np.float32)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    e = np.exp(x[~pos])
    out[~pos] = e / (1.0 + e)
    return out


def detect(frames: List[np.ndarray], model_path: str,
           threshold: float = DEFAULT_THRESHOLD,
           **_kw: Any) -> List[List[Dict[str, Any]]]:
    """每帧一个框列表；坐标是**传入帧**的像素，label 恒为 "person"。"""
    session = load_session(model_path)
    in_name = session.get_inputs()[0].name
    out_names = [o.name for o in session.get_outputs()]
    results: List[List[Dict[str, Any]]] = []

    for frame in frames:
        ih, iw = frame.shape[:2]
        resized = resize_bilinear(frame, INPUT_SIZE, INPUT_SIZE)
        rgb = resized[:, :, ::-1]  # 抽帧给的是 BGR，模型吃 RGB
        blob = np.transpose(rgb, (2, 0, 1))[None].astype(np.float32) / 255.0
        raw = dict(zip(out_names, session.run(out_names, {in_name: np.ascontiguousarray(blob)})))
        logits = raw["logits"][0]
        boxes = raw["pred_boxes"][0]

        probs = _sigmoid(logits)
        cls = probs.argmax(axis=1)
        conf = probs.max(axis=1)
        sel = np.nonzero((cls == PERSON_CLASS) & (conf >= threshold))[0]

        out: List[Dict[str, Any]] = []
        for i in sel:
            cx, cy, w, h = boxes[i]
            # 归一化 cxcywh → 传入帧的像素（resize 没保比例，两个方向各按各的乘）
            x = (float(cx) - float(w) / 2) * iw
            y = (float(cy) - float(h) / 2) * ih
            out.append({
                "label": "person",
                "x": x, "y": y, "w": float(w) * iw, "h": float(h) * ih,
                "conf": round(float(conf[i]), 3),
            })
        out.sort(key=lambda b: -b["conf"])
        results.append(out)
    return results
