"""PromptCut motion tracking extension: BootsTAPIR any-point tracking."""

__version__ = "0.1.0"

# The video argument may be an http(s) address on the asset service: the Node side fetches the bytes through the asset service's API instead of passing a local path
# (docs/semantics/product/agent.md, "Media and outputs"). All decoding happens inside the ffmpeg / ffprobe subprocesses, which fetch by Range themselves.
# The Node side checks ACCEPTS_URL to see whether this package accepts addresses; when an old package lacks this marker, Node first streams the bytes into a temporary file and then passes the path.
ACCEPTS_URL = True


def is_media_url(value: str) -> bool:
    """An address on the asset service (http / https). Only these two protocols are recognized; anything else is treated as a local path."""
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))


def ffmpeg_input(video: str) -> list:
    """Input arguments for ffmpeg. For local files, prepend `-protocol_whitelist file`:

    Assets are uploaded by project members, and a playlist disguised as a video (m3u8, concat manifest) can contain arbitrary network addresses,
    without the whitelist ffmpeg will dutifully go and connect; on a cloud node that amounts to letting members use our process to reach the network.
    http(s) addresses on the asset service are passed in by ourselves, so they are not restricted.
    """
    if is_media_url(video):
        return ["-i", video]
    return ["-protocol_whitelist", "file", "-i", video]
