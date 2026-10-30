"""jsonl 输出格式：一行一个 JSON、中文不转义、每行 flush。"""

import io
import json
import sys
import unittest

from promptcut_stt import jsonl


class CaptureStdout:
    """把 sys.stdout 换成 StringIO，退出时还原。"""

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
            jsonl.emit({"text": "欢迎使用"})
        line = cap.text.strip()
        self.assertIn("欢迎使用", line)
        self.assertNotIn("\\u", line)
        self.assertEqual(json.loads(line)["text"], "欢迎使用")

    def test_emit_log_shape(self):
        with CaptureStdout() as cap:
            jsonl.emit_log("Collecting faster-whisper")
        obj = json.loads(cap.text.strip())
        self.assertEqual(obj["event"], "log")
        self.assertEqual(obj["line"], "Collecting faster-whisper")

    def test_emit_error_shape_and_extra_fields(self):
        with CaptureStdout() as cap:
            jsonl.emit_error("装不上", code=2)
        obj = json.loads(cap.text.strip())
        self.assertEqual(obj["event"], "error")
        self.assertEqual(obj["message"], "装不上")
        self.assertEqual(obj["code"], 2)

    def test_multiline_payload_stays_on_one_line(self):
        # 错误消息里常带 ffmpeg 的多行 stderr，序列化后必须仍是一行。
        with CaptureStdout() as cap:
            jsonl.emit_error("第一行\n第二行")
        self.assertEqual(len(cap.text.splitlines()), 1)
        self.assertEqual(json.loads(cap.text.strip())["message"], "第一行\n第二行")


if __name__ == "__main__":
    unittest.main()
