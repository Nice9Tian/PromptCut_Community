"""Full tier backend: Grounding DINO tiny (open-vocabulary detection).

IDEA-Research/grounding-dino-tiny (Apache-2.0, 172M parameters, fp32 weights about 690 MB),
Runs on HF transformers + PyTorch CPU. It accepts **any English noun phrase**: "person . face ."
and "red cup . laptop ." are the same code. This is something the light tier (YuNet + RT-DETR only recognize fixed
classes) cannot offer, and the only reason the full package carries an extra 658 MB of weights + 164 MB of dependencies.
(Chinese prompts do not work, the vocabulary has none; see _normalize_prompt.)

The only public function is detect(), its signature aligned with yunet.py / rtdetr.py (plus one extra prompt):
Frames in (BGR uint8 HxWx3), boxes out (coordinates are in pixels of the **passed-in frame**, not of the original video;
converting back to the original size is __main__'s job).
"""

from __future__ import annotations

import inspect
import os
import threading
from typing import Any, Dict, List, Optional

import numpy as np

# The model is a **directory** (HF snapshot), not a single file: config.json + model.safetensors
# + preprocessor_config.json + the tokenizer files. The extension pack copies the whole directory into models/.
MODEL_DIRNAME = "grounding-dino-tiny"

# The criterion for "is the model present" must match the **files from_pretrained actually reads**; err on the strict side:
# A loose criterion means status reports engine="full" while detect blows up inside transformers with an error
# that pinpoints nothing (an interrupted copy, antivirus blocking small files, or rsync moving only the large files all leave such a half directory).
#
# Measured (cuda_Vit / transformers 4.57.6, hard-linking the real weights directory into a temporary directory and deleting files one by one,
# then running AutoProcessor.from_pretrained(local_files_only=True)):
#   delete tokenizer.json or vocab.txt      → still loads (the other one covers for it)
#   delete both                             → TypeError: stat: path should be string,
#                                             bytes, os.PathLike or integer, not NoneType
#                                             (this is the error that gives "no clue at all what is missing")
#   delete tokenizer_config.json            → still loads, but tokenizer.model_max_length goes from 512
#                                             to the sentinel value 1000000000000000019884624838656,
#                                             so long prompts are no longer truncated to 512 and run all the way into the model's position embeddings
#   delete special_tokens_map.json          → still loads, behavior unchanged, so it is not listed as required
REQUIRED_FILES = ("config.json", "model.safetensors", "preprocessor_config.json",
                  "tokenizer_config.json")

# Tokenizer vocabulary: at least one of these two must exist (tokenizer.json is the all-in-one package of the fast version, vocab.txt is
# the slow version's vocabulary; transformers can build BertTokenizerFast from either one). Only when both are missing is something truly missing.
TOKENIZER_FILES = ("tokenizer.json", "vocab.txt")

DEFAULT_PROMPT = "person . face ."

# The three values of max_side (default None):
#   None → feed the frame at whatever size it has, neither enlarging nor shrinking;
#   >0   → shrink the longest side down to this value (leave it alone if the frame is already smaller);
#   0    → hand it back to the official preprocessing (shortest_edge=800 / longest_edge=1333).
#
# The default leaves the frame size alone because the official preprocessing would **scale back up** frames that __main__ has already shrunk to 640
# (360x640 → 750x1333), which is a pure waste of compute. Measured (20-thread CPU, real portrait 360x640 media,
# prompt "person . face . cat ."):
#   official 800/1333 → 3.38 s/frame, peak working set 2790 MB, person conf 0.806
#   as-is 360x640     → 0.94 s/frame, peak working set 1671 MB, person conf 0.820 (coordinates differ by 1~2 px)
# 3.6x faster, 1.1 GB saved, and the score is even slightly higher, so by default it does not enlarge.
# Frame size is governed by __main__'s --max-side; this module only makes sure not to override its decision.
NATIVE_SIZE = None

# Loading the model takes several seconds (reading 690 MB of safetensors + building the graph), and one process may run
# dozens of frames in a row, so it is cached per directory. The lock is there in case someone calls this from a thread pool later, so the model is not loaded twice and
# memory is not pushed up to 2x.
_CACHE: Dict[str, Any] = {}
_LOCK = threading.Lock()


