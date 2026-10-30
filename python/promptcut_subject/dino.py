"""full 档后端：Grounding DINO tiny（开放词汇检测）。

IDEA-Research/grounding-dino-tiny（Apache-2.0，172M 参数，fp32 权重约 690 MB），
走 HF transformers + PyTorch CPU。它认的是**任意英文名词短语**——"person . face ."
和 "red cup . laptop ." 是同一套代码，这是 light 档（YuNet + RT-DETR 只认固定
类别）换不来的能力，也是 full 包多背 658 MB 权重 + 164 MB 依赖的唯一理由。
（中文提示不行，词表里没有，见 _normalize_prompt。）

对外只有一个 detect()，签名和 yunet.py / rtdetr.py 对齐（多一个 prompt）：
帧进（BGR uint8 HxWx3）、框出（坐标是**传入帧**的像素，不是原视频像素——
换算回原尺寸是 __main__ 的活）。
"""

from __future__ import annotations

import inspect
import os
import threading
from typing import Any, Dict, List, Optional

import numpy as np

# 模型是一个**目录**（HF snapshot），不是单文件：config.json + model.safetensors
# + preprocessor_config.json + 分词器那几个。拓展包按目录整个拷进 models/。
MODEL_DIRNAME = "grounding-dino-tiny"

# 判断「模型在不在」的判据必须和 from_pretrained **真正读的文件**对齐，宁可严一点：
# 判据松了的后果是 status 报 engine="full"、detect 却在 transformers 内部炸出一句
# 无法定位的话（拷贝中断、杀毒软件拦掉小文件、rsync 只搬完大文件都会留下这种半个目录）。
#
# 实测（cuda_Vit / transformers 4.57.6，把真权重目录硬链接成临时目录后逐个删文件，
# 跑 AutoProcessor.from_pretrained(local_files_only=True)）：
#   删 tokenizer.json 或 vocab.txt 任一个   → 还能加载（另一个能顶上）
#   两个一起删                              → TypeError: stat: path should be string,
#                                             bytes, os.PathLike or integer, not NoneType
#                                             （就是这句「完全看不出缺什么」的报错）
#   删 tokenizer_config.json                → 能加载，但 tokenizer.model_max_length 从 512
#                                             变成 1000000000000000019884624838656 这个哨兵值，
#                                             长提示词不再被截到 512，会一路捅进模型的位置嵌入
#   删 special_tokens_map.json              → 能加载，行为不变，所以不列为必需
REQUIRED_FILES = ("config.json", "model.safetensors", "preprocessor_config.json",
                  "tokenizer_config.json")

# 分词器的词表：这两个至少要有一个（tokenizer.json 是 fast 版的整包，vocab.txt 是
# 慢版词表，transformers 能从任一个建出 BertTokenizerFast）。两个都没有才是真缺。
TOKENIZER_FILES = ("tokenizer.json", "vocab.txt")

DEFAULT_PROMPT = "person . face ."

# max_side 的三种取值（默认 None）：
#   None → 帧多大就按多大喂，既不放大也不缩小；
#   >0   → 最长边再压到这个值（帧本来就更小时不动）；
#   0    → 交还给官方预处理（shortest_edge=800 / longest_edge=1333）。
#
# 默认不动帧尺寸，是因为官方预处理会把 __main__ 已经缩到 640 的帧**再放大回去**
# （360x640 → 750x1333），纯亏算力。实测（20 线程 CPU，360x640 竖屏真实素材，
# 提示 "person . face . cat ."）：
#   官方 800/1333 → 3.38 s/帧，峰值工作集 2790 MB，person conf 0.806
#   原样 360x640  → 0.94 s/帧，峰值工作集 1671 MB，person conf 0.820（坐标差 1~2 px）
# 快 3.6 倍、省 1.1 GB、分数还略高，所以默认不放大。
# 帧尺寸归 __main__ 的 --max-side 管，这里只负责别把它的决定推翻。
NATIVE_SIZE = None

# 模型加载一次要好几秒（读 690 MB safetensors + 建图），一个进程里可能连着跑
# 几十帧，所以按目录缓存。加锁是因为将来若有人从线程池里调，别把模型加载两遍
# 把内存顶到 2 倍。
_CACHE: Dict[str, Any] = {}
_LOCK = threading.Lock()


