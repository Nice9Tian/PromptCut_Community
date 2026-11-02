"""Fetch the two weights for light-tier subject detection; the output lands in tools/subject/out/.

**Run only once on the build machine**; the output ships to users with the "extension library package"; on the user's side only onnxruntime is needed,
neither torch nor transformers. The output does not go into git (out/ is ignored).

    python tools/subject/fetch_light_models.py [--out <dir>] [--skip-yunet] [--skip-rtdetr]

Required environment: torch + transformers (only used when exporting RT-DETR), onnx (torch.onnx.export
needs it to serialize the proto), onnxruntime (right after export, feed a random input back to verify the shapes).
On the dev machine use C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe, which lacks onnx,
so temporarily `pip install --target <temp dir> onnx` and then put it on PYTHONPATH; do not change that environment itself.

Network: HF goes through huggingface.co; if that is unreachable, set HF_ENDPOINT=https://hf-mirror.com.
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "out")

# YuNet 2023mar: an official artifact of OpenCV Zoo, about 0.3 MB.
# The license is **MIT**, not Apache-2.0: the opencv_zoo root repo is indeed Apache-2.0, but its
# README explicitly says "Please refer to licenses of different models", and
# models/face_detection_yunet/ ships with its own MIT LICENSE
# (Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>); the one inside the directory prevails.
# The training upstream of the weights, https://github.com/ShiqiYu/libfacedetection.train, is BSD-3-Clause.
# The full text of both ships with the extension package, see desktop/scripts/licenses/ and section 9 of THIRD-PARTY-LICENSES.md.
# Fetch the raw link directly, not through a third-party mirror: these weights ship to users with the installer.
YUNET_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
YUNET_NAME = "yunet.onnx"
# The input dimensions of this ONNX are **hard-coded** as 1x3x640x640 (OpenCV's own dnn reshapes the graph,
# onnxruntime does not), so yunet.py must letterbox to 640 before feeding it.
YUNET_SIZE = 640

RTDETR_REPO = "PekingU/rtdetr_r18vd"
RTDETR_NAME = "rtdetr_r18vd.onnx"
RTDETR_SIZE = 640  # HF's RTDetrImageProcessor by default resizes straight to 640x640, without keeping the aspect ratio


def fetch_yunet(out_dir: str) -> str:
    dst = os.path.join(out_dir, YUNET_NAME)
    if os.path.isfile(dst):
        print(f"[yunet] already exists, skipping: {dst} ({os.path.getsize(dst)} bytes)")
        return dst
    print(f"[yunet] downloading {YUNET_URL}")
    tmp = dst + ".part"
    with urllib.request.urlopen(YUNET_URL, timeout=120) as resp, open(tmp, "wb") as fh:
        fh.write(resp.read())
    os.replace(tmp, dst)
    print(f"[yunet] wrote {dst} ({os.path.getsize(dst)} bytes)")
    return dst


def export_rtdetr(out_dir: str) -> str:
    dst = os.path.join(out_dir, RTDETR_NAME)
    if os.path.isfile(dst):
        print(f"[rtdetr] already exists, skipping: {dst} ({os.path.getsize(dst)} bytes)")
        return dst

    import torch
    from transformers import RTDetrForObjectDetection

    print(f"[rtdetr] pulling {RTDETR_REPO} (HF_ENDPOINT={os.environ.get('HF_ENDPOINT', 'default')})")
    model = RTDetrForObjectDetection.from_pretrained(RTDETR_REPO)
    model.eval()

    id2label = model.config.id2label
    # Verify that person is COCO class 0: the decoding side hard-codes 0, so if the config does not match we must stop
    person_id = [int(k) for k, v in id2label.items() if str(v).lower() == "person"]
    print(f"[rtdetr] id of person in id2label = {person_id}, number of classes = {len(id2label)}")
    if person_id != [0]:
        raise SystemExit(f"person is not class 0 (got {person_id}), the decoding in rtdetr.py has to change accordingly")

    class Wrap(torch.nn.Module):
        """Keep only the two outputs (logits, pred_boxes).

        The original forward returns a dataclass that also carries the encoder/decoder intermediate layers,
        and exporting it directly would write a pile of unused tensors into the graph.
        """

        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            out = self.m(pixel_values=pixel_values)
            return out.logits, out.pred_boxes

    dummy = torch.zeros(1, 3, RTDETR_SIZE, RTDETR_SIZE, dtype=torch.float32)
    tmp = dst + ".part"
    print("[rtdetr] torch.onnx.export (opset 17)…")
    with torch.no_grad():
        torch.onnx.export(
            Wrap(model),
            (dummy,),
            tmp,
            input_names=["pixel_values"],
            output_names=["logits", "pred_boxes"],
            opset_version=17,
            do_constant_folding=True,
            dynamo=False,
        )
    os.replace(tmp, dst)
    print(f"[rtdetr] wrote {dst} ({os.path.getsize(dst)} bytes)")
    return dst


def verify(path: str, feed_name: str, shape) -> None:
    """Load it into onnxruntime, run it once on a random input, and print the output shapes."""
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    x = np.random.rand(*shape).astype("float32")
    outs = sess.run(None, {feed_name: x})
    names = [o.name for o in sess.get_outputs()]
    print(f"[verify] {os.path.basename(path)} input {shape} → " +
          ", ".join(f"{n}{list(o.shape)}" for n, o in zip(names, outs)))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--skip-yunet", action="store_true")
    ap.add_argument("--skip-rtdetr", action="store_true")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)

    if not args.skip_yunet:
        p = fetch_yunet(args.out)
        verify(p, "input", (1, 3, YUNET_SIZE, YUNET_SIZE))
    if not args.skip_rtdetr:
        p = export_rtdetr(args.out)
        verify(p, "pixel_values", (1, 3, RTDETR_SIZE, RTDETR_SIZE))

    print("\nOutputs:")
    for name in (YUNET_NAME, RTDETR_NAME):
        f = os.path.join(args.out, name)
        if os.path.isfile(f):
            print(f"  {name:24s} {os.path.getsize(f) / 1e6:8.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
