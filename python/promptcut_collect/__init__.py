"""Media collection: fetch videos from web links as local files, for the editor to import.

Underneath is yt-dlp (Unlicense), pip-installed into PROMPTCUT_PYLIBS on demand; the package itself depends only on the standard library.
Site differences (request headers, link normalization, multi-part handling, quality cap) are kept in presets/,
bilibili is the first preset, and the one agents most often call directly.
"""

__version__ = "0.1.0"
