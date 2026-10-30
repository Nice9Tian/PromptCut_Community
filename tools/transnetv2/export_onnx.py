"""把 TransNetV2 官方权重导成 PromptCut 用的 ONNX。

只在构建机上跑一次，产物 transnetv2.onnx 随「拓展库包」发给用户；
运行时只需要 onnxruntime，不需要 torch，也不需要 tensorflow。

用法见同目录 README.md。

模型 forward 返回 (one_hot, {"many_hot": ...})，第二项是 dict，ONNX 导不了，
所以这里包一层，把两个都变成张量输出：
  - cut_prob (one_hot)：转场中心在哪
  - many_hot：属于转场的每一帧，溶解的真实跨度靠它
两个输出都要，缺了 many_hot 就只知道「这里有个溶解」而不知道它多长。
"""

import argparse

import torch

import transnetv2_pytorch


class Wrap(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, frames):
        out = self.model(frames)
        if isinstance(out, tuple):
            one_hot, extra = out
            return torch.sigmoid(one_hot), torch.sigmoid(extra["many_hot"])
        return torch.sigmoid(out), torch.sigmoid(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="./transnetv2-pytorch-weights.pth")
    ap.add_argument("--out", default="./transnetv2.onnx")
    args = ap.parse_args()

    model = transnetv2_pytorch.TransNetV2()
    model.load_state_dict(torch.load(args.weights, map_location="cpu"))
    model.eval()
    wrapped = Wrap(model).eval()

    # 官方推理固定 100 帧一个窗口，只让 batch 维动态
    dummy = torch.zeros((1, 100, 27, 48, 3), dtype=torch.uint8)
    with torch.no_grad():
        a, b = wrapped(dummy)
    print("forward ok:", tuple(a.shape), tuple(b.shape))

    torch.onnx.export(
        wrapped, dummy, args.out,
        input_names=["frames"],
        output_names=["cut_prob", "many_hot"],
        dynamic_axes={"frames": {0: "batch"},
                      "cut_prob": {0: "batch"},
                      "many_hot": {0: "batch"}},
        opset_version=17,
    )
    print("wrote", args.out)


if __name__ == "__main__":
    main()