def models_dir() -> str:
    """和 promptcut_shots.__main__.models_dir() 同一套规则，逐字对齐。

    这里重写一遍而不是 import：dino.py 要能被单独 import 做单测，不该拖上
    命令行入口那一坨（argparse / subprocess / jsonl）。
    """
    models = os.environ.get("PROMPTCUT_MODELS")
    if models:
        return models
    data_dir = os.environ.get("PROMPTCUT_DATA_DIR")
    if data_dir:
        return os.path.join(data_dir, "models")
    return os.path.join(os.path.expanduser("~"), ".promptcut", "models")


def default_model_dir() -> str:
    return os.path.join(models_dir(), MODEL_DIRNAME)


def missing_files(path: Optional[str] = None) -> List[str]:
    """列出这个目录缺哪些必需文件。空列表 = 就绪。

    单独抽出来是为了让报错能说清「缺的是哪个」——status 只需要一个布尔值，但
    用户拿到「目录不完整」四个字是修不了的。
    """
    path = path or default_model_dir()
    if not os.path.isdir(path):
        return [f"整个目录不存在：{path}"]
    missing = [n for n in REQUIRED_FILES if not os.path.isfile(os.path.join(path, n))]
    if not any(os.path.isfile(os.path.join(path, n)) for n in TOKENIZER_FILES):
        missing.append(" 或 ".join(TOKENIZER_FILES))
    return missing


def model_ready(path: Optional[str] = None) -> bool:
    """必需文件一个不缺、且词表至少有一个，才算模型就绪。"""
    return not missing_files(path)


def _normalize_prompt(prompt: Optional[str]) -> str:
    """Grounding DINO 的提示要求：小写、名词短语之间用「 . 」分隔、结尾带句点。

    官方 demo 就是这么喂的，大写或缺结尾句点会让 BERT 那一半的分段对不齐，
    实测表现为分数整体偏低甚至一个框都不出。

    **提示必须是英文**：文本那一半是 bert-base-uncased，词表里没有中文。实测
    喂 "显示器 . 椅子 ." 会被切成 "[UNK] 示 [UNK] 子"，然后随便框住画面主体
    交差（conf 0.44），看着像成功其实全是噪声。同一张图喂
    "monitor . chair . glasses ." 则是 glasses 0.91 / monitor 0.43 / chair 0.37，
    位置都对。上层（MCP 工具、系统提示）必须把提示词翻成英文再传进来。
    """
    text = (prompt or DEFAULT_PROMPT).strip().lower()
    if not text:
        text = DEFAULT_PROMPT
    if not text.endswith("."):
        text += " ."
    return text


def prompt_terms(prompt: Optional[str]) -> List[str]:
    """把提示拆成名词短语列表，给标签兜底用。"""
    return [t.strip() for t in _normalize_prompt(prompt).split(".") if t.strip()]


def _load(model_dir: str):
    """加载 processor + model（只本地，绝不联网）。"""
    key = os.path.abspath(model_dir)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit

    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            return hit

        lacks = missing_files(key)
        if lacks:
            # 把缺的那几个逐个点名：用户要么重装拓展包、要么补文件，含糊的报错两条都指不出来
            raise RuntimeError(
                f"Grounding DINO 模型目录不完整：{key}，缺 {'、'.join(lacks)}"
            )

        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        # local_files_only=True：用户机器上可能根本没网，也不该在检测时偷偷联网。
        processor = AutoProcessor.from_pretrained(key, local_files_only=True)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(key, local_files_only=True)
        model.eval()
        model.to("cpu")

        # post_process 的阈值参数名在 transformers 里改过：4.51 之前叫
        # box_threshold，之后统一成 threshold。清单允许 >=4.40,<5，两种都可能装上，
        # 所以按签名探一次，别在用户机器上炸 TypeError。
        params = inspect.signature(processor.post_process_grounded_object_detection).parameters
        score_kw = "threshold" if "threshold" in params else "box_threshold"

        bundle = (processor, model, torch, score_kw)
        _CACHE[key] = bundle
        return bundle


def _clean_label(raw: Any, fallback: str) -> str:
    """post_process 给回来的标签可能带句点/空白，也可能（新版本里）是整数 id。"""
    if isinstance(raw, str):
        text = raw.replace(".", " ").strip()
        if text:
            return text
    return fallback


def _size_for(h: int, w: int, max_side: Optional[int]) -> Optional[Dict[str, int]]:
    """算预处理尺寸。返回 None 表示「不覆盖，用官方那套」。取值含义见 NATIVE_SIZE。"""
    if max_side is not None and max_side <= 0:
        return None
    long_side, short_side = max(h, w), min(h, w)
    if long_side <= 0 or short_side <= 0:
        return None
    if max_side is not None and long_side > max_side:
        scale = max_side / float(long_side)
        long_side = max_side
        short_side = max(1, int(round(short_side * scale)))
    return {"shortest_edge": short_side, "longest_edge": long_side}


