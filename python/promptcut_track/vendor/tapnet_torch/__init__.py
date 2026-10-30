"""google-deepmind/tapnet 的 PyTorch 推理代码（原样搬运，仅改了包内 import 路径）。

来源：https://github.com/google-deepmind/tapnet  (tapnet/torch/)
许可：Apache License 2.0，见同目录 LICENSE。官方明确说明预训练权重同样是 Apache 2.0。

搬进来而不是运行时 pip 安装 tapnet：tapnet 不是一个以 PyTorch 推理为目标的
发布包，装它会连训练侧的 JAX 依赖一起拖进来。这里只要三个文件。

**改动仅限于**：把 `from tapnet.torch import X` 改成 `from . import X`，
好让它作为本包的子模块工作。模型结构和数值一行没动。
"""
