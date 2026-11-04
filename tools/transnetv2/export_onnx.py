"""Export the official TransNetV2 weights to the ONNX used by PromptCut.

Run only once on the build machine; the output transnetv2.onnx ships to users with the "extension library package";
at runtime only onnxruntime is needed, neither torch nor tensorflow.

For usage see README.md in the same directory.

The model's forward returns (one_hot, {"many_hot": ...}); the second item is a dict, which ONNX cannot export,
so a wrapper layer is added here to turn both into tensor outputs:
  - cut_prob (one_hot): where the center of the transition is
  - many_hot: every frame that belongs to the transition; the true span of a dissolve depends on it
Both outputs are needed: without many_hot you only know "there is a dissolve here" but not how long it is.
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

    # Official inference uses a fixed window of 100 frames; only the batch dimension is made dynamic
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
