"""取 light 档主体检测的两个权重，产物落在 tools/subject/out/。

**只在构建机上跑一次**，产物随「拓展库包」发给用户；用户那边只要 onnxruntime，
不需要 torch，也不需要 transformers。产物不进 git（out/ 被忽略）。

    python tools/subject/fetch_light_models.py [--out <目录>] [--skip-yunet] [--skip-rtdetr]

需要的环境：torch + transformers（只在导 RT-DETR 时用到）、onnx（torch.onnx.export
序列化 proto 要它）、onnxruntime（导完立刻回灌一次随机输入验形状）。
开发机上用 C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe，它缺 onnx，
临时 `pip install --target <临时目录> onnx` 再挂 PYTHONPATH，别改那个环境本身。

网络：HF 走 huggingface.co，不通就设 HF_ENDPOINT=https://hf-mirror.com。
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "out")

# YuNet 2023mar：OpenCV Zoo 的官方产物，约 0.3 MB。
# 许可证是 **MIT**，不是 Apache-2.0：opencv_zoo 根仓库确实是 Apache-2.0，但它的
# README 明写「Please refer to licenses of different models」，而
# models/face_detection_yunet/ 目录下自带一份 MIT LICENSE
# （Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>），以目录内的为准。
# 权重的训练上游 https://github.com/ShiqiYu/libfacedetection.train 是 BSD-3-Clause。
# 两份全文都随拓展包分发，见 desktop/scripts/licenses/ 和 THIRD-PARTY-LICENSES.md 第 9 节。
# 直接拿 raw 链接，不经第三方镜像 —— 这份权重是要跟着安装包发给用户的。
YUNET_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
YUNET_NAME = "yunet.onnx"
# 这份 ONNX 的输入维度是**写死**的 1x3x640x640（OpenCV 自己的 dnn 会重塑图，
# onnxruntime 不会），所以 yunet.py 必须 letterbox 到 640 再喂。
YUNET_SIZE = 640

RTDETR_REPO = "PekingU/rtdetr_r18vd"
RTDETR_NAME = "rtdetr_r18vd.onnx"
RTDETR_SIZE = 640  # HF 的 RTDetrImageProcessor 默认直接 resize 到 640x640，不保比例


def fetch_yunet(out_dir: str) -> str:
    dst = os.path.join(out_dir, YUNET_NAME)
    if os.path.isfile(dst):
        print(f"[yunet] 已存在，跳过：{dst}（{os.path.getsize(dst)} 字节）")
        return dst
    print(f"[yunet] 下载 {YUNET_URL}")
    tmp = dst + ".part"
    with urllib.request.urlopen(YUNET_URL, timeout=120) as resp, open(tmp, "wb") as fh:
        fh.write(resp.read())
    os.replace(tmp, dst)
    print(f"[yunet] 写入 {dst}（{os.path.getsize(dst)} 字节）")
    return dst


def export_rtdetr(out_dir: str) -> str:
    dst = os.path.join(out_dir, RTDETR_NAME)
    if os.path.isfile(dst):
        print(f"[rtdetr] 已存在，跳过：{dst}（{os.path.getsize(dst)} 字节）")
        return dst

    import torch
    from transformers import RTDetrForObjectDetection

    print(f"[rtdetr] 拉 {RTDETR_REPO}（HF_ENDPOINT={os.environ.get('HF_ENDPOINT', '默认')}）")
    model = RTDetrForObjectDetection.from_pretrained(RTDETR_REPO)
    model.eval()

    id2label = model.config.id2label
    # 核对 person 是 COCO 类 0：解码那边写死了 0，配置对不上就必须停下来
    person_id = [int(k) for k, v in id2label.items() if str(v).lower() == "person"]
    print(f"[rtdetr] id2label 里 person 的 id = {person_id}，类别数 = {len(id2label)}")
    if person_id != [0]:
        raise SystemExit(f"person 不是 0 号类（拿到 {person_id}），rtdetr.py 的解码要跟着改")

    class Wrap(torch.nn.Module):
        """只留 (logits, pred_boxes) 两个输出。

        原 forward 返回的是 dataclass，里面还挂着 encoder/decoder 的中间层，
        直接导会把一堆用不上的张量写进图里。
        """

        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            out = self.m(pixel_values=pixel_values)
            return out.logits, out.pred_boxes

    dummy = torch.zeros(1, 3, RTDETR_SIZE, RTDETR_SIZE, dtype=torch.float32)
    tmp = dst + ".part"
    print("[rtdetr] torch.onnx.export（opset 17）……")
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
    print(f"[rtdetr] 写入 {dst}（{os.path.getsize(dst)} 字节）")
    return dst


def verify(path: str, feed_name: str, shape) -> None:
    """载进 onnxruntime 跑一次随机输入，把输出形状打出来。"""
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    x = np.random.rand(*shape).astype("float32")
    outs = sess.run(None, {feed_name: x})
    names = [o.name for o in sess.get_outputs()]
    print(f"[verify] {os.path.basename(path)} 输入 {shape} → " +
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

    print("\n产物：")
    for name in (YUNET_NAME, RTDETR_NAME):
        f = os.path.join(args.out, name)
        if os.path.isfile(f):
            print(f"  {name:24s} {os.path.getsize(f) / 1e6:8.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
