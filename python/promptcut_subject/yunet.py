"""YuNet face detection (ONNX / onnxruntime).

The weights are OpenCV Zoo's face_detection_yunet_2023mar.onnx, **MIT** (the opencv_zoo root repo
is Apache-2.0, but the models/face_detection_yunet/ directory ships its own MIT LICENSE,
Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>, the one inside the directory prevails; the training upstream of the weights
ShiqiYu/libfacedetection.train is BSD-3-Clause). See tools/subject/README.md for how to obtain them.

License notice (this file is a port of third-party code, not an original work):
    The pre- and post-processing of this module is ported from OpenCV's FaceDetectorYN
    (https://github.com/opencv/opencv , modules/objdetect/src/face_detect.cpp),
    Apache License 2.0. See LICENSE-opencv in the same directory for the full text, registered in
    desktop/THIRD-PARTY-LICENSES.md section 7.2.
    Changes (required to be stated by Apache-2.0 §4(b)): rewritten with numpy, **no cv2 dependency**; letterbox implemented in-house;
    the score threshold changed from OpenCV's default 0.9 to 0.6 (the NMS threshold 0.3 is the same as upstream); output changed to
    Python dicts instead of OpenCV's Mat. Upstream has no copyright line to retain (the repo root LICENSE is the Apache-2.0
    full text itself with no copyright line, the face_detect.cpp file header only points to LICENSE, and the repo has no NOTICE file).

The reason cv2 is not used: the user's machine has no opencv, and it is not worth stuffing 40 MB into the extension pack just for one resize.
Porting notes:

  - Input is BGR, NCHW, float32, **not normalized** (the raw 0~255 values);
  - This ONNX has its input dimensions hard-coded to 1×3×640×640, so letterbox to 640 is needed;
  - Output is three groups of cls/obj/bbox/kps for strides 8/16/32, flattened by (r * cols + c);
  - Decode cx=(c+dx)*s, cy=(r+dy)*s, w=exp(dw)*s, h=exp(dh)*s;
  - The score is sqrt(cls*obj), not either one of the two.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from .frames import letterbox

MODEL_FILENAME = "yunet.onnx"

INPUT_SIZE = 640
STRIDES = (8, 16, 32)

# The threshold comes from the contract: 0.6 is looser than OpenCV's default 0.9, because all we need here is "roughly knowing where the face is",
# and missing a profile face hurts more than one extra false detection: a card landing on a face is a mistake the user sees on the spot.
DEFAULT_SCORE = 0.6
DEFAULT_NMS = 0.3

_SESSIONS: Dict[str, Any] = {}


def load_session(model_path: str):
    """Sessions are cached by path: detect is called once per sample, and reopening a session each time would let initialization alone eat up all the time."""
    sess = _SESSIONS.get(model_path)
    if sess is None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        sess = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
        _SESSIONS[model_path] = sess
    return sess


def _priors(size: int, stride: int):
    """The (column, row) of every cell at a given stride, flattened in the same order as the model output (row-major)."""
    cols = size // stride
    rows = size // stride
    c = np.tile(np.arange(cols, dtype=np.float32), rows)
    r = np.repeat(np.arange(rows, dtype=np.float32), cols)
    return c, r


def nms(boxes: np.ndarray, scores: np.ndarray, thresh: float) -> List[int]:
    """Standard IoU NMS. boxes is an [N,4] array of xywh."""
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
    """Raw outputs of the three strides → (boxes[N,4] xywh, scores[N]), with coordinates on the 640 canvas."""
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
    """One box list per frame; coordinates are in pixels of the **passed-in frame**, and label is always "face"."""
    session = load_session(model_path)
    names = [o.name for o in session.get_outputs()]
    results: List[List[Dict[str, Any]]] = []

    for frame in frames:
        canvas, scale = letterbox(frame, INPUT_SIZE)
        # BGR NCHW, not normalized. The result of transpose is a view, so run it through ascontiguousarray:
        # The behavior of onnxruntime on non-contiguous arrays is not documented, so we do not gamble on it.
        blob = np.ascontiguousarray(np.transpose(canvas, (2, 0, 1))[None], dtype=np.float32)
        raw = session.run(names, {session.get_inputs()[0].name: blob})
        outputs = dict(zip(names, raw))
        boxes, scores = _decode(outputs, score_threshold)
        keep = nms(boxes, scores, nms_threshold)
        out: List[Dict[str, Any]] = []
        for i in keep:
            x, y, w, h = boxes[i] / max(scale, 1e-9)  # convert from the 640 canvas back to pixels of the passed-in frame
            out.append({
                "label": "face",
                "x": float(x), "y": float(y), "w": float(w), "h": float(h),
                "conf": round(float(scores[i]), 3),
            })
        results.append(out)
    return results
