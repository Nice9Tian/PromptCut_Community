"""RT-DETR-R18 human body detection (ONNX / onnxruntime).

Weights are exported with torch.onnx.export from HF's PekingU/rtdetr_r18vd (Apache-2.0),
see tools/subject/README.md for how to obtain them. Input pixel_values [1,3,640,640] float32,
outputs logits [1,300,80] and pred_boxes [1,300,4] (cxcywh, normalized to 0~1).

Preprocessing follows HF's RTDetrImageProcessor: **resize directly to 640×640 without keeping the aspect ratio**,
only divide by 255, **no ImageNet mean/variance normalization**: the preprocessor_config.json of this model
has do_normalize set to false (do_rescale=true, rescale_factor=1/255). This differs from
the original verbal agreement, and the model's own config takes precedence; feeding ImageNet-normalized input, in practice,
drops the body score on the same frame from 0.95 to around 0.3.

RT-DETR is in the DETR family: each of the 300 queries outputs one box, and there is no NMS: the official post-processing is simply
to pick by score after sigmoid, with duplicate boxes suppressed by the model itself.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from .frames import resize_bilinear

MODEL_FILENAME = "rtdetr_r18vd.onnx"

INPUT_SIZE = 640
PERSON_CLASS = 0  # COCO's person; the export script checks the config's id2label and refuses to export if they do not match
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
    # Plain 1/(1+exp(-x)) overflows with a warning when x is very negative, so it is written piecewise
    out = np.empty_like(x, dtype=np.float32)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    e = np.exp(x[~pos])
    out[~pos] = e / (1.0 + e)
    return out


def detect(frames: List[np.ndarray], model_path: str,
           threshold: float = DEFAULT_THRESHOLD,
           **_kw: Any) -> List[List[Dict[str, Any]]]:
    """One box list per frame; coordinates are in pixels of the **passed-in frame**, and label is always "person"."""
    session = load_session(model_path)
    in_name = session.get_inputs()[0].name
    out_names = [o.name for o in session.get_outputs()]
    results: List[List[Dict[str, Any]]] = []

    for frame in frames:
        ih, iw = frame.shape[:2]
        resized = resize_bilinear(frame, INPUT_SIZE, INPUT_SIZE)
        rgb = resized[:, :, ::-1]  # frame extraction yields BGR, the model takes RGB
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
            # Normalized cxcywh → pixels of the passed-in frame (resize did not keep the aspect ratio, so each axis is scaled by its own factor)
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
