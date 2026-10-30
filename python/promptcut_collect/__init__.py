"""素材收集：从网页链接把视频抓成本地文件，供编辑台导入。

底层是 yt-dlp（Unlicense），按需 pip 装到 PROMPTCUT_PYLIBS；本包本体只依赖标准库。
站点差异（请求头、链接归一化、分 P、清晰度上限）收在 presets/ 里，
bilibili 是第一个预设，也是 agent 最常拿来直接调的那个。
"""

__version__ = "0.1.0"
