// smart-analysis.js — LLM 智能定位 + 重点段密集抽帧 + 表格提取
// 流程（用户定稿的"两阶段"设计）：
//   1. 文本 LLM 通读全部资料（字幕语义 + 弹幕高能 + 元数据）→ 定位值得细看的时间段
//   2. 对重点段做密集抽帧（每秒 1 帧，比盲抽密 8 倍，捕捉表格完整画面）
//   3. 帧喂视觉模型 → 提取表格里的具体参数/数字/型号
//   4. 全部观察合并 → 产出《视频内容解析报告》，含"参数对比"专章
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { taskDir, readTaskJson } from './task.js';
import { chat, parseJsonReply, locateKeyMoments } from './llm.js';
import { extractSubtitleLines } from './subtitles.js';
import { findVideoFile, findYoutubeUrl } from './video-analysis.js';

const DENSE_FPS = 1;            // 重点段密集抽帧：每秒 1 帧
const MAX_DENSE_FRAMES = 40;    // 全部重点段合计帧数上限
const FRAMES_PER_VISION_BATCH = 8;  // 视觉模型单请求帧数

/** 收集全部文本资料（字幕/弹幕/元数据/评论） */
function collectAll(taskId) {
  const ytDetail = readTaskJson(taskId, 'youtube_detail.json') || null;
  const biliDetail = readTaskJson(taskId, 'bilibili_detail.json') || null;
  const meta = ytDetail || biliDetail || {};
  const subs = readTaskJson(taskId, 'subtitles.json');
  const subtitleLines = extractSubtitleLines(subs); // [{from?, content}] 或纯文本行
  const danmaku = readTaskJson(taskId, 'bilibili_danmaku.json') || readTaskJson(taskId, 'danmaku.json') || [];
  let commentsSample = '';
  try {
    const comments = readTaskJson(taskId, 'comments.json') || readTaskJson(taskId, 'bilibili_comment.json') || [];
    if (Array.isArray(comments)) {
      const top = comments.slice().sort((a, b) => (Number(b.like) || 0) - (Number(a.like) || 0)).slice(0, 20);
      commentsSample = top.map((c) => `${c.user || '匿名'}（赞${c.like || 0}）：${String(c.content || '').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
    }
  } catch { /* ignore */ }
  let duration = 0;
  const d = String(meta.duration || '');
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (m) duration = (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  return { meta, subtitleLines, danmaku, commentsSample, duration };
}

/**
 * 双通道定位：字幕语义 + 弹幕高能 → 合并时间点
 * @returns {Promise<Array<{time:number, reason:string, source:string}>>}
 */
async function locateFocusPoints(taskId, all, topN = 8) {
  // 通道素材：字幕带时间戳行 + 弹幕带时间戳行
  const subtitleTl = (all.subtitleLines || [])
    .map((s, i) => {
      const from = Number(s?.from ?? s?.start ?? NaN);
      const text = s?.content || s?.text || s || '';
      return Number.isFinite(from) ? `[${Math.round(from)}s] ${String(text).slice(0, 80)}` : '';
    })
    .filter(Boolean).join('\n');
  const danmakuTl = (all.danmaku || [])
    .map((d) => `t=${Math.round(Number(d.time) || 0)}s ${String(d.content || '')}`)
    .join('\n');

  // 通道 1：复用 locateKeyMoments（弹幕高能 + 截图价值）
  let moments = [];
  try {
    moments = await locateKeyMoments({
      videoTitle: all.meta.title, danmakuText: danmakuTl, subtitleText: subtitleTl, duration: all.duration,
    }, { topN });
    moments = moments.map((m) => ({ ...m, source: '弹幕高能' }));
  } catch (e) {
    logger.warn('弹幕高能定位失败', { error: e.message });
  }

  // 通道 2：字幕语义定位（找"参数/表格/对比/配置/实测"等硬信息段）
  try {
    const sys = '你是视频内容分析师。只输出 JSON，不输出任何其他文字。';
    const prompt = [
      `视频《${all.meta.title || ''}》${all.duration ? `（时长约 ${Math.floor(all.duration / 60)} 分钟）` : ''}。以下为带时间戳的字幕。`,
      `请从字幕语义中找出 ${topN} 个"包含关键硬信息"的时间点，优先级：`,
      `1. 提到具体数字/价格/参数/型号/跑分/对比结论的句子`,
      `2. 提到"表格/图表/截图/看这里/如图"等画面依赖内容的句子（此时画面里大概率有表格或数据）`,
      `3. 关键结论、转折、建议集中出现的段落`,
      `输出 JSON: {"moments": [{"time": 秒数(数字，必须是下方真实出现的时间), "reason": "为何关键(50字内)", "evidence": ["字幕原文"]}]}，按时间升序。`,
      '',
      '---字幕---',
      subtitleTl.slice(0, 24000),
    ].join('\n');
    const reply = await chat({ system: sys, prompt, json: true, maxTokens: 2000 });
    let parsed;
    try { parsed = JSON.parse(reply); } catch { parsed = JSON.parse((reply.match(/\{[\s\S]*\}/) || [])[0] || '{}'); }
    const subMoments = (Array.isArray(parsed?.moments) ? parsed.moments : [])
      .filter((m) => Number.isFinite(Number(m?.time)))
      .map((m) => ({ time: Math.max(0, Number(m.time)), reason: String(m.reason || '').slice(0, 200), source: '字幕语义' }));
    moments = moments.concat(subMoments);
  } catch (e) {
    logger.warn('字幕语义定位失败', { error: e.message });
  }

  // 合并：相近时间点（±15 秒）去重，保留证据更充分的
  moments.sort((a, b) => a.time - b.time);
  const merged = [];
  for (const m of moments) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(m.time - last.time) <= 15) {
      if ((m.evidence?.length || 0) > (last.evidence?.length || 0)) merged[merged.length - 1] = m;
    } else {
      merged.push(m);
    }
  }
  logger.info('双通道定位完成', { total: moments.length, merged: merged.length, points: merged.map((m) => `${Math.round(m.time)}s(${m.source.slice(0, 2)})`).join(' ') });
  return merged.slice(0, topN);
}

/**
 * 智能解析主入口：LLM 定位 → 重点段密集抽帧 → 表格提取 → 完整报告
 * @param {string} taskId
 * @param {{prefer?: 'auto'|'gemini'|'glm-frames'|'smart'}} opts — prefer=smart 强制走本路线
 */
export async function analyzeTaskSmart(taskId, { prefer = 'auto' } = {}) {
  const cfg = loadConfig();
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) throw new Error('任务不存在: ' + taskId);
  const videoFile = (function findVid() {
    for (const n of ['current.mp4', 'current.mkv', 'current.webm']) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
    for (const f of fs.readdirSync(dir)) {
      if (/\.(mp4|mkv|webm|avi)$/i.test(f)) return path.join(dir, f);
    }
    return '';
  })();
  if (!videoFile) throw new Error('智能解析需要本地视频文件（先完成媒体下载）');

  const statusFile = path.join(dir, 'video-analysis.status.json');
  const mdFile = path.join(dir, 'video-analysis.md');
  const writeStatus = (s) => fs.writeFileSync(statusFile, JSON.stringify(s, null, 2), 'utf8');
  writeStatus({ status: 'running', route: 'smart', startedAt: new Date().toISOString() });

  // ---- 阶段 1：双通道定位 ----
  writeStatus({ status: 'running', route: 'smart', stage: 'locate' });
  const all = collectAll(taskId);
  const points = await locateFocusPoints(taskId, all);
  if (!points.length) throw new Error('LLM 未能定位到任何重点时间段');
  logger.info('重点时间点定位完成', { taskId, points: points.map((p) => Math.round(p.time)) });

  // ---- 阶段 2：重点段密集抽帧（每点 ±10 秒、每秒 1 帧）----
  writeStatus({ status: 'running', route: 'smart', stage: 'dense-frames' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smart-'));
  const ff = cfg.crawl?.ffmpegPath || 'ffmpeg';
  const dense = []; // {file, time, pointIdx}
  try {
    for (const [pi, p] of points.entries()) {
      if (dense.length >= MAX_DENSE_FRAMES) break;
      const start = Math.max(0, Math.floor(p.time) - 10);
      const need = Math.min(MAX_DENSE_FRAMES - dense.length, 20);
      await new Promise((resolve, reject) => {
        const args = ['-y', '-ss', String(start), '-i', videoFile, '-t', '20', '-vf', `fps=${DENSE_FPS},scale='min(960,iw)':-2`, '-frames:v', String(need), path.join(tmp, `p${pi}_%03d.jpg`)];
        const proc = spawn2(ff, args);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${(proc.stderrText || '').slice(-150)}`))));
        proc.on('error', reject);
      });
      const produced = fs.readdirSync(tmp).filter((f) => f.startsWith(`p${pi}_`)).sort();
      for (const f of produced) {
        if (dense.length < MAX_DENSE_FRAMES) dense.push({ file: path.join(tmp, f), time: start + dense.filter((x) => x.file.includes(`p${pi}`)).length, pointIdx: pi });
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('重点段抽帧失败: ' + e.message);
  }
  logger.info('重点段密集抽帧完成', { taskId, frames: dense.length });

  // ---- 阶段 3：视觉模型细读（表格/参数提取），按重点点分批 ----
  writeStatus({ status: 'running', route: 'smart', stage: 'vision' });
  const tableNotes = [];
  const byPoint = new Map();
  for (const d of dense) {
    if (!byPoint.has(d.pointIdx)) byPoint.set(d.pointIdx, []);
    byPoint.get(d.pointIdx).push(d);
  }
  for (const [pi, frames] of byPoint.entries()) {
    const p = points[pi];
    const imgs = frames.map((f) => 'data:image/jpeg;base64,' + fs.readFileSync(f.file).toString('base64'));
    const visionPrompt = [
      `这是视频《${all.meta.title || ''}》第 ${Math.round(p.time)} 秒附近的连续画面（每秒 1 帧，共 ${frames.length} 帧，时间点原因：${p.reason}）`,
      '请仔细查看这些画面：',
      '1. 若画面中有**表格/图表/参数列表/价格/跑分/对比数据**：把里面可辨认的具体数字、型号、结论**逐项抄录**出来（这是最重要的任务）。',
      '2. 描述这段时间画面里发生了什么。',
      '看不清的内容写"无法辨认"，禁止编造数字。',
    ].join('\n');
    try {
      const note = await chat({ prompt: visionPrompt, imageUrls: imgs, maxTokens: 3000, provider: 'vision' });
      tableNotes.push({ time: Math.round(p.time), reason: p.reason, source: p.source, note });
    } catch (e) {
      logger.warn('视觉细读失败（跳过该点）', { point: pi, error: e.message });
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  // ---- 阶段 4：汇总成完整报告 ----
  writeStatus({ status: 'running', route: 'smart', stage: 'merge' });
  const subtitleText = (all.subtitleLines || [])
    .map((s) => (Number.isFinite(Number(s?.from)) ? `[${Math.round(Number(s.from))}s] ${s.content || s.text || ''}` : String(s)))
    .join('\n');
  const finalPrompt = [
    '你是专业视频分析师。以下是某视频的多源数据：双通道定位到的重要时间点（附视觉模型对这些时间点画面的细读笔记，含表格参数提取），以及完整字幕、高赞评论。',
    '请写成中文 Markdown《视频内容解析报告》，除常规章节（一句话总结/内容概述/时间线章节/画面与视觉要点/讲解与观点要点/风格与受众/评论观察/质量与改进建议）外，**必须包含一个《关键参数与数据对比》专章**——把视觉模型从画面表格中提取的具体数字、型号、价格、跑分、对比结论整理成表格呈现。',
    '只依据给出的资料，禁止编造；总长 1000–2000 字。',
    '',
    '【视频标题】' + (all.meta.title || ''),
    all.meta.description ? '【简介（节选）】\n' + String(all.meta.description).slice(0, 1500) : '',
    '【双通道定位的重要时间点】\n' + points.map((p) => `- ${Math.round(p.time)}s（${p.source}）：${p.reason}`).join('\n'),
    '【重点时间点画面细读笔记（含表格提取）】\n' + tableNotes.map((t) => `### ${t.time}s（${t.source}·${t.reason}）\n${t.note}`).join('\n\n').slice(0, 40000),
    subtitleText ? '【完整字幕】\n' + subtitleText.slice(0, 16000) : '',
    all.commentsSample ? '【高赞评论】\n' + all.commentsSample.slice(0, 4000) : '',
  ].filter(Boolean).join('\n\n');

  const report = await chat({ prompt: finalPrompt, maxTokens: 8000 });
  fs.writeFileSync(mdFile, report, 'utf8');
  writeStatus({ status: 'done', route: 'smart', model: 'text+vision', at: new Date().toISOString(), file: 'video-analysis.md', focusPoints: points.map((p) => Math.round(p.time)) });
  logger.info('智能视频解析完成', { taskId, file: mdFile });
  return { ok: true, route: 'smart', file: mdFile, focusPoints: points.map((p) => Math.round(p.time)) };
}

function spawn2(ff, args) {
  const p = spawn(ff, args, { windowsHide: true });
  p.stderrText = '';
  p.stderr.on('data', (c) => { p.stderrText += c; });
  p.on('error', () => {});
  return p;
}