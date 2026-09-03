// platforms/bilibili/keyframes.js — 关键帧分析（两阶段 AI 流水线）
// 阶段1: deepseek-v4-flash 语义分析弹幕+字幕 → 定位"值得截图的关键时间点"
// 阶段2: ffmpeg 提取该点附近多帧 → 多图传给识图模型精准识别画面
// 输出: data/<taskId>/keyframes.json + data/<taskId>/keyframes/kf_*.jpg
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { findFfmpeg } from './download.js';
import { chat, parseJsonReply, ANALYST_PERSONA, locateKeyMoments } from '../../llm.js';
import { extractSubtitleLines } from '../../subtitles.js';

export { extractSubtitleLines };

/** 弹幕关键词权重（命中即标记该时刻为重点） */
const KEYWORDS = [
  { word: '划重点', w: 5 }, { word: '重点', w: 4 }, { word: '高能', w: 4 },
  { word: '前方高能', w: 5 }, { word: '必看', w: 4 }, { word: '注意', w: 3 },
  { word: '记住', w: 4 }, { word: '要考', w: 5 }, { word: '考试', w: 4 },
  { word: '背下来', w: 5 }, { word: '截图', w: 4 }, { word: '笔记', w: 3 },
  { word: '干货', w: 3 }, { word: '关键', w: 3 }, { word: '重要', w: 3 },
  { word: '警告', w: 4 }, { word: '这个要记', w: 5 }, { word: '学会了', w: 2 },
  { word: '细节', w: 2 }, { word: '精髓', w: 3 }, { word: '精髓在这', w: 4 },
  { word: '精华', w: 3 }, { word: '教程', w: 2 }, { word: '讲解', w: 2 },
  { word: '来了来了', w: 2 }, { word: '快看', w: 3 }, { word: '看清楚', w: 3 },
  { word: '就是这个', w: 3 }, { word: '这才是', w: 3 }, { word: '全在这', w: 3 },
];

const CLUSTER_WINDOW = 5; // 秒: 同一窗口内的命中合并为一个关键点

/**
 * 阶段1: LLM 语义定位关键时间点（deepseek-v4-flash）
 * 组装弹幕+字幕时间线 → locateKeyMoments → 校验并映射到最近的真实弹幕时间
 */
export async function findKeyMomentsByLLM({ danmakuItems, subtitleLines, detail, topN = 5 }) {
  const sorted = [...(danmakuItems || [])].sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));

  // 弹幕文本: 全部（超 400 条则均匀抽样，保证时间覆盖）
  let dmPool = sorted;
  if (dmPool.length > 400) {
    const step = dmPool.length / 400;
    dmPool = dmPool.filter((_, i) => Math.floor(i / step) !== Math.floor((i - 1) / step));
  }
  const danmakuText = dmPool.map((d) => `t=${Math.round(Number(d.time) || 0)}s ${d.content}`).join('\n');

  // 字幕文本: 全部（超 400 条抽样）
  let subPool = subtitleLines || [];
  if (subPool.length > 400) {
    const step = subPool.length / 400;
    subPool = subPool.filter((_, i) => Math.floor(i / step) !== Math.floor((i - 1) / step));
  }
  const subtitleText = subPool.map((s) => `[${Math.round(s.from)}s] ${s.content}`).join('\n');

  const moments = await locateKeyMoments({
    videoTitle: detail?.title || '',
    danmakuText,
    subtitleText,
    duration: detail?.duration,
  }, { topN });
  if (!moments.length) return [];

  // 校验: 把 LLM 给出的时间映射到最近的弹幕时间（±8 秒内），找不到则丢弃
  const dmTimes = sorted.map((d) => Number(d.time) || 0);
  const out = [];
  for (const m of moments) {
    let nearest = null;
    let bestDelta = Infinity;
    for (const t of dmTimes) {
      const delta = Math.abs(t - m.time);
      if (delta < bestDelta) { bestDelta = delta; nearest = t; }
    }
    if (nearest === null || bestDelta > 8) continue; // 幻觉时间点，丢弃
    const hits = sorted.filter((d) => Math.abs((Number(d.time) || 0) - nearest) <= 4)
      .slice(0, 8).map((d) => ({ time: Number(d.time) || 0, content: d.content }));
    out.push({ time: nearest, score: Math.max(1, 6 - Math.round(bestDelta)), reason: m.reason, evidence: m.evidence, hits });
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(0, topN);
}

