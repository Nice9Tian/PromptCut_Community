"""主体检测：画面里人在哪、哪一侧是空的。

给 AI Agent 配动效卡用 —— 知道人脸和人体的框，才能把卡片放到不遮脸的那一侧。

分两档：
  - light：YuNet（人脸，ONNX）+ RT-DETR-R18（人体，ONNX），只要 onnxruntime；
  - full：light 的全部 + Grounding DINO tiny（开放词汇），要 torch + transformers。

两档的模型都随「拓展库包」发，不走 pip。
"""

__version__ = "1.0.0"

# 视频参数可以是素材服务上的 http(s) 地址:Node 侧经素材服务的接口取字节,不再递本机路径
# (docs/semantics/product/agent.md「素材与产物」)。解码全在 ffmpeg / ffprobe 子进程里,它们自己按 Range 取。
# Node 侧按 ACCEPTS_URL 判断这份包认不认地址;老包没有这个标记时,Node 先把字节流到临时文件再递路径。
ACCEPTS_URL = True


def is_media_url(value: str) -> bool:
    """素材服务上的地址(http / https)。只认这两种协议,别的一律当本机路径看。"""
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))
