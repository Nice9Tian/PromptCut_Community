"""Download the Grounding DINO tiny weights (used for full-tier open-vocabulary detection).

**Run only once on the build machine**; the output ships to users with the "extension library package (_full)".
The output lands in tools/subject/out/grounding-dino-tiny/ and does not go into git (out is blocked by .gitignore).

Usage (requires huggingface_hub, which the everyday dev environment has):

    "C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe" tools/subject/fetch_dino.py
    # Switch to a mirror when huggingface.co cannot be reached directly:
    HF_ENDPOINT=https://hf-mirror.com "…/python.exe" tools/subject/fetch_dino.py

Why pick files to download: the repo stores the same weights twice (pytorch_model.bin and
model.safetensors), a full snapshot would turn 690 MB into 1.3 GB, while transformers
reads safetensors by default, so the .bin copy is pure waste of bandwidth and installer size.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

REPO_ID = "IDEA-Research/grounding-dino-tiny"

# Only what inference really uses: the weights (safetensors), the model/preprocessing config, the tokenizer (the BERT half).
# Explicitly exclude *.bin / *.msgpack / *.h5: copies of the same weights for other frameworks.
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
    ap = argparse.ArgumentParser(description="Download grounding-dino-tiny to a local directory")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"target directory (default {DEFAULT_OUT})")
    ap.add_argument("--mirror", action="store_true",
                    help="force https://hf-mirror.com (equivalent to setting HF_ENDPOINT)")
    args = ap.parse_args(argv)

    if args.mirror:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub is required: pip install huggingface_hub", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    print(f"endpoint = {os.environ.get('HF_ENDPOINT', 'https://huggingface.co')}")
    print(f"Downloading {REPO_ID} → {args.out}")

    # local_dir lands directly as a plain directory (not the blobs+symlink cache layout):
    # This directory has to be copied into the extension package as is, and symlinks on Windows fall apart during packaging/extraction.
    snapshot_download(
        repo_id=REPO_ID,
        local_dir=args.out,
        allow_patterns=ALLOW,
        ignore_patterns=IGNORE,
    )

    # snapshot_download leaves a .cache/huggingface in the directory (download metadata + resume information).
    # This directory is copied into the extension package whole, and carrying it along both takes up space and adds unrelated files to the "model directory".
    cache = os.path.join(args.out, ".cache")
    if os.path.isdir(cache):
        shutil.rmtree(cache, ignore_errors=True)
        print("Deleted .cache/ (download metadata, no need to ship it with the package)")

    total = dir_size(args.out)
    print(f"\nDirectory size: {total / 1024 / 1024:.1f} MB")
    for name in sorted(os.listdir(args.out)):
        fp = os.path.join(args.out, name)
        if os.path.isfile(fp):
            print(f"  {name:<28} {os.path.getsize(fp) / 1024 / 1024:8.2f} MB")

    missing = [n for n in ("config.json", "model.safetensors", "preprocessor_config.json")
               if not os.path.isfile(os.path.join(args.out, n))]
    if missing:
        print(f"Missing files: {missing}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