/**
 * 从弹幕中定位关键时间点（关键词命中 + 5 秒窗口聚类）
 * @param {Array<{time:number, content:string}>} danmakuItems
 * @param {{topN?: number}} opts
 * @returns {Array<{time:number, score:number, hits:Array<{content:string, time:number}>}>}
 */
export function findKeyMoments(danmakuItems, { topN = 5 } = {}) {
  const hits = [];
  for (const d of danmakuItems || []) {
    const content = String(d.content || '');
    for (const { word, w } of KEYWORDS) {
      if (content.includes(word)) {
        hits.push({ time: Number(d.time) || 0, content, score: w });
        break; // 一条弹幕只记一次（取最高权重的词先命中）
      }
    }
  }
  if (!hits.length) return [];
  hits.sort((a, b) => a.time - b.time);

  // 聚类: 时间差 <= CLUSTER_WINDOW 的命中归为一点
  const clusters = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && h.time - last.time <= CLUSTER_WINDOW) {
      last.hits.push(h);
      last.score += h.score;
      last.time = h.time; // 取该簇最后一条命中时间
    } else {
      clusters.push({ time: h.time, score: h.score, hits: [h] });
    }
  }

  clusters.sort((a, b) => b.score - a.score);
  // 同分时按时间排序（保持稳定输出）
  const picked = clusters.slice(0, topN);
  picked.sort((a, b) => a.time - b.time);
  return picked.map((c) => ({
    time: Math.max(0, c.time),
    score: c.score,
    hits: c.hits.slice(0, 8).map((h) => ({ time: h.time, content: h.content })),
  }));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = findFfmpeg();
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-300)}`))));
    p.on('error', (e) => reject(e));
  });
}

/**
 * 提取某时间点附近的连续多帧（jpg）
 * @param {string} mp4 视频文件路径
 * @param {number} time 中心时间（秒）
 * @param {{framesPerMoment?: number, outDir?: string, prefix?: string}} opts
 * @returns {Promise<string[]>} 帧文件绝对路径列表
 */
export async function extractFrames(mp4, time, { framesPerMoment = 5, outDir = process.cwd(), prefix = 'kf' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const half = Math.floor(framesPerMoment / 2);
  const times = [];
  for (let i = -half; i <= half; i++) times.push(Math.max(0, time + i)); // t-2..t+2
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const out = path.join(outDir, `${prefix}_${i + 1}.jpg`);
    try {
      await runFfmpeg(['-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', '-q:v', '3', out]);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) files.push(out);
    } catch (e) {
      logger.warn('提取帧失败', { t, error: e.message });
    }
  }
  return files;
}

const fmtTime = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 关键帧分析主流程（两阶段: LLM 定位 → 提帧 → 识图模型识别）
 * @param {string} taskId
 * @param {{topN?: number, framesPerMoment?: number, useRules?: boolean}} opts
 *   useRules=true 时跳过 LLM 定位直接用关键词规则
 * @returns {Promise<{taskId, moments: Array, frames: string[], keyframesFile: string}>}
 */
export async function analyzeKeyframes(taskId, { topN = 5, framesPerMoment = 5, useRules = false } = {}) {
  const dir = path.join(DATA_DIR, taskId);
  const readJson = (f) => {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
  };
  const danmaku = readJson('bilibili_danmaku.json');
  if (!Array.isArray(danmaku)) throw new Error('任务中无弹幕数据');
  const detail = readJson('bilibili_detail.json');
  const subtitles = readJson('subtitles.json');
  const mp4 = path.join(dir, 'current.mp4');
  if (!fs.existsSync(mp4)) throw new Error('任务中无视频文件 current.mp4（需先采集时勾选下载视频）');
  if (danmaku.length === 0) throw new Error('任务弹幕为空，无法定位关键时间点');

  // 阶段1: 定位关键时间点（LLM 语义分析优先，规则兜底）
  let moments = [];
  let locator = 'llm';
  if (!useRules) {
    try {
      const subtitleLines = extractSubtitleLines(subtitles);
      moments = await findKeyMomentsByLLM({ danmakuItems: danmaku, subtitleLines, detail, topN });
      if (!moments.length) logger.warn('LLM 未定位到关键点，回退关键词规则', { taskId });
    } catch (e) {
      logger.warn('LLM 定位失败，回退关键词规则', { taskId, error: e.message });
    }
  }
  if (!moments.length) {
    locator = 'rules';
    moments = findKeyMoments(danmaku, { topN }).map((m) => ({ ...m, reason: '弹幕关键词标记', evidence: m.hits.map((h) => h.content) }));
  }
  if (!moments.length) throw new Error('未定位到任何关键时间点（弹幕无标记词且 LLM 无输出）');

  logger.info('关键帧分析: 定位关键时间点', { taskId, count: moments.length, locator });
  const visionEnabled = loadConfig().llm.visionEnabled !== false;
  if (!visionEnabled) logger.info('视觉分析已禁用（visionEnabled=false），跳过识图模型识别，仅定位+提帧', { taskId });
  const videoTitle = detail?.title || taskId;
  const frameDir = path.join(dir, 'keyframes');
  const results = [];
  const allFrameFiles = [];
  for (const m of moments) {
    const prefix = `kf_${fmtTime(m.time).replace(':', '')}`;
    const frames = await extractFrames(mp4, m.time, { framesPerMoment, outDir: frameDir, prefix });
    if (!frames.length) {
      logger.warn('关键点无可用帧，跳过', { taskId, time: m.time });
      continue;
    }
    // 阶段2: 多图精准识别（识图模型）——受 visionEnabled 总开关控制
    let analysis = null;
    if (visionEnabled) {
      const imageUrls = frames.map((f) => {
        const ext = path.extname(f).replace('.', '') || 'jpg';
        return `data:image/${ext};base64,${fs.readFileSync(f).toString('base64')}`;
      });
    const system = ANALYST_PERSONA + `
