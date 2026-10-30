# 生成 transnetv2.onnx

镜头识别用的模型。**只在构建机上做一次**，产物随「拓展库包」发给用户；
用户那边只需要 onnxruntime，不需要 torch，也不需要 tensorflow。

产物不进 git（29 MB 的二进制），构建发布包时从这里取。

## 为什么要自己转

TransNetV2 官方（[soCzech/TransNetV2](https://github.com/soCzech/TransNetV2)，MIT）
只发布 TensorFlow 权重。HuggingFace 上有第三方转好的 ONNX，但来源和量化方式
不可控，而这份权重是要跟着安装包发给用户的，所以自己从官方权重转一遍。

## 步骤

需要一个**临时**环境：torch（导 ONNX）+ tensorflow（读官方 checkpoint）。
tensorflow 只在转换时用到，**装到独立目录，别污染日常开发环境**——它和 torch
在 numpy / CUDA 版本上很容易打架。

```powershell
# 1. 官方 TF 权重（git-lfs，约 36 MB）
$B = "https://media.githubusercontent.com/media/soCzech/TransNetV2/master/inference/transnetv2-weights"
mkdir transnetv2-weights\variables
curl -L "$B/saved_model.pb" -o transnetv2-weights\saved_model.pb
curl -L "$B/variables/variables.data-00000-of-00001" -o transnetv2-weights\variables\variables.data-00000-of-00001
curl -L "$B/variables/variables.index" -o transnetv2-weights\variables\variables.index

# 2. 官方模型定义和权重转换脚本
$P = "https://raw.githubusercontent.com/soCzech/TransNetV2/master/inference-pytorch"
curl -L "$P/transnetv2_pytorch.py" -o transnetv2_pytorch.py
curl -L "$P/convert_weights.py"    -o convert_weights.py

# 3. 临时装 tensorflow 到独立目录
python -m pip install --target .\tflibs tensorflow-cpu==2.20.0

# 4. TF 权重 → PyTorch。--test 会逐帧对比两个实现，必须全部 100%
$env:PYTHONPATH = ".\tflibs"
python convert_weights.py --tf_weights .\transnetv2-weights\ --test

# 5. PyTorch → ONNX
python export_onnx.py
```

第 4 步的输出应该是 10 行 `100.0% of 'single' predictions matching`。
**有任何一行不是 100% 就别往下走**——那说明转出来的权重和官方对不上。

## 验收

产物约 29 MB。拿两段素材验一下（`kind` 要分得对）：

| 素材 | 期望 |
| --- | --- |
| 硬切拼接 | `kind: "cut"`，跨度 1~2 帧 |
| 1 秒交叉溶解 | `kind: "dissolve"`，跨度约 20 帧、覆盖整个渐变区间 |

```powershell
python -m promptcut_shots detect <素材.mp4> --fps 25
```

合成一段带已知切点的素材（ffmpeg 就能做）：

```powershell
ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=3" `
       -f lavfi -i "smptebars=size=640x360:rate=25:duration=3" `
       -filter_complex "[0][1]xfade=transition=fade:duration=1:offset=2" -pix_fmt yuv420p fade.mp4
```
