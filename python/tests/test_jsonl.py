"""jsonl output format: one JSON per line, Chinese text not escaped, flush on every line."""

import io
import json
import sys
import unittest

from promptcut_stt import jsonl


class CaptureStdout:
    """Replace sys.stdout with a StringIO and restore it on exit."""

    def __enter__(self):
        self._saved = sys.stdout
        self.buffer = io.StringIO()
        sys.stdout = self.buffer
        return self

    def __exit__(self, *_exc):
        sys.stdout = self._saved
        return False

    @property
    def text(self):
        return self.buffer.getvalue()


class TestJsonl(unittest.TestCase):
    def test_emit_writes_exactly_one_line(self):
        with CaptureStdout() as cap:
            jsonl.emit({"a": 1})
            jsonl.emit({"b": 2})
        lines = cap.text.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0]), {"a": 1})
        self.assertEqual(json.loads(lines[1]), {"b": 2})
        self.assertTrue(cap.text.endswith("\n"))

    def test_chinese_is_not_escaped(self):
        with CaptureStdout() as cap:
            jsonl.emit({"text": "Welcome"})
        line = cap.text.strip()
        self.assertIn("Welcome", line)
        self.assertNotIn("\\u", line)
        self.assertEqual(json.loads(line)["text"], "Welcome")

    def test_emit_log_shape(self):
        with CaptureStdout() as cap:
            jsonl.emit_log("Collecting faster-whisper")
        obj = json.loads(cap.text.strip())
        self.assertEqual(obj["event"], "log")
        self.assertEqual(obj["line"], "Collecting faster-whisper")

    def test_emit_error_shape_and_extra_fields(self):
        with CaptureStdout() as cap:
            jsonl.emit_error("Cannot install", code=2)
        obj = json.loads(cap.text.strip())
        self.assertEqual(obj["event"], "error")
        self.assertEqual(obj["message"], "Cannot install")
        self.assertEqual(obj["code"], 2)

    def test_multiline_payload_stays_on_one_line(self):
        # Error messages often carry ffmpeg's multi-line stderr; after serialization it must still be one line.
        with CaptureStdout() as cap:
            jsonl.emit_error("First line\nSecond line")
        self.assertEqual(len(cap.text.splitlines()), 1)
        self.assertEqual(json.loads(cap.text.strip())["message"], "First line\nSecond line")


if __name__ == "__main__":
    unittest.main()