def models_dir() -> str:
    """Same rules as promptcut_shots.__main__.models_dir(), aligned verbatim.

    Rewritten here instead of imported: dino.py must be importable on its own for unit tests and should not drag in
    the whole command-line entry blob (argparse / subprocess / jsonl).
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
    """List which required files this directory is missing. Empty list = ready.

    It is split out so that error messages can say "which one is missing": status only needs a boolean, but
    a user who only gets "directory incomplete" cannot fix anything.
    """
    path = path or default_model_dir()
    if not os.path.isdir(path):
        return [f"The whole directory does not exist: {path}"]
    missing = [n for n in REQUIRED_FILES if not os.path.isfile(os.path.join(path, n))]
    if not any(os.path.isfile(os.path.join(path, n)) for n in TOKENIZER_FILES):
        missing.append(" or ".join(TOKENIZER_FILES))
    return missing


def model_ready(path: Optional[str] = None) -> bool:
    """The model counts as ready only if no required file is missing and at least one vocabulary file exists."""
    return not missing_files(path)


def _normalize_prompt(prompt: Optional[str]) -> str:
    """Grounding DINO prompt requirements: lowercase, noun phrases separated by " . ", ending with a period.

    The official demo feeds it exactly like this; uppercase or a missing final period misaligns the segmentation on the BERT half,
    which in practice shows up as uniformly low scores or no box at all.

    **The prompt must be English**: the text half is bert-base-uncased, whose vocabulary has no Chinese. In practice,
    feeding the Chinese for "monitor . chair ." gets it split into "[UNK] <char> [UNK] <char>" (two stray single characters), and then it boxes the main subject of the frame at random to
    hand in something (conf 0.44), which looks like success but is all noise. Feeding the same image
    "monitor . chair . glasses ." gives glasses 0.91 / monitor 0.43 / chair 0.37,
    with all positions correct. The upper layer (MCP tool, system prompt) must translate the prompt into English before passing it in.
    """
    text = (prompt or DEFAULT_PROMPT).strip().lower()
    if not text:
        text = DEFAULT_PROMPT
    if not text.endswith("."):
        text += " ."
    return text


def prompt_terms(prompt: Optional[str]) -> List[str]:
    """Split the prompt into a list of noun phrases, used as a fallback for labels."""
    return [t.strip() for t in _normalize_prompt(prompt).split(".") if t.strip()]


def _load(model_dir: str):
    """Load processor + model (local only, never touches the network)."""
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
            # Name each missing file: the user either reinstalls the extension pack or adds the files, and a vague error points to neither
            raise RuntimeError(
                f"Grounding DINO model directory is incomplete: {key}, missing {', '.join(lacks)}"
            )

        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        # local_files_only=True: the user's machine may have no network at all, and detection should not quietly go online either.
        processor = AutoProcessor.from_pretrained(key, local_files_only=True)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(key, local_files_only=True)
        model.eval()
        model.to("cpu")

        # The threshold parameter name of post_process was changed in transformers: before 4.51 it was called
        # box_threshold, afterwards unified as threshold. The manifest allows >=4.40,<5, so either may get installed,
        # so probe the signature once instead of blowing up with a TypeError on the user's machine.
        params = inspect.signature(processor.post_process_grounded_object_detection).parameters
        score_kw = "threshold" if "threshold" in params else "box_threshold"

        bundle = (processor, model, torch, score_kw)
        _CACHE[key] = bundle
        return bundle


def _clean_label(raw: Any, fallback: str) -> str:
    """The labels returned by post_process may carry a period/whitespace, or (in newer versions) be an integer id."""
    if isinstance(raw, str):
        text = raw.replace(".", " ").strip()
        if text:
            return text
    return fallback


def _size_for(h: int, w: int, max_side: Optional[int]) -> Optional[Dict[str, int]]:
    """Compute the preprocessing size. Returns None to mean "do not override, use the official one". See NATIVE_SIZE for the meaning of the values."""
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
    """Run the image-text preprocessing. size is passed as a **per-call** argument and never changes the processor's global state:
    the same processor instance is cached across calls, and modifying it would set a trap for everyone else.

    The __call__ of older transformers versions may not accept the size kwarg; if it is not recognized, fall back to the default
    size (slower, but the result is just as correct).
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
    """Run open-vocabulary detection once on every frame.

    frames: a list of BGR uint8 HxWx3 arrays (the raw order ffmpeg extracts is BGR).
    prompt: **English** noun phrases separated by " . ", see _normalize_prompt.
    model_path / model_dir: the model directory (the two names mean the same thing). DINO's "model" is a whole
              HF snapshot directory, but __main__ passes model_path= uniformly to all three backends,
              so both are accepted here, and whichever is given is used.
    max_side: the longest side fed to the model, see NATIVE_SIZE for the meaning of the values.
    Returns: a list as long as frames, each item being that frame's list of boxes
          {"label": str, "x": int, "y": int, "w": int, "h": int, "conf": float},
          Coordinates are in pixels of the **passed-in frame**.
    """
    if not frames:
        return []

    text = _normalize_prompt(prompt)
    fallback = prompt_terms(text)[0] if prompt_terms(text) else "object"
    processor, model, torch, score_kw = _load(model_path or model_dir or default_model_dir())

    results: List[List[Dict[str, Any]]] = []
    # One frame per run, no batching: batching saves little time on CPU (compute is already saturated),
    # yet it would multiply the activation peak by the batch size; on this machine the single-frame peak is already a bit over 2 GB.
    for frame in frames:
        arr = np.asarray(frame)
        if arr.ndim != 3 or arr.shape[2] != 3:
            raise ValueError(f"Frame shape must be HxWx3, got {arr.shape}")
        if arr.dtype != np.uint8:
            arr = np.clip(arr, 0, 255).astype(np.uint8)
        h, w = int(arr.shape[0]), int(arr.shape[1])

        # BGR → RGB: the processor expects RGB following the PIL convention, and feeding the wrong order lowers scores for both faces and bodies.
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
            # Clamp back into the frame: DETR-family boxes may overshoot slightly, and passing an overshooting box up would distort the occupied-area computation
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

        # Sorted by score from high to low, so when the upper layer wants "the most important subject" it simply takes the first one
        boxes.sort(key=lambda b: b["conf"], reverse=True)
        results.append(boxes)

    return results
