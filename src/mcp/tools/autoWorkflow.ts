import { getState, actions } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { sttStatus, transcribeMedia } from "../../editor/io/stt";
import type { TranscriptSegment } from "../../kernel/project";
import { timelineTimeAt } from "../../kernel/clipTime.mjs";

const autoWorkflowJobs = new Map<string, any>();

async function pipeline(args: { mediaId: string; style?: string; maxCards?: number }, job: any) {
  const { mediaId, style, maxCards = 12 } = args;

  // 1. 找素材
  const state = getState();
  const media = state.project.media.find(m => m.id === mediaId);
  if (!media) {
    throw new Error("找不到该素材，可以用 list_media 查");
  }

  // 2. 拿文字稿
  let transcribed = false;
  if (!media.transcript || media.transcript.segments.length === 0) {
    job.phase = "转写中";
    const status = await sttStatus();
    if (!status.engines["faster-whisper"].installed && !status.engines.whisper.installed) {
      throw new Error("没装语音识别引擎，请先用 stt_install 装 faster-whisper");
    }
    const engine = status.engines["faster-whisper"].installed ? "faster-whisper" : "whisper";
    
    await Promise.race([
      transcribeMedia(mediaId, { engine }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("转写超过 10 分钟")), 600000))
    ]);
    
    transcribed = true;
  }
  
  job.phase = "配卡中";
  
  // 重新读取
  const newMedia = getState().project.media.find(m => m.id === mediaId);
  if (!newMedia || !newMedia.transcript || newMedia.transcript.segments.length === 0) {
    throw new Error("文字稿是空的");
  }
  const transcript = newMedia.transcript;

  // 3. 算时间轴映射
  let clipStart = 0;
  let mediaOffset = 0;
  let clipEnd = Infinity;
  let speed: number | undefined;

  for (const track of getState().project.tracks) {
    const clip = track.clips.find(c => c.mediaId === mediaId);
    if (clip) {
      clipStart = clip.start;
      mediaOffset = clip.mediaOffset ?? 0;
      clipEnd = clip.end;
      speed = clip.speed;
      break;
    }
  }

  // 素材秒 → 时间轴秒:kernel/clipTime.mjs 的统一换算(含片段速度)
  const toTl = (s: number) => timelineTimeAt({ start: clipStart, mediaOffset, speed }, s);
  
  const mappedSegments: { start: number; end: number; text: string }[] = [];
  for (const seg of transcript.segments) {
    const tlStart = toTl(seg.start);
    const tlEnd = toTl(seg.end);
    if (tlEnd > clipStart && tlStart < clipEnd) {
      mappedSegments.push({
        start: Math.max(clipStart, Math.min(tlStart, clipEnd)),
        end: Math.max(clipStart, Math.min(tlEnd, clipEnd)),
        text: seg.text
      });
    }
  }

  // 4. 分组
  const groups: { start: number; end: number; text: string }[] = [];
  let currentGroup: typeof mappedSegments = [];

  for (let i = 0; i < mappedSegments.length; i++) {
    const seg = mappedSegments[i];
    currentGroup.push(seg);
    const groupDuration = currentGroup[currentGroup.length - 1].end - currentGroup[0].start;
    
    let shouldBreak = false;
    if (groupDuration >= 15) {
      shouldBreak = true;
    } else if (groupDuration >= 5) {
      const lastChar = seg.text.trim().slice(-1);
      const isPunctuation = /[。？！；.?!]/.test(lastChar);
      
      const nextSeg = mappedSegments[i + 1];
      const gap = nextSeg ? (nextSeg.start - seg.end) : 0;
      const willExceed = nextSeg ? (nextSeg.end - currentGroup[0].start > 15) : false;
      
      if (isPunctuation || gap >= 0.6 || willExceed) {
        shouldBreak = true;
      }
    }

    if (shouldBreak || i === mappedSegments.length - 1) {
      groups.push({
        start: currentGroup[0].start,
        end: currentGroup[currentGroup.length - 1].end,
        text: currentGroup.map(s => s.text.trim()).join("")
      });
      currentGroup = [];
    }
  }

  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    if (last.end - last.start < 5) {
      const prev = groups[groups.length - 2];
      if (last.end - prev.start <= 18) {
        prev.end = last.end;
        prev.text += last.text;
        groups.pop();
      }
    }
  }

  // 5. 选卡
  function selectCard(text: string): string | null {
    if (/(增长|提升|上涨|翻倍|翻了|下降|降低|减少|涨)/.test(text) && (/[0-9]+(\.[0-9]+)?\s*(%|个|倍|万|亿|次|人|分|点)/.test(text) || /[一二三四五六七八九十百千万亿]+\s*(倍|次|个|人|万|亿|成)/.test(text))) return "odometer";
    if (/[0-9]+(\.[0-9]+)?\s*(%|百分|倍|万|亿|次|个|人)/.test(text)) return "stat-proof";
    if (/(对比|相比|比起|而不是|vs|VS|versus|不同于|区别|差别)/.test(text)) return "versus-card";
    if (/(第一|第二|第三|首先|其次|然后|接着|最后|步骤|流程|第一步)/.test(text)) return "step-timeline";
    if (/(要点|清单|包括|分别是|三点|几点|需要|必须)/.test(text)) return "checklist";
    if (/[「」『』“”"]/.test(text)) return "quote-lockup";
    if (/(记住|关键在于|本质上|一句话|核心是|重点是)/.test(text)) return "blur-text";
    if (text.length <= 14 && /[!！]$/.test(text)) return "punch-pill";
    if (/(所谓|叫做|叫作|定义|是指|指的是|术语|概念)/.test(text)) return "term-card";
    return null;
  }

  const selectedCards: { group: typeof groups[0], cardId: string }[] = [];
  for (const g of groups) {
    const cardId = selectCard(g.text);
    if (cardId) {
      selectedCards.push({ group: g, cardId });
    }
  }

  const cardsToPlace = selectedCards.slice(0, maxCards);

  // 6. 填参数
  function paramsFor(cardId: string, rawText: string) {
    const text = rawText.trim();
    const short = text.slice(0, 24);
    const snippet = text.slice(0, 40);
    const def = getCard(cardId);
    if (!def) return {};

    const p: Record<string, any> = {};
    const extractNum = (str: string) => {
      const m = str.match(/\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : 100;
    };

    if (cardId === "odometer") {
      p.unit = "";
      p.label = snippet;
      p.value = extractNum(text);
      p.kicker = "DATA";
    } else if (cardId === "stat-proof") {
      p.value = extractNum(text);
      const suffixMatch = text.match(/\d+(\.\d+)?([%倍万亿次])/);
      p.suffix = suffixMatch ? suffixMatch[2] : "";
      p.prefix = "";
      p.kickerZh = short;
      p.footZh = snippet;
      p.kicker = "DATA";
    } else if (cardId === "versus-card") {
      p.aTitle = "A";
      p.bTitle = "B";
      const mid = Math.floor(snippet.length / 2);
      if (mid > 0) {
        p.aSub = snippet.slice(0, mid);
        p.bSub = snippet.slice(mid);
      } else {
        p.aSub = snippet;
        p.bSub = snippet;
      }
    } else if (cardId === "step-timeline" || cardId === "checklist") {
      const parts = text.split(/[，。、,]/).map(x => x.trim()).filter(Boolean);
      const items = parts.map(x => x.slice(0, 8)).slice(0, cardId === "checklist" ? 4 : 5);
      if (cardId === "step-timeline") {
        p.steps = items.length >= 2 ? items.join("|") : snippet;
      } else {
        p.items = items.length >= 2 ? items.join("|") : snippet;
      }
    } else if (cardId === "quote-lockup") {
      p.quote = snippet.replace(/(.{12})/g, "$1|").replace(/\|$/, "");
      p.author = "";
    } else if (cardId === "blur-text") {
      p.text = snippet.replace(/(.{10})/g, "$1|").replace(/\|$/, "");
    } else if (cardId === "punch-pill") {
      p.text = short;
    } else if (cardId === "term-card") {
      p.term = short;
      p.def = snippet;
      p.en = "";
    }

    const filtered: Record<string, any> = {};
    for (const key of Object.keys(p)) {
      if (def.controls.some(c => c.key === key)) {
        filtered[key] = p[key];
      }
    }
    return filtered;
  }

  // 7. 落卡
  let skipped = groups.length - cardsToPlace.length;
  const clipsOut: any[] = [];
  
  for (const { group, cardId } of cardsToPlace) {
    const params = paramsFor(cardId, group.text);
    const clip = actions.addCardClip(cardId, group.start, {
      duration: group.end - group.start,
      params
    });
    if (!clip) {
      skipped++;
    } else {
      clipsOut.push({
        clipId: clip.id,
        cardId,
        start: clip.start,
        end: clip.end,
        text: group.text.slice(0, 40)
      });
    }
  }

  let captionClipId: string | null = null;
  if (mappedSegments.length > 0) {
    // 字幕单独一条序列,而且建在最上层 —— 字幕得压在画面之上,追加到末尾等于埋在底下
    const captionTrack = actions.ensureCaptionTrack();
    
    const globalStart = Math.min(...mappedSegments.map(s => s.start));
    const globalEnd = Math.max(...mappedSegments.map(s => s.end));
    
    const lines = mappedSegments.map(seg => {
      const rStart = (seg.start - globalStart).toFixed(2);
      const rEnd = (seg.end - globalStart).toFixed(2);
      const cleanedText = seg.text.trim().replace(/[\n|]/g, " ");
      return `${rStart}|${rEnd}|${cleanedText}|`;
    }).join("\n");
    
    const captionClip = actions.addCardClip("caption-track", globalStart, {
      duration: globalEnd - globalStart,
      trackId: captionTrack.id,
      params: { lines, showEn: "false" }
    });
    
    if (captionClip) {
      captionClipId = captionClip.id;
    }
  }

  const maxClipEnd = Math.max(0, ...getState().project.tracks.flatMap(t => t.clips.map(c => c.end)));
  if (maxClipEnd > getState().project.duration) {
    actions.setProjectMeta({ duration: maxClipEnd });
  }

  // 8. 返回
  return {
    mediaId,
    style,
    transcribed,
    segments: mappedSegments.length,
    groups: groups.length,
    captionClipId,
    clips: clipsOut,
    skipped
  };
}

export async function runAutoWorkflow(args: { mediaId: string; style?: string; maxCards?: number }) {
  const jobId = "aw-" + args.mediaId + "-" + Math.random().toString(36).slice(2, 6);
  const job: any = {
    done: false,
    ok: false,
    result: null,
    error: null,
    startedAt: Date.now(),
    phase: "转写中"
  };
  autoWorkflowJobs.set(jobId, job);

  const p = pipeline(args, job);
  p.then(res => {
    job.done = true;
    job.ok = true;
    job.result = res;
    job.phase = "已完成";
  }).catch(err => {
    job.done = true;
    job.ok = false;
    job.error = err instanceof Error ? err.message : String(err);
    job.phase = "失败";
  });

  const raceResult = await Promise.race([
    p,
    new Promise(resolve => setTimeout(() => resolve("__AW_SLOW__"), 50000))
  ]);

  if (raceResult === "__AW_SLOW__") {
    return {
      jobId,
      running: true,
      started: true,
      mediaId: args.mediaId,
      phase: job.phase,
      hint: "素材较长，转写和配卡已在后台继续，请用 auto_workflow_status 带上这个 jobId 轮询，done 为 true 时 result 里就是完整结果；这期间不要重复调用 auto_workflow"
    };
  } else {
    return {
      ...(raceResult as any),
      jobId,
      running: false
    };
  }
}

export function getAutoWorkflowStatus(args: { jobId: string }) {
  const job = autoWorkflowJobs.get(args.jobId);
  if (!job) {
    throw new Error("找不到该作业，可能是 jobId 错误或系统已重启");
  }
  return {
    jobId: args.jobId,
    done: job.done,
    ok: job.ok,
    phase: job.phase,
    elapsedMs: Date.now() - job.startedAt,
    error: job.error,
    result: job.result
  };
}
