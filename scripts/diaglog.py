#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PromptCut 对话诊断报告的拆读工具。

诊断报告(「PromptCut conversation debug v2」,src/ai/debug.ts 的 conversationReport 生成)是一整个
JSON。长对话动辄一两 MB、三万多行:一条回复的 parts / tools / trace 就能占几十万字符,直接 Read
只看得见开头那段环境快照,真正出事的后半段根本翻不到。这里把它拆成能一口一口读的形状:

  - 命令行:概览、异常、按页读、按条读、搜索、整份拆成小文件
  - Python 对象:load() 返回 Report,agent 在脚本里逐页、逐条取

只用标准库,Python 3.9+。Windows 上用 `py -3`(Git Bash 里的 python 是应用商店占位)。

命令行(报告路径放在子命令前面;路径也可以是报告所在的文件夹):

  py -3 scripts/diaglog.py <报告> overview            每条消息一行:角色、模型、结果、耗时、工具数/失败数、花费
  py -3 scripts/diaglog.py <报告> anomalies           报错、失败工具(按原因归类)、兜底重试、长时间没有事件
  py -3 scripts/diaglog.py <报告> pages [--size N]    分页目录:每页覆盖哪几条消息
  py -3 scripts/diaglog.py <报告> page 3 [--size N]   读第 3 页(默认每页 12000 字符)
  py -3 scripts/diaglog.py <报告> show 15 [--part summary|text|timeline|tools|trace|meta] [--page N]
  py -3 scripts/diaglog.py <报告> find ENAMETOOLONG [-i] [--limit 50]
  py -3 scripts/diaglog.py <报告> env [key]           环境快照(不带 key 只列有哪些段)
  py -3 scripts/diaglog.py <报告> split [-o 目录]      拆成小文件,默认拆到报告旁边的「<报告名>.split」

Python:

  import sys; sys.path.insert(0, r"C:\\Users\\admin\\Documents\\PromptCut\\scripts")
  from diaglog import load
  r = load(r"...\\对话诊断-xxx.txt")
  print(r.overview())
  print(r.page_count(), r.page(1))          # 逐页读,页码从 1 开始
  m = r[15]                                 # 第 15 条消息(和报告里 messages 的下标一致,支持负数)
  m.error, m.failed_tools, m.tool_counts
  print(m.timeline()); print(m.trace_text())
  for h in r.find("spawn"): print(h)       # 每条命中带所在页码,接着 r.page(h.page) 读上下文
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

PAGE_SIZE = 12000
INPUT_PREVIEW = 240
SPLIT_MARKER = ".diaglog-split"

# 工具失败按原因归类。「权限被拒」专指 Claude Code / agy 自带工具在无人值守下被拦 ——
# 这类失败和工具本身坏没坏无关,排查时要和真正的报错分开看。
DENIED = re.compile(
    r"requested permissions|requires approval|haven't granted|permission denied|"
    r"This Bash command contains|Contains simple_expansion|Command contains|拒绝了", re.I)
TIMEOUT = re.compile(r"超过\s*\d+\s*秒没有返回|timed? ?out|超时", re.I)
NOTABLE_STATUS = re.compile(r"重试|失败|被拒|中断|超过|截断|error", re.I)


# ───────────────────────── 小工具 ─────────────────────────

