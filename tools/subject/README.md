# 生成主体检测的权重

「别让卡片遮住人物的脸」这件事需要知道人在哪。三份权重，**只在构建机上取一次**，
产物随「拓展库包」发给用户；用户那边只装依赖，不下载模型。

产物落在 `tools/subject/out/`，不进 git（`.gitignore` 的 `out` 规则挡掉）。

| 文件 | 档位 | 大小 | 许可 | 来源 |
| --- | --- | --- | --- | --- |
| `yunet.onnx` | light | 0.22 MB | **MIT**（见下） | OpenCV Zoo [`models/face_detection_yunet`](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) 的 `face_detection_yunet_2023mar.onnx` |
| `rtdetr_r18vd.onnx` | light | 77 MB | Apache-2.0 | HF `PekingU/rtdetr_r18vd`，本地 `torch.onnx.export` |
| `grounding-dino-tiny/` | full | 658 MB（目录） | Apache-2.0 | HF `IDEA-Research/grounding-dino-tiny` snapshot |

**YuNet 的许可证容易搞错**：opencv_zoo **根仓库**是 Apache-2.0，但它的 README 明写
「Please refer to licenses of different models」，而 `models/face_detection_yunet/`
目录下自带一份 **MIT** LICENSE（`Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>`），
以目录内的为准。权重的训练上游 [ShiqiYu/libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train)
是 **BSD-3-Clause**。所以引用来源要精确到模型目录，指到根仓库就会读成 Apache-2.0 —— 2026-09-07
之前打出去的两个 exe 就是这么标错的。两份许可证全文都随拓展包分发（`desktop/scripts/licenses/`），
登记见 [`desktop/THIRD-PARTY-LICENSES.md`](../../desktop/THIRD-PARTY-LICENSES.md) 第 9 节。
另外训练集 WIDER FACE 的数据集条款是非商用，分发前请自行评估（同上文档的检查清单里有这一条）。

两档的分工：light 只认固定类别（人脸、人体），跑 onnxruntime，几十毫秒一帧；
full 认**任意英文名词短语**，跑 torch + transformers，约 1 秒一帧。

## light 档：yunet.onnx + rtdetr_r18vd.onnx

```powershell
# 需要 torch + transformers（导 RT-DETR 用）、onnx、onnxruntime
"C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe" tools/subject/fetch_light_models.py
```

YuNet 直接取 OpenCV Zoo 的官方 ONNX，不经第三方镜像——这份权重要跟着安装包发给
用户。RT-DETR 是从 HF 的 PyTorch 权重自己导的：脚本会先核对 `id2label` 里
person 确实是 0 号类（`rtdetr.py` 的解码写死了 0），对不上就直接停。导完立刻
用 onnxruntime 回灌一次随机输入，把输出形状打出来：

```
[verify] yunet.onnx        输入 (1,3,640,640) → cls/obj/bbox/kps × stride 8/16/32
[verify] rtdetr_r18vd.onnx 输入 (1,3,640,640) → logits[1,300,80], pred_boxes[1,300,4]
产物：yunet.onnx 0.23 MB（232,589 B）／rtdetr_r18vd.onnx 81.04 MB（81,039,556 B）
```

导出参数：opset 17、`do_constant_folding=True`、输入 `pixel_values [1,3,640,640]`、
输出 `logits [1,300,80]` + `pred_boxes [1,300,4]`（cxcywh，归一化）。导出时的
TracerWarning 全是「把形状常量化」那一类，输入维度本来就写死，可以忽略。

两个和直觉相反、写代码时踩过的点：

- **YuNet 的输入维度是写死的 1×3×640×640。** OpenCV 自己的 dnn 会按 `setInputSize`
  重塑整张图，onnxruntime 不会。所以 `yunet.py` 必须先 letterbox 到 640×640
  （保比例、右下补黑）再喂，框换算回去时除掉那个缩放系数。
- **RT-DETR 不做 ImageNet 归一化。** 它的 `preprocessor_config.json` 是
  `do_rescale=true, rescale_factor=1/255`、**`do_normalize=false`**、
  `size={640,640}`（直接 resize，不保比例）。按 ImageNet 均值方差喂进去，同一帧上
  人体分数会从 0.98 掉到 0.3 上下——看着像模型不准，其实是预处理错了。

## 验收（light 档）

用真实竖屏素材（720x1280 的说话人镜头）在默认 `--max-side 640` 下实测，CPU：

```powershell
$env:PROMPTCUT_MODELS = "tools/subject/out"
python -m promptcut_subject status                       # engine 至少是 "light"
python -m promptcut_subject detect <素材.mp4> --times 1,3,5,7,9,11,13
```

| 指标 | 实测 |
| --- | --- |
| YuNet 稳态单帧（360x640） | **6.9 ms** |
| RT-DETR 稳态单帧（360x640） | **126 ms** |
| ffmpeg 抽一帧（含起进程） | 61 ms |
| 两个模型加载（进程内一次） | 约 1.3 s（几乎全在 81 MB 的 RT-DETR 上） |
| 7 个样本一趟总耗时（含加载） | **6.9 s** |
| 说话人正脸 | face conf 0.94~0.95，person conf 0.975~0.984 |