def _preprocess(processor, rgb, text: str, h: int, w: int, max_side: Optional[int]):
    """跑图文预处理。size 走**单次调用**的参数，不改 processor 的全局状态——
    同一个 processor 实例是跨调用缓存的，改它等于给别人埋雷。

    老版本 transformers 的 __call__ 不一定认 size 这个 kwarg，认不出就退回默认
    尺寸（慢，但结果一样对）。
    """
    size = _size_for(h, w, max_side)
    if size is not None:
        try:
            return processor(images=rgb, text=text, return_tensors="pt", size=size)
        except (TypeError, ValueError):
            pass
    return processor(images=rgb, text=text, return_tensors="pt")


def detect(
    frames: List[np.ndarray],
    prompt: str = DEFAULT_PROMPT,
    box_threshold: float = 0.35,
    text_threshold: float = 0.25,
    model_path: Optional[str] = None,
    model_dir: Optional[str] = None,
    max_side: Optional[int] = NATIVE_SIZE,
) -> List[List[Dict[str, Any]]]:
    """对每一帧跑一次开放词汇检测。

    frames：BGR uint8 HxWx3 的列表（ffmpeg 抽出来的原始顺序就是 BGR）。
    prompt：**英文**名词短语，用「 . 」分隔，见 _normalize_prompt。
    model_path / model_dir：模型目录（两个名字是一回事）。DINO 的「模型」是一整个
              HF snapshot 目录，但 __main__ 对三个后端统一用 model_path= 传，
              所以这里两个都认，谁给了用谁。
    max_side：喂给模型的最长边，取值含义见 NATIVE_SIZE。
    返回：和 frames 等长，每项是该帧的框列表
          {"label": str, "x": int, "y": int, "w": int, "h": int, "conf": float}，
          坐标单位是**传入帧**的像素。
    """
    if not frames:
        return []

    text = _normalize_prompt(prompt)
    fallback = prompt_terms(text)[0] if prompt_terms(text) else "object"
    processor, model, torch, score_kw = _load(model_path or model_dir or default_model_dir())

    results: List[List[Dict[str, Any]]] = []
    # 一帧一跑，不做批处理：CPU 上批处理省不下多少时间（算力已经吃满），
    # 却会让激活值峰值按批大小翻倍——这台机器上单帧峰值已经 2 GB 出头。
    for frame in frames:
        arr = np.asarray(frame)
        if arr.ndim != 3 or arr.shape[2] != 3:
            raise ValueError(f"帧的形状必须是 HxWx3，收到 {arr.shape}")
        if arr.dtype != np.uint8:
            arr = np.clip(arr, 0, 255).astype(np.uint8)
        h, w = int(arr.shape[0]), int(arr.shape[1])

        # BGR → RGB：processor 按 PIL 的约定认 RGB，喂反了人脸/人体都会掉分。
        rgb = arr[:, :, ::-1]

        inputs = _preprocess(processor, rgb, text, h, w, max_side)
        with torch.no_grad():
            outputs = model(**inputs)

        post = processor.post_process_grounded_object_detection(
            outputs,
            inputs["input_ids"],
            target_sizes=[(h, w)],
            text_threshold=text_threshold,
            **{score_kw: box_threshold},
        )[0]

        labels = post.get("text_labels")
        if labels is None:
            labels = post.get("labels", [])

        boxes: List[Dict[str, Any]] = []
        for box, score, label in zip(post["boxes"], post["scores"], labels):
            x0, y0, x1, y1 = [float(v) for v in box.tolist()]
            # 夹回帧内：DETR 系的框允许越界一点点，越界的框传给上层算占位面积会失真
            x0 = max(0.0, min(x0, w))
            y0 = max(0.0, min(y0, h))
            x1 = max(0.0, min(x1, w))
            y1 = max(0.0, min(y1, h))
            bw, bh = x1 - x0, y1 - y0
            if bw < 1 or bh < 1:
                continue
            boxes.append({
                "label": _clean_label(label, fallback),
                "x": int(round(x0)),
                "y": int(round(y0)),
                "w": int(round(bw)),
                "h": int(round(bh)),
                "conf": round(float(score), 4),
            })

        # 分数从高到低，上层要「最主要的那个主体」时直接取第一个
        boxes.sort(key=lambda b: b["conf"], reverse=True)
        results.append(boxes)

    return results
