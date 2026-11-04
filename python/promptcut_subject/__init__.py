"""Subject detection: where the people are in the frame and which side is empty.

For the AI Agent to set up motion graphics cards: only by knowing the face and body boxes can a card be placed on the side that does not cover the face.

Two tiers:
  - light: YuNet (face, ONNX) + RT-DETR-R18 (body, ONNX), only needs onnxruntime;
  - full: everything in light + Grounding DINO tiny (open vocabulary), needs torch + transformers.

The models of both tiers ship with the "extension library package", not through pip.
"""

__version__ = "1.0.0"

# The video argument may be an http(s) address on the asset service: the Node side fetches the bytes through the asset service's API instead of passing a local path
# (docs/semantics/product/agent.md, "Media and outputs"). All decoding happens inside the ffmpeg / ffprobe subprocesses, which fetch by Range themselves.
# The Node side checks ACCEPTS_URL to see whether this package accepts addresses; when an old package lacks this marker, Node first streams the bytes into a temporary file and then passes the path.
ACCEPTS_URL = True


def is_media_url(value: str) -> bool:
    """An address on the asset service (http / https). Only these two protocols are recognized; anything else is treated as a local path."""
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))