框对不对靠画出来看：`face` 框贴着额头到下巴，`person` 框贴着人的轮廓。另外拿
full 档在同一帧上交叉验了一次——DINO 给的 face 框是 (214,278,336x462)，YuNet 给的
是 (222,274,325x466)，两个完全独立的实现差不到 10 px，说明 YuNet 那套纯 numpy 的
先验框解码没写错。

## full 档：grounding-dino-tiny/

```powershell
# 需要 huggingface_hub
"C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe" tools/subject/fetch_dino.py
# 直连 huggingface.co 不通时：
$env:HF_ENDPOINT="https://hf-mirror.com"; ... 或加 --mirror
```

模型是**一个目录**（HF snapshot），不是单文件，拓展包按目录整个递归拷进 `models/`：

```
grounding-dino-tiny/
  config.json                    1.6 KB
  model.safetensors            657.4 MB   ← 172M 参数 fp32
  preprocessor_config.json       457 B
  tokenizer.json               711.4 KB
  tokenizer_config.json          1.2 KB
  special_tokens_map.json        125 B
  vocab.txt                    231.5 KB
```

合计 658.3 MB（磁盘 689,359,096 字节那份是 `model.safetensors`）。

两处刻意为之：

- **只下 safetensors。** 仓库里同一份权重存了两份（`pytorch_model.bin` 和
  `model.safetensors`），全量 snapshot 会把 658 MB 下成 1.3 GB，而 transformers
  默认就读 safetensors。脚本用 `allow_patterns` 白名单挑文件，并显式
  `ignore_patterns` 掉 `*.bin` / `*.msgpack` / `*.h5`。
- **`local_dir` 落成普通目录，下完删掉 `.cache/`。** 默认的 blobs+symlink 缓存布局
  在 Windows 上打包/解压会散架；`.cache/huggingface` 是断点续传的元数据，不该随包分发。

## 验收（full 档）

用真实竖屏素材（1080x1920）在 `--max-side 640` 下抽 3 帧实测，20 线程 CPU：

```powershell
$env:PROMPTCUT_MODELS = "tools/subject/out"
$env:PROMPTCUT_FFMPEG = "desktop/src-tauri/runtime/ffmpeg/ffmpeg.exe"
python -m promptcut_subject status          # engine 应该是 "full"
python -m promptcut_subject detect <素材.mp4> --times 3,12,25 --engine full --prompt "person . face ."
```

期望：

| 指标 | 实测 |
| --- | --- |
| 模型加载（进程内一次） | 3.7~3.9 s |
| 稳态单帧（360x640） | 0.90~1.04 s，均值 **0.95 s** |
| 峰值工作集 | **1.67 GB** |
| 3 帧一趟总耗时（含加载） | 8.0 s |
| `person . face .` 的框 | person conf 0.80~0.82（整个人），face conf 0.64~0.68（脸） |

**分辨率是最大的一个坑。** 官方预处理是 `shortest_edge=800 / longest_edge=1333`，
它会把已经缩到 640 的帧**再放大回去**（360x640 → 750x1333）。同一批帧对比：

| 喂进去的尺寸 | 单帧耗时 | 峰值工作集 | person 分数 |
| --- | --- | --- | --- |
| 官方 800/1333（750x1333） | 3.38 s | 2.79 GB | 0.806 |
| 原样 360x640 | **0.94 s** | **1.67 GB** | 0.820 |

快 3.6 倍、省 1.1 GB，框的坐标只差 1~2 px，分数反而略高。所以 `dino.py` 默认
**不改帧尺寸**（`max_side=None`），把分辨率的决定权留给 `__main__ --max-side`。

**提示词必须是英文。** 文本那一半是 `bert-base-uncased`，词表里没有中文。
同一张图：

- `"monitor . chair . glasses ."` → glasses 0.91 / monitor 0.43 / chair 0.37，位置都对；
- `"显示器 . 椅子 ."` → 标签被切成 `"[UNK] 示 [UNK] 子"`，随便框住画面主体交差
  （conf 0.44）。**看着像成功，其实全是噪声。**

上层（MCP 工具描述、系统提示）必须把用户的中文需求翻成英文名词短语再传下来。

## 依赖体积（full 包的账）

用自带解释器 `pip download -r python/promptcut_subject/requirements-subject-full.txt`
实测（2026-09）：26 个轮子共 **164 MB**，其中 torch 118 MB、numpy 12 MB、
transformers 11 MB、pillow 6.9 MB、sympy 6 MB、tokenizers 2.6 MB。

加 `--extra-index-url https://download.pytorch.org/whl/cpu` 抓到的是 `2.14.0+cpu`，
大小一模一样——Windows 上 PyPI 的 torch 轮子本来就是 CPU 版，打包脚本不用开特例。

所以 full 档相对 light 档的净增量约为：依赖 +164 MB（和 track 共用 torch）、
权重 +658 MB。
