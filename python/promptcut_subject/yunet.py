"""YuNet 人脸检测（ONNX / onnxruntime）。

权重是 OpenCV Zoo 的 face_detection_yunet_2023mar.onnx，**MIT**（opencv_zoo 根仓库
是 Apache-2.0，但 models/face_detection_yunet/ 目录自带一份 MIT LICENSE，
Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>，以目录内的为准；权重的训练上游
ShiqiYu/libfacedetection.train 是 BSD-3-Clause）。取法见 tools/subject/README.md。

许可证声明（本文件是第三方代码的移植，不是原创）：
    本模块的前后处理移植自 OpenCV 的 FaceDetectorYN
    （https://github.com/opencv/opencv ，modules/objdetect/src/face_detect.cpp），
    Apache License 2.0。全文见同目录的 LICENSE-opencv，登记见
    desktop/THIRD-PARTY-LICENSES.md 第 7.2 节。
    改动（Apache-2.0 §4(b) 要求注明）：用 numpy 重写，**不依赖 cv2**；letterbox 自己实现；
    分数阈值由 OpenCV 默认的 0.9 改为 0.6（NMS 阈值 0.3 与上游相同）；输出改成
    Python dict 而不是 OpenCV 那套 Mat。上游没有可保留的版权行（仓库根 LICENSE 就是 Apache-2.0
    全文本身、无版权行，face_detect.cpp 文件头也只指向 LICENSE，仓库没有 NOTICE 文件）。

之所以不用 cv2：用户机器上没有 opencv，也不值得为了一个 resize 往拓展包里塞 40 MB。
移植要点：

  - 输入是 BGR、NCHW、float32，**不归一化**（就是 0~255 的原值）；
  - 这份 ONNX 的输入维度写死 1×3×640×640，所以要 letterbox 到 640；
  - 输出是 stride 8/16/32 三组 cls/obj/bbox/kps，按 (r * cols + c) 展平；
  - 解码 cx=(c+dx)*s, cy=(r+dy)*s, w=exp(dw)*s, h=exp(dh)*s；
  - 分数是 sqrt(cls*obj)，不是两者之一。
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from .frames import letterbox

MODEL_FILENAME = "yunet.onnx"

INPUT_SIZE = 640
STRIDES = (8, 16, 32)

# 阈值来自契约：0.6 比 OpenCV 默认的 0.9 松，因为这里要的是「大致知道脸在哪」，
# 漏一张侧脸比多一个误检更伤 —— 卡片压到脸上是用户当场就能看见的错。
DEFAULT_SCORE = 0.6
DEFAULT_NMS = 0.3

_SESSIONS: Dict[str, Any] = {}


def load_session(model_path: str):
    """会话按路径缓存：每个样本调一次 detect，重开会话的话光初始化就占满耗时。"""
    sess = _SESSIONS.get(model_path)
    if sess is None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        sess = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
        _SESSIONS[model_path] = sess
    return sess


def _priors(size: int, stride: int):
    """某个 stride 上每个格子的 (列, 行)，展平顺序和模型输出一致（行优先）。"""
    cols = size // stride
    rows = size // stride
    c = np.tile(np.arange(cols, dtype=np.float32), rows)
    r = np.repeat(np.arange(rows, dtype=np.float32), cols)
    return c, r


def nms(boxes: np.ndarray, scores: np.ndarray, thresh: float) -> List[int]:
    """标准 IoU NMS。boxes 是 [N,4] 的 xywh。"""
    if len(boxes) == 0:
        return []
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 0] + boxes[:, 2]
    y2 = boxes[:, 1] + boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: List[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter
        iou = np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)
        order = rest[iou <= thresh]
    return keep


def _decode(outputs: Dict[str, np.ndarray], score_threshold: float):
    """三个 stride 的原始输出 → (boxes[N,4] xywh, scores[N])，坐标在 640 画布上。"""
    all_boxes: List[np.ndarray] = []
    all_scores: List[np.ndarray] = []
    for stride in STRIDES:
        cls = outputs[f"cls_{stride}"][0, :, 0]
        obj = outputs[f"obj_{stride}"][0, :, 0]
        bbox = outputs[f"bbox_{stride}"][0]
        cols, rows = _priors(INPUT_SIZE, stride)
        n = min(len(cls), len(obj), len(bbox), len(cols))
        cls = np.clip(cls[:n], 0.0, 1.0)
        obj = np.clip(obj[:n], 0.0, 1.0)
        score = np.sqrt(cls * obj)
        sel = np.nonzero(score >= score_threshold)[0]
        if sel.size == 0:
            continue
        d = bbox[sel]
        cx = (cols[sel] + d[:, 0]) * stride
        cy = (rows[sel] + d[:, 1]) * stride
        w = np.exp(np.clip(d[:, 2], -10.0, 10.0)) * stride
        h = np.exp(np.clip(d[:, 3], -10.0, 10.0)) * stride
        all_boxes.append(np.stack([cx - w / 2, cy - h / 2, w, h], axis=1))
        all_scores.append(score[sel])
    if not all_boxes:
        return np.zeros((0, 4), dtype=np.float32), np.zeros((0,), dtype=np.float32)
    return np.concatenate(all_boxes).astype(np.float32), np.concatenate(all_scores).astype(np.float32)


def detect(frames: List[np.ndarray], model_path: str,
           score_threshold: float = DEFAULT_SCORE,
           nms_threshold: float = DEFAULT_NMS,
           **_kw: Any) -> List[List[Dict[str, Any]]]:
    """每帧一个框列表；坐标是**传入帧**的像素，label 恒为 "face"。"""
    session = load_session(model_path)
    names = [o.name for o in session.get_outputs()]
    results: List[List[Dict[str, Any]]] = []

    for frame in frames:
        canvas, scale = letterbox(frame, INPUT_SIZE)
        # BGR NCHW，不归一化。transpose 出来是个视图，得 ascontiguousarray 一下：
        # onnxruntime 收到非连续数组时的行为不写在文档里，不赌。
        blob = np.ascontiguousarray(np.transpose(canvas, (2, 0, 1))[None], dtype=np.float32)
        raw = session.run(names, {session.get_inputs()[0].name: blob})
        outputs = dict(zip(names, raw))
        boxes, scores = _decode(outputs, score_threshold)
        keep = nms(boxes, scores, nms_threshold)
        out: List[Dict[str, Any]] = []
        for i in keep:
            x, y, w, h = boxes[i] / max(scale, 1e-9)  # 从 640 画布换回传入帧的像素
            out.append({
                "label": "face",
                "x": float(x), "y": float(y), "w": float(w), "h": float(h),
                "conf": round(float(scores[i]), 3),
            })
        results.append(out)
    return results