你现在执行"关键画面精准识别"任务，角色是视频画面分析专家（视觉研究员）：
- 只客观描述画面中实际存在的内容，严禁推测画面外信息
- 屏幕文字必须逐字转录（界面标题、按钮、弹窗、字幕、代码、文件路径等），照抄画面显示，不润色不脑补
- 无法确认的内容标注"（不确定）"，绝不编造
- 只输出 JSON，不输出任何其他文字`;
      const danmakuContext = (m.hits || []).map((h) => `[${fmtTime(h.time)}] ${h.content}`).join('\n');
      const prompt = [
        `视频《${videoTitle}》${fmtTime(m.time)} 处被判定为值得截图的关键时刻。`,
        `定位依据（供参考，来自阶段1分析）: ${m.reason || ''}`,
        m.evidence?.length ? `证据: ${m.evidence.join(' / ')}` : '',
        `该时刻附近相关弹幕:`,
        danmakuContext || '(无)',
        `以下是该时刻附近连续 ${frames.length} 帧画面（按时间顺序，同一机位）。`,
        `请输出 JSON: {"description": "画面内容精准描述(120字内: 主体/场景/界面/工具/人物动作)", "on_screen_text": ["逐字转录画面中所有可见文字(无则空数组)"], "why_key": "该画面为何值得截图(结合画面与弹幕证据,60字内)"}`,
      ].filter(Boolean).join('\n');
      try {
        const reply = await chat({ system, prompt, imageUrls, json: true, maxTokens: 1200 });
        analysis = parseJsonReply(reply);
      } catch (e) {
        logger.warn('关键帧识别失败', { taskId, time: m.time, error: e.message });
      }
    }
    const frameNames = frames.map((f) => path.basename(f));
    allFrameFiles.push(...frameNames);
    results.push({
      time: m.time,
      timeLabel: fmtTime(m.time),
      score: m.score,
      reason: m.reason,
      evidence: m.evidence,
      danmaku: m.hits,
      frames: frameNames,
      analysis,
    });
  }

  const payload = {
    taskId,
    videoTitle,
    generatedAt: new Date().toISOString(),
    pipeline: '阶段1: deepseek-v4-flash 语义定位 → 阶段2: 识图模型画面识别',
    visionEnabled,
    locator,
    moments: results,
  };
  const keyframesFile = path.join(dir, 'keyframes.json');
  fs.writeFileSync(keyframesFile, JSON.stringify(payload, null, 2), 'utf8');
  logger.info('关键帧分析完成', { taskId, moments: results.length, frames: allFrameFiles.length, locator });
  return { taskId, moments: results, frames: allFrameFiles, keyframesFile, locator };
}