def _ts(v: Any) -> Optional[datetime]:
    """毫秒时间戳或 ISO 串 → UTC datetime"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000, tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def _hms(dt: Optional[datetime]) -> str:
    return dt.strftime("%H:%M:%S") if dt else "--:--:--"


def _dur(sec: Optional[float]) -> str:
    if sec is None:
        return "-"
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600}h{sec % 3600 // 60:02d}m"
    return f"{sec // 60}m{sec % 60:02d}s"


def _str(v: Any) -> str:
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def _clip(v: Any, n: int) -> str:
    s = _str(v).replace("\r", "")
    return s if len(s) <= n else s[:n] + f"…(+{len(s) - n})"


def _one_line(v: Any, n: int) -> str:
    return _clip(v, n).replace("\n", " ⏎ ")


def classify_failure(tool: dict) -> str:
    text = _str(tool.get("summary") or "")
    if DENIED.search(text):
        return "权限被拒"
    if TIMEOUT.search(text):
        return "超时"
    return "报错"


def _promptcut_tool_names() -> set:
    """从仓库里的 server/mcp-tools.mjs 读 PromptCut 工具名;脚本被单独拷走时读不到,就只认 mcp__ 前缀"""
    src = Path(__file__).resolve().parent.parent / "server" / "mcp-tools.mjs"
    try:
        return set(re.findall(r"^\s*name:\s*[\"'](\w+)[\"']", src.read_text(encoding="utf-8"), re.M))
    except OSError:
        return set()


PROMPTCUT_TOOLS = _promptcut_tool_names()


def tool_origin(name: str) -> str:
    """PromptCut 自己的工具,还是 CLI 自带的(Read / Bash / Skill / agy 的 grep_search …)。
    claude 那条路带 mcp__promptcut__ 前缀,agy 那条路是裸名字,所以两种都要认。"""
    n = name or ""
    return "PromptCut" if n.startswith("mcp__") or n in PROMPTCUT_TOOLS else "自带"


def paginate(text: str, size: int = PAGE_SIZE) -> list[str]:
    """按行切页,单行超长就硬切。给 show 这种单条就很大的输出用。"""
    pages, cur, cur_len = [], [], 0
    for line in text.splitlines():
        pieces = [line[k:k + size] for k in range(0, len(line), size)] or [""]
        for piece in pieces:
            if cur and cur_len + len(piece) + 1 > size:
                pages.append("\n".join(cur))
                cur, cur_len = [], 0
            cur.append(piece)
            cur_len += len(piece) + 1
    if cur:
        pages.append("\n".join(cur))
    return pages or [""]


# ───────────────────────── 一条消息 ─────────────────────────

class Message:
    """报告里 messages[] 的一条。raw 是原始 dict,常用字段做成属性。"""

    def __init__(self, index: int, raw: dict):
        self.index = index
        self.raw = raw

    def __repr__(self) -> str:
        return (f"<Message #{self.index} {self.role} {self.model} {self.outcome or ''} "
                f"tools={len(self.tools)} failed={len(self.failed_tools)}>")

    # 基本字段
    @property
    def role(self) -> str: return self.raw.get("role", "?")
    @property
    def text(self) -> str: return self.raw.get("text") or ""
    @property
    def outcome(self) -> Optional[str]: return self.raw.get("outcome")
    @property
    def runtime(self) -> dict: return self.raw.get("runtime") or {}
    @property
    def usage(self) -> dict: return self.raw.get("usage") or {}
    @property
    def parts(self) -> list: return self.raw.get("parts") or []
    @property
    def tools(self) -> list: return self.raw.get("tools") or []
    @property
    def trace(self) -> list: return self.raw.get("trace") or []
    @property
    def statuses(self) -> list: return self.raw.get("statuses") or []
    @property
    def attachments(self) -> list: return self.raw.get("attachments") or []

    @property
    def error(self) -> Optional[str]:
        e = self.raw.get("error")
        return None if e is None else _str(e)

    @property
    def model(self) -> str:
        return "/".join(str(x) for x in (self.runtime.get("provider"), self.runtime.get("model")) if x)

    @property
    def cost(self) -> Optional[float]: return self.usage.get("total_cost_usd")
    @property
    def started(self) -> Optional[datetime]: return _ts(self.raw.get("startedAt"))
    @property
    def finished(self) -> Optional[datetime]: return _ts(self.raw.get("finishedAt"))

    @property
    def duration(self) -> Optional[float]:
        if self.started and self.finished:
            return (self.finished - self.started).total_seconds()
        return None

    @property
    def failed_tools(self) -> list[tuple[int, dict, str]]:
        """[(在 tools 里的下标, 工具记录, 原因)],原因是 权限被拒 / 超时 / 报错"""
        return [(i, t, classify_failure(t)) for i, t in enumerate(self.tools) if t.get("ok") is False]

    @property
    def tool_counts(self) -> Counter:
        return Counter(t.get("name", "?") for t in self.tools)

    def meta(self) -> dict:
        """去掉大数组之后的元信息,外加各数组的条数"""
        m = {k: v for k, v in self.raw.items() if k not in ("parts", "tools", "trace", "text")}
        m["_counts"] = {"text_chars": len(self.text), "parts": len(self.parts), "tools": len(self.tools),
                        "failed_tools": len(self.failed_tools), "trace": len(self.trace)}
        return m

    # 渲染
    def header(self) -> str:
        bits = [f"#{self.index} {self.role}"]
        if self.model:
            bits.append(self.model)
        if self.outcome:
            bits.append(self.outcome)
        if self.started:
            bits.append(f"{_hms(self.started)}→{_hms(self.finished)} UTC ({_dur(self.duration)})")
        if self.tools:
            bits.append(f"工具 {len(self.tools)}(失败 {len(self.failed_tools)})")
        if self.cost is not None:
            bits.append(f"${self.cost:.2f}")
        return "## " + " · ".join(bits)

    def timeline(self, input_chars: int = INPUT_PREVIEW) -> str:
        """按发生顺序:状态(连续重复的折成 ×N)、中途说的话、每次工具调用和结果"""
        out: list[str] = []
        tool_no = 0
        last_status, repeat = None, 0

        def flush() -> None:
            nonlocal repeat
            if repeat > 1:
                out[-1] += f"  ×{repeat}"
            repeat = 0

        src = self.parts or [{"kind": "tool", **t} for t in self.tools]
        for p in src:
            kind = p.get("kind") or p.get("type")
            if kind == "status":
                txt = p.get("text", "")
                if txt == last_status:
                    repeat += 1
                    continue
                flush()
                out.append(f"  · 状态: {txt}")
                last_status, repeat = txt, 1
                continue
            flush()
            last_status = None
            if kind == "tool":
                tool_no += 1
                ok = p.get("ok")
                mark = "✓" if ok else ("✗" if ok is False else "…")
                line = f"  ▶ [{tool_no}] {p.get('name', '?')} {mark} {_one_line(p.get('input', ''), input_chars)}"
                if ok is False:
                    line += f"  〔{classify_failure(p)}〕"
                out.append(line)
                if p.get("summary"):
                    out.append(f"      → {_one_line(p['summary'], input_chars)}")
            elif kind == "text":
                t = (p.get("text") or "").strip()
                if t:
                    out.extend("  │ " + ln for ln in t.splitlines())
            elif kind == "thinking":
                t = (p.get("text") or "").strip()
                if t:
                    out.append(f"  (思考) {_one_line(t, input_chars)}")
            else:
                out.append(f"  ? {kind}: {_one_line(p, input_chars)}")
        flush()
        return "\n".join(out)

    def trace_text(self, gap: float = 60, chars: int = INPUT_PREVIEW) -> str:
        """执行事件逐条带时间;连续的 thinking 折成一行;两条事件之间隔了 gap 秒以上就标一行「静默」"""
        out: list[str] = []
        prev: Optional[datetime] = None
        think_n, think_c, think_at = 0, 0, None

        def flush_think() -> None:
            nonlocal think_n, think_c
            if think_n:
                out.append(f"{_hms(think_at)}  thinking    ×{think_n}(共 {think_c} 字)")
            think_n, think_c = 0, 0

        for e in self.trace:
            at = _ts(e.get("at"))
            ev = e.get("event") or {}
            if prev and at and (at - prev).total_seconds() >= gap:
                flush_think()
                out.append(f"          … 静默 {_dur((at - prev).total_seconds())}")
            prev = at or prev
            t = ev.get("type", "?")
            if t == "thinking":
                if not think_n:
                    think_at = at
                think_n += 1
                think_c += len(ev.get("delta") or "")
                continue
            flush_think()
            if t == "text":
                s = _one_line(ev.get("delta", ""), chars)
            elif t == "tool_call":
                s = f"{ev.get('name')} {_one_line(ev.get('input', ''), chars)}"
            elif t == "tool_result":
                s = f"{ev.get('name')} {'✓' if ev.get('ok') else '✗'} {_one_line(ev.get('summary', ''), chars)}"
            else:
                s = _one_line({k: v for k, v in ev.items() if k != "type"}, chars)
            out.append(f"{_hms(at)}  {t:<11} {s}")
        flush_think()
        if self.raw.get("traceTruncated"):
            out.append("(trace 在记录时就被截断了:超过 2000 条或 1.5MB)")
        return "\n".join(out)

    def trace_gaps(self, gap: float = 120) -> list[tuple[datetime, float, str]]:
        """[(静默开始时间, 秒数, 静默前最后一条事件)],按时长从长到短"""
        res, prev, prev_desc = [], None, ""
        for e in self.trace:
            at = _ts(e.get("at"))
            ev = e.get("event") or {}
            if prev and at and (at - prev).total_seconds() >= gap:
                res.append((prev, (at - prev).total_seconds(), prev_desc))
            if ev.get("type") != "thinking":
                prev_desc = f"{ev.get('type')} {ev.get('name') or ''}".strip()
            prev = at or prev
        return sorted(res, key=lambda x: -x[1])

    def render(self, input_chars: int = INPUT_PREVIEW) -> str:
        """分页文档里的一段:标题、附件、内容、时间线、错误"""
        lines = [self.header()]
        if self.attachments:
            lines.append(f"附件: {_one_line(self.attachments, 400)}")
        text_parts = "".join(p.get("text") or "" for p in self.parts if p.get("kind") == "text")
        timeline = self.timeline(input_chars) if (self.parts or self.tools) else ""
        # parts 里的 text 就是这条回复说过的话;对不上(旧格式或只有最终回复)才单独补一段
        if self.text.strip() and self.text.strip()[:200] not in text_parts:
            lines += ["【回复正文】" if self.role == "assistant" else "【内容】", self.text.rstrip()]
        if timeline:
            lines += ["【过程】", timeline]
        if self.error:
            lines.append(f"!! 错误: {self.error}")
        return "\n".join(lines) + "\n"


# ───────────────────────── 分页与搜索结果 ─────────────────────────

@dataclass
class Page:
    no: int
    total: int
    lines: list[tuple[str, Optional[int]]] = field(default_factory=list)  # (文本, 属于哪条消息)

    @property
    def text(self) -> str:
        return "\n".join(t for t, _ in self.lines)

    @property
    def msgs(self) -> list[int]:
        return sorted({o for _, o in self.lines if o is not None})

    def span(self) -> str:
        m = self.msgs
        if not m:
            return "概览"
        return f"消息 #{m[0]}" if m[0] == m[-1] else f"消息 #{m[0]}–#{m[-1]}"


@dataclass
class Hit:
    msg: Optional[int]      # None = 环境快照
    where: str              # text / error / tool[3] Bash / trace[120] status / environment …
    snippet: str
    page: int
    count: int              # 这一处一共命中几次

    def __str__(self) -> str:
        who = "环境" if self.msg is None else f"#{self.msg}"
        more = f" (本处共 {self.count} 次)" if self.count > 1 else ""
        return f"[p{self.page}] {who} {self.where}{more}: …{self.snippet}…"


# ───────────────────────── 整份报告 ─────────────────────────

class Report:
    def __init__(self, path: Path, data: dict):
        self.path = Path(path)
        self.data = data
        self.messages = [Message(i, m) for i, m in enumerate(data.get("messages") or [])]
        self._doc: Optional[list[tuple[str, Optional[int]]]] = None
        self._pages: dict[int, list[Page]] = {}

    def __repr__(self) -> str:
        return f"<Report {self.path.name} {len(self.messages)} messages>"

    def __len__(self) -> int:
        return len(self.messages)

    def __getitem__(self, i: int) -> Message:
        return self.messages[i]

    @property
    def format(self) -> str: return self.data.get("format", "?")
    @property
    def exported_at(self) -> str: return self.data.get("exportedAt", "?")
    @property
    def provider(self) -> Optional[str]: return self.data.get("provider")
    @property
    def runtime(self) -> dict: return self.data.get("runtime") or {}
    @property
    def environment(self) -> Any: return self.data.get("environment")

    # 概览
    def overview(self) -> str:
        size = self.path.stat().st_size / 1e6 if self.path.exists() else 0
        lines = [f"# {self.path.name}",
                 f"格式 {self.format} · 导出 {self.exported_at} · {len(self.messages)} 条消息 · {size:.1f} MB"]
        if self.runtime.get("summary"):
            lines.append(f"配置: {self.runtime['summary']}")
            for r in self.runtime.get("used") or []:
                lines.append(f"  - {r.get('说明') or _one_line(r, 200)}")
        env = self.environment if isinstance(self.environment, dict) else {}
        proj = env.get("project") or {}
        if proj.get("name"):
            lines.append(f"项目: {proj['name']} · {proj.get('clipCount', '?')} 个片段 · "
                         f"{(env.get('media') or {}).get('count', '?')} 个素材")
        lines += ["", "| # | 角色 | 模型 | 结果 | 开始(UTC) | 耗时 | 工具(败) | 花费 | 内容 / 错误 |",
                  "|---|---|---|---|---|---|---|---|---|"]
        total = 0.0
        for m in self.messages:
            total += m.cost or 0
            content = ("!! " + m.error) if m.error else m.text
            cells = [f"{m.index}", m.role, m.model or "", m.outcome or "", _hms(m.started) if m.started else "",
                     _dur(m.duration) if m.duration is not None else "",
                     f"{len(m.tools)}({len(m.failed_tools)})" if m.tools else "",
                     f"${m.cost:.2f}" if m.cost is not None else "",
                     _one_line(content, 70).replace("|", "\\|")]
            lines.append("| " + " | ".join(cells) + " |")
        if total:
            lines.append(f"\n记录到的花费合计 ${total:.2f}(只有正常结束的回复才带 usage)")
        return "\n".join(lines)

    # 异常
    def anomalies(self) -> list[dict]:
        items: list[dict] = []
        for m in self.messages:
            if m.error:
                items.append({"msg": m.index, "kind": "消息报错", "detail": m.error})
            groups: dict[tuple[str, str], Counter] = {}
            for _, t, reason in m.failed_tools:
                name = t.get("name", "?")
                groups.setdefault((reason, tool_origin(name)), Counter())[name] += 1
            for (reason, origin), names in groups.items():
                items.append({"msg": m.index, "kind": f"工具{reason}({origin})",
                              "detail": f"{sum(names.values())} 次: " + ", ".join(f"{k}×{v}" for k, v in names.items())})
            for s in dict.fromkeys(s for s in m.statuses if NOTABLE_STATUS.search(s)):
                items.append({"msg": m.index, "kind": "状态", "detail": s})
            if m.raw.get("traceTruncated"):
                items.append({"msg": m.index, "kind": "trace 截断", "detail": f"{len(m.trace)} 条 / {m.raw.get('traceBytes')} 字节"})
            for start, sec, before in m.trace_gaps()[:3]:
                items.append({"msg": m.index, "kind": "长时间没有事件",
                              "detail": f"{_hms(start)} 起 {_dur(sec)},之前最后一条是 {before}"})
        return items

    def anomalies_text(self) -> str:
        items = self.anomalies()
        if not items:
            return "没发现异常。"
        lines, cur = [], None
        for it in items:
            if it["msg"] != cur:
                cur = it["msg"]
                lines.append(f"\n{self.messages[cur].header()}")
            lines.append(f"  - [{it['kind']}] {it['detail']}")
        # 出错的回复和正常完成的回复各自有没有「自带工具被拒」—— 兜底重试就是被这个触发的
        lines.append("\n回复结果 × 自带工具被拒次数:")
        for m in self.messages:
            if m.role != "assistant" or not m.tools:
                continue
            denied = sum(1 for _, t, r in m.failed_tools if r == "权限被拒" and tool_origin(t.get("name", "")) == "自带")
            lines.append(f"  #{m.index:<3} {m.outcome or '?':<10} 被拒 {denied}")
        return "\n".join(lines).lstrip("\n")

    # 分页
    def _document(self) -> list[tuple[str, Optional[int]]]:
        if self._doc is None:
            doc: list[tuple[str, Optional[int]]] = [(ln, None) for ln in self.overview().splitlines()] + [("", None)]
            for m in self.messages:
                doc += [(ln, m.index) for ln in m.render().splitlines()] + [("", m.index)]
            self._doc = doc
        return self._doc

    def pages(self, size: int = PAGE_SIZE) -> list[Page]:
        if size in self._pages:
            return self._pages[size]
        pages: list[Page] = []
        cur: list[tuple[str, Optional[int]]] = []
        cur_len = 0
        for text, owner in self._document():
            pieces = [text[k:k + size] for k in range(0, len(text), size)] or [""]
            for piece in pieces:
                # 页满了就翻页;页已过六成又碰上一条新消息的标题,也提前翻,让一条消息尽量从页首开始
                if cur and (cur_len + len(piece) + 1 > size or (piece.startswith("## #") and cur_len > size * 0.6)):
                    pages.append(Page(len(pages) + 1, 0, cur))
                    cur, cur_len = [], 0
                cur.append((piece, owner))
                cur_len += len(piece) + 1
        if cur:
            pages.append(Page(len(pages) + 1, 0, cur))
        for p in pages:
            p.total = len(pages)
        self._pages[size] = pages
        return pages

    def page_count(self, size: int = PAGE_SIZE) -> int:
        return len(self.pages(size))

    def page(self, n: int, size: int = PAGE_SIZE) -> str:
        pages = self.pages(size)
        if not 1 <= n <= len(pages):
            raise IndexError(f"页码 {n} 超出范围,一共 {len(pages)} 页")
        p = pages[n - 1]
        tail = f"(下一页: page {n + 1})" if n < len(pages) else "(最后一页)"
        return f"=== 第 {n}/{len(pages)} 页 · {p.span()} ===\n{p.text}\n=== {tail} ==="

    def page_index(self, size: int = PAGE_SIZE) -> str:
        lines = []
        for p in self.pages(size):
            heads = [t for t, _ in p.lines if t.startswith("## #")]
            first = heads[0][3:] if heads else f"(接上页 #{p.msgs[0]})" if p.msgs else "概览"
            lines.append(f"p{p.no:<4} {p.span():<14} {len(p.text):>6} 字  {_one_line(first, 90)}")
        return "\n".join(lines)

    def pages_of(self, msg: int, size: int = PAGE_SIZE) -> list[int]:
        return [p.no for p in self.pages(size) if msg in p.msgs]

    # 搜索
    def find(self, pattern: str, ignore_case: bool = False, limit: int = 50, size: int = PAGE_SIZE) -> list[Hit]:
        """在原始字段里搜(工具参数不截断),每处给第一个命中的上下文和所在页码"""
        rx = re.compile(pattern, re.I if ignore_case else 0)
        pages = self.pages(size)
        hits: list[Hit] = []

        def page_for(msg: Optional[int]) -> int:
            cands = [p for p in pages if (msg in p.msgs if msg is not None else not p.msgs)]
            for p in cands:
                if rx.search(p.text):
                    return p.no
            return cands[0].no if cands else 1

        def add(msg: Optional[int], where: str, value: Any) -> bool:
            s = _str(value)
            found = list(rx.finditer(s))
            if found:
                a, b = max(0, found[0].start() - 80), min(len(s), found[0].end() + 80)
                hits.append(Hit(msg, where, s[a:b].replace("\n", " ⏎ "), page_for(msg), len(found)))
            return len(hits) >= limit

        if self.environment is not None and add(None, "environment", self.environment):
            return hits
        for m in self.messages:
            fields: list[tuple[str, Any]] = [("text", m.text), ("error", m.error or ""), ("attachments", m.attachments)]
            fields += [(f"tool[{i}] {t.get('name')}", t) for i, t in enumerate(m.tools)]
            fields += [(f"status[{i}]", s) for i, s in enumerate(m.statuses)]
            # trace 里的工具事件和 tools 重复,thinking 是空的,只搜其余几类
            fields += [(f"trace[{i}] {e.get('event', {}).get('type')}", e.get("event"))
                       for i, e in enumerate(m.trace)
                       if (e.get("event") or {}).get("type") not in ("thinking", "tool_call", "tool_result")]
            for where, v in fields:
                if v and add(m.index, where, v):
                    return hits
        return hits

    # 拆成小文件
    def split(self, out: Optional[Path | str] = None, size: int = PAGE_SIZE) -> Path:
        out = Path(out) if out else self.path.with_name(self.path.stem + ".split")
        if out.exists() and any(out.iterdir()):
            if not (out / SPLIT_MARKER).exists():
                raise FileExistsError(f"{out} 已存在且不是本工具拆出来的,不覆盖")
            shutil.rmtree(out)
        out.mkdir(parents=True, exist_ok=True)

        def w(p: Path, s: str) -> None:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(s, encoding="utf-8")

        def wj(p: Path, o: Any) -> None:
            w(p, json.dumps(o, ensure_ascii=False, indent=2))

        w(out / SPLIT_MARKER, f"{self.path}\n")
        wj(out / "meta.json", {k: v for k, v in self.data.items() if k not in ("messages", "environment")})
        env = self.environment
        if isinstance(env, dict):
            for k, v in env.items():
                safe = re.sub(r'[\\/:*?"<>|]', "_", k)   # 3.12 以前 f-string 表达式里不能有反斜杠
                wj(out / "environment" / f"{safe}.json", v)
        elif env is not None:
            wj(out / "environment.json", env)

        for m in self.messages:
            d = out / "messages" / f"{m.index:02d}-{m.role}"
            wj(d / "meta.json", m.meta())
            if m.text:
                w(d / "text.md", m.text)
            if m.parts or m.tools:
                w(d / "timeline.md", m.header() + "\n\n" + m.timeline(input_chars=2000) + "\n")
            if m.tools:
                w(d / "tools.jsonl", "".join(json.dumps(t, ensure_ascii=False) + "\n" for t in m.tools))
            if m.trace:
                w(d / "trace.md", m.trace_text() + "\n")
                w(d / "trace.jsonl", "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in m.trace))

        for p in self.pages(size):
            w(out / "pages" / f"page-{p.no:03d}.md", self.page(p.no, size) + "\n")
        w(out / "pages" / "index.md", self.page_index(size) + "\n")
        anomalies = self.anomalies_text()
        w(out / "anomalies.md", anomalies + "\n")
        w(out / "README.md", "\n".join([
            self.overview(), "",
            "## 目录", "",
            "- `anomalies.md` 报错、失败工具、兜底重试、长时间没事件",
            f"- `pages/page-NNN.md` 整段对话按顺序切成 {self.page_count(size)} 页,每页约 {size} 字;`pages/index.md` 是页码目录",
            "- `messages/NN-角色/` 单条消息:`text.md` 正文、`timeline.md` 过程(工具参数截到 2000 字)、"
            "`tools.jsonl` 工具原始记录、`trace.md` / `trace.jsonl` 带时间的执行事件、`meta.json` 其余字段",
            "- `environment/*.json` 导出那一刻的环境快照,按段拆开",
            "- `meta.json` 报告头(格式、导出时间、运行配置)",
            "", "## 异常", "", anomalies, ""]))
        return out


def load(path: Path | str) -> Report:
    """读诊断报告。path 可以是报告文件,也可以是报告所在的文件夹(取里面最大的 .txt / .json)。"""
    p = Path(path)
    if p.is_dir():
        cands = sorted((f for f in p.iterdir() if f.suffix.lower() in (".txt", ".json") and f.is_file()),
                       key=lambda f: -f.stat().st_size)
        if not cands:
            raise FileNotFoundError(f"{p} 里没有 .txt / .json")
        p = cands[0]
    raw = p.read_bytes().decode("utf-8-sig", errors="replace")   # 存盘时带 BOM
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        i = raw.find("{")          # 报告前面粘了几行说明文字的情况
        if i < 0:
            raise
        data = json.loads(raw[i:])
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        raise ValueError(f"{p.name} 不像 PromptCut 对话诊断报告:顶层没有 messages 数组")
    return Report(p, data)


# ───────────────────────── 命令行 ─────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(prog="diaglog", description="PromptCut 对话诊断报告拆读工具")
    ap.add_argument("report", help="诊断报告文件,或它所在的文件夹")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("overview", help="每条消息一行的总表")
    sub.add_parser("anomalies", help="报错、失败工具、兜底重试、长时间没事件")
    sp = sub.add_parser("pages", help="分页目录")
    sp.add_argument("--size", type=int, default=PAGE_SIZE)
    sp = sub.add_parser("page", help="读第 N 页")
    sp.add_argument("n", type=int)
    sp.add_argument("--size", type=int, default=PAGE_SIZE)
    sp = sub.add_parser("show", help="看一条消息")
    sp.add_argument("i", type=int, help="消息下标,支持负数")
    sp.add_argument("--part", choices=["summary", "text", "timeline", "tools", "trace", "meta"], default="summary")
    sp.add_argument("--page", type=int, help="输出太长时只看第 N 页")
    sp.add_argument("--size", type=int, default=PAGE_SIZE)
    sp = sub.add_parser("find", help="正则搜索")
    sp.add_argument("pattern")
    sp.add_argument("-i", action="store_true", help="忽略大小写")
    sp.add_argument("--limit", type=int, default=50)
    sp = sub.add_parser("env", help="环境快照")
    sp.add_argument("key", nargs="?")
    sp = sub.add_parser("split", help="拆成小文件")
    sp.add_argument("-o", "--out")
    sp.add_argument("--size", type=int, default=PAGE_SIZE)
    a = ap.parse_args(argv)

    r = load(a.report)
    if a.cmd == "overview":
        print(r.overview())
    elif a.cmd == "anomalies":
        print(r.anomalies_text())
    elif a.cmd == "pages":
        print(r.page_index(a.size))
    elif a.cmd == "page":
        print(r.page(a.n, a.size))
    elif a.cmd == "show":
        m = r[a.i]
        text = {
            "summary": lambda: m.render(),
            "text": lambda: m.text,
            "timeline": lambda: m.header() + "\n" + m.timeline(input_chars=2000),
            "tools": lambda: "\n".join(json.dumps(t, ensure_ascii=False) for t in m.tools),
            "trace": lambda: m.trace_text() or "(这条消息没有 trace)",
            "meta": lambda: json.dumps(m.meta(), ensure_ascii=False, indent=2),
        }[a.part]()
        chunks = paginate(text, a.size)
        if a.page:
            print(f"=== #{m.index} {a.part} 第 {a.page}/{len(chunks)} 页 ===\n{chunks[a.page - 1]}")
        else:
            print(text)
            if len(chunks) > 1:
                print(f"\n(共 {len(text)} 字;太长可以加 --page 1..{len(chunks)} 分页看)", file=sys.stderr)
    elif a.cmd == "find":
        hits = r.find(a.pattern, a.i, a.limit)
        for h in hits:
            print(h)
        print(f"({len(hits)} 处{',已到上限' if len(hits) >= a.limit else ''})", file=sys.stderr)
    elif a.cmd == "env":
        env = r.environment
        if a.key is None:
            if isinstance(env, dict):
                for k, v in env.items():
                    print(f"{k:<16} {len(_str(v)):>7} 字  {_one_line(v, 80) if isinstance(v, str) else ''}")
            else:
                print(_str(env))
        else:
            print(json.dumps((env or {}).get(a.key), ensure_ascii=False, indent=2))
    elif a.cmd == "split":
        out = r.split(a.out, a.size)
        print(f"拆好了:{out}\n先看 {out / 'README.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
