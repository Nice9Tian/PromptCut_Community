"""Motion tracking command line: deployment parameters override environment variables, errors carry a code, and overly long videos are rejected outright (not truncated).

The Cloud Agent service launches this process through the workspace, and the workspace strips all PROMPTCUT_* environment variables,
so the paths outside the interpreter (dependencies, weights, ffmpeg, dependency manifest) are passed in via the global command-line switches.
This pins down two things: the global switches really override the environment variables; the rejection of an overly long video carries a code field,
from which the caller (Node) tells "video too long" apart from other failures.
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

FFMPEG = os.environ.get("PROMPTCUT_FFMPEG") or shutil.which("ffmpeg")


def run_main(argv):
    """Run main(argv) and return (exit code, [JSON events on stdout])."""
    from promptcut_track import __main__ as cli

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = cli.main(argv)
    events = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip().startswith("{")]
    return code, events


class OverrideTest(unittest.TestCase):
    def test_global_switch_overrides_environment_variables(self):
        from promptcut_track import __main__ as cli

        saved = {k: os.environ.get(k) for k in ("PROMPTCUT_MODELS", "PROMPTCUT_PYLIBS")}
        os.environ["PROMPTCUT_MODELS"] = "/from/env/models"
        os.environ["PROMPTCUT_PYLIBS"] = "/from/env/libs"
        try:
            code, events = run_main(["--models", "/from/flag/models", "--pylibs", "/from/flag/libs", "status"])
            self.assertEqual(code, 0)
            status = events[0]
            self.assertEqual(status["event"], "status")
            self.assertTrue(status["model"]["path"].replace("\\", "/").startswith("/from/flag/models"))
            # The global switch takes effect only within this one call and is not left in the module to affect the next one
            code, events = run_main(["status"])
            self.assertTrue(events[0]["model"]["path"].replace("\\", "/").startswith("/from/env/models"))
            self.assertEqual(cli.env_paths()["pylibs"], "/from/env/libs")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


@unittest.skipIf(not FFMPEG, "ffmpeg is not available")
class TrackErrorCodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="pc-track-cli-")
        cls.video = os.path.join(cls.tmp, "five.mp4")
        subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", "testsrc=size=160x120:rate=10", "-t", "5", "-pix_fmt", "yuv420p", cls.video],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_exceeding_the_limit_is_rejected_with_code(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", self.video,
                                 "--points", "[[0,40,40]]", "--max-frames", "20"])
        self.assertEqual(code, 2)
        err = events[-1]
        self.assertEqual(err["event"], "error")
        self.assertEqual(err["code"], "too-long")
        self.assertEqual(err["limit"], 20)
        # 5 seconds × 10 fps = 50 frames; the estimate may be off by a frame or two (container duration is rounded)
        self.assertTrue(48 <= err["frames"] <= 52, err)
        # The rejection happens before decoding: there are no progress events
        self.assertFalse([e for e in events if e["event"] == "progress"])

    def test_tracks_normally_within_the_limit(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", self.video,
                                 "--points", "[[0,80,60]]", "--engine", "template", "--max-frames", "500"])
        self.assertEqual(code, 0)
        result = events[-1]
        self.assertEqual(result["event"], "result")
        self.assertEqual(result["engine"], "template")
        self.assertEqual(result["frames"], len(result["points"][0]["xy"]))

    def test_bad_points_carry_code(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", self.video, "--points", "[[0,1]]"])
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["code"], "bad-points")

    def test_video_not_found_carries_code(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", os.path.join(self.tmp, "nope.mp4"),
                                 "--points", "[[0,1,1]]"])
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["code"], "video-missing")


class FfmpegInputTest(unittest.TestCase):
    def test_local_files_get_protocol_allowlist_asset_service_urls_do_not(self):
        from promptcut_track import ffmpeg_input

        self.assertEqual(ffmpeg_input("/work/a.mp4"), ["-protocol_whitelist", "file", "-i", "/work/a.mp4"])
        self.assertEqual(ffmpeg_input("http://127.0.0.1:1/a"), ["-i", "http://127.0.0.1:1/a"])

    @unittest.skipIf(not FFMPEG, "ffmpeg is not available")
    def test_playlist_disguised_as_video_cannot_reach_the_network(self):
        """Regression guard: put a local http address in a concat manifest, and ffmpeg does not connect to it.
        (Newer ffmpeg also blocks local manifests by default; `-protocol_whitelist file` is a version-independent fallback, which the argument test above pins down.)"""
        import socket
        from promptcut_track.tracker import estimate_frames

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(0.5)
        port = listener.getsockname()[1]
        tmp = tempfile.mkdtemp(prefix="pc-track-playlist-")
        try:
            playlist = os.path.join(tmp, "fake.ffconcat")
            with open(playlist, "w", encoding="utf-8") as fh:
                fh.write(f"ffconcat version 1.0\nfile 'http://127.0.0.1:{port}/x.mp4'\n")
            estimate_frames(FFMPEG, playlist)
            try:
                conn, _ = listener.accept()
                conn.close()
                connected = True
            except socket.timeout:
                connected = False
            self.assertFalse(connected, "ffmpeg must not connect to a network address in the playlist")
        finally:
            listener.close()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
