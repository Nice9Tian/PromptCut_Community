"""下载 Grounding DINO tiny 权重（full 档开放词汇检测用）。

**只在构建机上跑一次**，产物随「拓展库包（_full）」发给用户。
产物落在 tools/subject/out/grounding-dino-tiny/，不进 git（out 被 .gitignore 挡掉）。

用法（要 huggingface_hub，日常开发环境里有）：

    "C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe" tools/subject/fetch_dino.py
    # 直连 huggingface.co 不通时换镜像：
    HF_ENDPOINT=https://hf-mirror.com "…/python.exe" tools/subject/fetch_dino.py

为什么要挑文件下：仓库里同一份权重存了两份（pytorch_model.bin 和
model.safetensors），全量 snapshot 会把 690 MB 下成 1.3 GB，而 transformers
默认就读 safetensors，.bin 那份纯属浪费带宽和安装包体积。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

REPO_ID = "IDEA-Research/grounding-dino-tiny"

# 只要推理真正用得到的：权重（safetensors）、模型/预处理配置、分词器（BERT 那一半）。
# 明确排除 *.bin / *.msgpack / *.h5 —— 同一份权重的其他框架副本。
ALLOW = [
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
]
IGNORE = ["*.bin", "*.msgpack", "*.h5", "*.onnx", "*.pth"]

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "grounding-dino-tiny")


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            fp = os.path.join(root, name)
            if os.path.isfile(fp):
                total += os.path.getsize(fp)
    return total


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="下载 grounding-dino-tiny 到本地目录")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"落地目录（默认 {DEFAULT_OUT}）")
    ap.add_argument("--mirror", action="store_true",
                    help="强制走 https://hf-mirror.com（等价于设 HF_ENDPOINT）")
    args = ap.parse_args(argv)

    if args.mirror:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("需要 huggingface_hub：pip install huggingface_hub", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    print(f"endpoint = {os.environ.get('HF_ENDPOINT', 'https://huggingface.co')}")
    print(f"下载 {REPO_ID} → {args.out}")

    # local_dir 直接落成普通目录（不是 blobs+symlink 的缓存布局）：
    # 这份目录要原样拷进拓展包，Windows 上的符号链接会在打包/解压时散架。
    snapshot_download(
        repo_id=REPO_ID,
        local_dir=args.out,
        allow_patterns=ALLOW,
        ignore_patterns=IGNORE,
    )

    # snapshot_download 会在目录里留一个 .cache/huggingface（下载元数据 + 断点信息）。
    # 这份目录要整个拷进拓展包，把它带上既占体积又会让「模型目录」多出无关文件。
    cache = os.path.join(args.out, ".cache")
    if os.path.isdir(cache):
        shutil.rmtree(cache, ignore_errors=True)
        print("已删除 .cache/（下载元数据，不需要随包分发）")

    total = dir_size(args.out)
    print(f"\n目录大小：{total / 1024 / 1024:.1f} MB")
    for name in sorted(os.listdir(args.out)):
        fp = os.path.join(args.out, name)
        if os.path.isfile(fp):
            print(f"  {name:<28} {os.path.getsize(fp) / 1024 / 1024:8.2f} MB")

    missing = [n for n in ("config.json", "model.safetensors", "preprocessor_config.json")
               if not os.path.isfile(os.path.join(args.out, n))]
    if missing:
        print(f"缺文件：{missing}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
