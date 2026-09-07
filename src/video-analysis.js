// video-analysis.js — AI 视频内容解析
// 路线：Gemini 原生视频优先（YouTube 链接直喂 / 本地文件上传），失败自动退化为
//       本地 ffmpeg 抽帧 + 视觉模型（复用 llm.js 的 vision 链路）。
// 产出：任务目录下 video-analysis.md（中文 Markdown 报告）+ video-analysis.status.json（状态）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { taskDir, readTaskJson } from './task.js';
import { chat } from './llm.js';
import { extractSubtitleLines } from './subtitles.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const STATUS_FILE = 'video-analysis.status.json';
const REPORT_FILE = 'video-analysis.md';

function resolveAnalyzer(cfg) {
  const va = (cfg.llm && cfg.llm.videoAnalyzer) || {};
  return {
    geminiApiKey: (va.gemini && va.gemini.apiKey) || process.env.SMR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
    geminiModel: (va.gemini && va.gemini.model) || 'gemini-2.5-flash',
    intervalSeconds: (va.frames && va.frames.intervalSeconds) || 8,
    maxFrames: (va.frames && va.frames.maxFrames) || 20,
    maxWidth: (va.frames && va.frames.maxWidth) || 960,
  };
}

export function findVideoFile(dir) {
  const preferred = ['current.mp4', 'current.mkv', 'current.webm', 'current.avi'];
  for (const name of preferred) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  for (const f of fs.readdirSync(dir)) {
    if (/\.(mp4|mkv|webm|avi|mov)$/i.test(f)) return path.join(dir, f);
  }
  return '';
}

export function findYoutubeUrl(taskId) {
  try {
    const all = readTaskJson(taskId, 'youtube_all.json');
    if (all && all.url) return all.url;
  } catch { /* ignore */ }
  try {
    const detail = readTaskJson(taskId, 'youtube_detail.json');
    if (detail && detail.id) return `https://www.youtube.com/watch?v=${detail.id}`;
  } catch { /* ignore */ }
  return '';
}

function collectContext(taskId, dir) {
  const ytDetail = readTaskJson(taskId, 'youtube_detail.json') || null;
  const biliDetail = readTaskJson(taskId, 'bilibili_detail.json') || null;
  const meta = ytDetail || biliDetail || {};
  const subtitleText = (() => {
    try {
      const subs = readTaskJson(taskId, 'subtitles.json');
      const lines = extractSubtitleLines(subs);
      return lines.join('\n');
    } catch { return ''; }
  })();
  let commentsSample = '';
  try {
    const comments = readTaskJson(taskId, 'comments.json');
    if (Array.isArray(comments)) {
      const top = comments.slice().sort((a, b) => (Number(b.like) || 0) - (Number(a.like) || 0)).slice(0, 20);
      commentsSample = top.map((c) => `${c.user || '匿名'}（赞${c.like || 0}）：${String(c.content || '').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
    }
  } catch { /* ignore */ }
  return { meta, subtitleText, commentsSample };
}

function buildPrompt({ title, meta, subtitleText, commentsSample }) {
  const stat = [];
  if (meta.viewCount) stat.push('播放 ' + meta.viewCount);
  if (meta.likeCount) stat.push('点赞 ' + meta.likeCount);
  if (meta.commentCount) stat.push('评论 ' + meta.commentCount);
  return [
    '你是专业的视频内容分析师。请基于你实际看到的视频内容（画面与音频），结合下方元数据/字幕/评论，用中文输出一份 Markdown 格式的《视频内容解析报告》。',
    '',
    '报告必须包含以下章节（按此顺序）：',
    '# 视频内容解析报告',
    '## 一句话总结',
    '## 内容概述（200 字内）',
    '## 时间线章节（按视频顺序列主要段落，标注 mm:ss 时间点；时间点从画面/字幕推断，不确定写"约"）',
    '## 画面与视觉要点（场景、人物、出镜物、字幕卡、演示内容）',
    '## 讲解与观点要点（讲述者的核心说法与立场）',
    '## 风格与受众（节奏、剪辑语言、目标人群）',
    '## 评论观察（结合给出的高赞评论）',
    '## 质量与改进建议',
    '## 争议与风险提示（没有写"无明显争议"）',
    '',
    '要求：只依据实际看到/听到的内容下结论，禁止编造；总长 800–1500 字。',
    '',
    '【视频标题】' + (title || '未知'),
    meta.description ? '【视频简介（节选）】\n' + String(meta.description).slice(0, 2000) : '',
    stat.length ? '【数据表现】' + stat.join(' · ') : '',
    subtitleText ? '【字幕全文（节选）】\n' + subtitleText.slice(0, 8000) : '',
    commentsSample ? '【高赞评论（节选）】\n' + commentsSample : '',
  ].filter(Boolean).join('\n');
}

/** Gemini：本地视频文件上传（Files API，resumable，单文件 ≤2GB）→ 轮询 ACTIVE */
async function geminiUploadVideo({ apiKey, filePath }) {
  const size = fs.statSync(filePath).size;
  const init = await fetch(`${GEMINI_BASE}/upload/v1beta/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify({ file: { display_name: path.basename(filePath) } }),
  });
  if (!init.ok) throw new Error('Gemini 上传初始化失败 HTTP ' + init.status + ': ' + (await init.text().catch(() => '')).slice(0, 200));
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) throw new Error('Gemini 上传初始化未返回 location');

  const buf = fs.readFileSync(filePath);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' }, body: buf });
  if (!put.ok) throw new Error('Gemini 上传失败 HTTP ' + put.status);
  const fileUri = put.headers.get('location') || (await put.json().catch(() => ({})))?.file?.uri;
  if (!fileUri) throw new Error('Gemini 上传完成但未返回 file uri');

  // 轮询直到 ACTIVE（视频需要服务端处理）
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const st = await fetch(fileUri, { headers: { 'x-goog-api-key': apiKey } });
    if (st.ok) {
      const j = await st.json();
      if (j.state === 'ACTIVE') return (j.uri || fileUri);
      if (j.state === 'FAILED') throw new Error('Gemini 文件处理失败');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Gemini 文件处理超时（180 秒）');
}

/** Gemini：生成内容（parts 为 [{text}|{file_data:{file_uri, mime_type?}}]） */
async function geminiGenerate({ apiKey, model, parts }) {
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    }),
  });
  if (!res.ok) throw new Error('Gemini 生成失败 HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 200));
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini 返回空内容: ' + JSON.stringify(data).slice(0, 200));
  return text;
}

/** 抽帧：ffmpeg 按 interval 抽帧到临时目录（不缩放不压缩，由调用方决定后续处理） */
async function extractFrames(videoFile, { intervalSeconds, maxFrames, maxWidth }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-frames-'));
  const ff = loadConfig().crawl?.ffmpegPath || 'ffmpeg';
  await new Promise((resolve, reject) => {
    const p = spawn(ff, ['-y', '-i', videoFile, '-vf', `fps=1/${intervalSeconds},scale='min(${maxWidth},iw)':-2`, '-frames:v', String(maxFrames), path.join(tmp, 'f%03d.jpg')], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-200)}`))));
  });
  const frames = fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort().slice(0, maxFrames).map((f) => path.join(tmp, f));
  if (!frames.length) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { } throw new Error('抽帧失败：未生成任何帧'); }
  return { tmp, frames };
}

/**
 * GLM 逐批细读路线：把视频抽帧后按批次（每批 framesPerBatch 帧）喂给视觉模型，
 * 每批产出一段观察，最后把全部观察合并给文本模型写成完整报告。
 * 每批独立请求（单批 ≤10 帧、总 base64 控制在 ~4MB 内，实测 Ollama 云端可通过）。
 */
async function glmFramesAnalyze({ videoFile, prompt, intervalSeconds, maxFrames, maxWidth, framesPerBatch = 10 }) {
  const { tmp, frames } = await extractFrames(videoFile, { intervalSeconds, maxFrames, maxWidth });
  try {
    const observations = [];
    const batches = Math.ceil(frames.length / framesPerBatch);
    for (let b = 0; b < batches; b++) {
      const batch = frames.slice(b * framesPerBatch, (b + 1) * framesPerBatch);
      const startSec = (b * framesPerBatch) * intervalSeconds;
      const endSec = startSec + batch.length * intervalSeconds;
      const imgs = batch.map((f) => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64'));
      const batchPrompt = [
        `这些帧来自同一段视频，按时间顺序排列，对应视频的第 ${startSec} 秒到第 ${endSec} 秒（帧间隔 ${intervalSeconds} 秒）。`,
        '请客观记录每一帧的画面内容（场景/人物/物体/文字/动作），按帧编号输出要点。禁止编造，看不清写"无法辨认"。',
      ].join('\n');
      logger.info('GLM 逐批细读', { batch: `${b + 1}/${batches}`, frames: batch.length, sizeMB: (imgs.reduce((s, u) => s + u.length, 0) / 1048576).toFixed(2) });
      const obs = await chat({ prompt: batchPrompt, imageUrls: imgs, maxTokens: 2500, provider: 'vision' });
      observations.push(`【批次 ${b + 1}/${batches}（第 ${startSec}–${endSec} 秒）】\n${obs}`);
    }
    // 合并成报告
    const mergePrompt = [
      '你从同一段视频中按时间顺序抽取了多批画面，并由视觉模型产出了逐批观察记录。',
      '请把以下观察记录综合成一份连贯的《视频内容解析报告》（中文 Markdown），包含：一句话总结、内容概述、时间线章节（标注时间点）、画面与视觉要点、讲解与观点要点、风格与受众、评论观察（若有）、质量与改进建议。',
      '只依据观察记录下结论，禁止编造；总长 800–1500 字。',
      '',
      '【原始任务说明】\n' + prompt.slice(0, 3000),
      '【逐批观察记录】\n' + observations.join('\n\n').slice(0, 60000),
    ].join('\n\n');
    return await chat({ prompt: mergePrompt, maxTokens: 6000 });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 抽帧兜底：ffmpeg 按 interval 抽帧（缩放到 maxWidth），拼 base64 喂视觉模型 */
async function framesAnalyze({ videoFile, prompt, intervalSeconds, maxFrames, maxWidth }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-frames-'));
  try {
    const ff = loadConfig().crawl?.ffmpegPath || 'ffmpeg';
    await new Promise((resolve, reject) => {
      const p = spawn(ff, ['-y', '-i', videoFile, '-vf', `fps=1/${intervalSeconds},scale='min(${maxWidth},iw)':-2`, '-frames:v', String(maxFrames), path.join(tmp, 'f%03d.jpg')], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-200)}`))));
    });
    const frames = fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort().slice(0, maxFrames);
    if (!frames.length) throw new Error('抽帧失败：未生成任何帧');
    const imageUrls = frames.map((f) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(tmp, f)).toString('base64'));
    const withTs = prompt + `\n\n【帧时间对照】按每 ${intervalSeconds} 秒抽帧：第 N 张画面约对应视频第 ${intervalSeconds}×(N-1) 秒处，时间线请据此估算。`;
    logger.info('抽帧完成，调用视觉模型', { frames: imageUrls.length });
    return await chat({ prompt: withTs, imageUrls, maxTokens: 6000, provider: 'vision' });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * AI 视频内容解析（对外主入口）
 * @param {string} taskId
 * @param {{prefer?: 'auto'|'gemini'|'frames'}} opts
 * @returns {Promise<{ok: boolean, route: string, model: string, file: string}>}
 */
export async function analyzeTaskVideo(taskId, { prefer = 'auto' } = {}) {
  const cfg = loadConfig();
  const an = resolveAnalyzer(cfg);
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) throw new Error('任务不存在: ' + taskId);

  const statusFile = path.join(dir, STATUS_FILE);
  const mdFile = path.join(dir, REPORT_FILE);
  const writeStatus = (s) => fs.writeFileSync(statusFile, JSON.stringify(s, null, 2), 'utf8');

  const ctx = collectContext(taskId, dir);
  const videoFile = findVideoFile(dir);
  const ytUrl = findYoutubeUrl(taskId);
  const prompt = buildPrompt({ title: ctx.meta.title || taskId, meta: ctx.meta, subtitleText: ctx.subtitleText, commentsSample: ctx.commentsSample });

  if (!an.geminiApiKey && !videoFile) {
    throw new Error('无可解析输入：任务目录没有视频文件，也没有 YouTube 链接（且未配置 Gemini key）');
  }
  if (prefer === 'frames' && !videoFile) {
    throw new Error('抽帧路线需要本地视频文件（先完成媒体下载）');
  }

  writeStatus({ status: 'running', startedAt: new Date().toISOString(), prefer });
  logger.info('开始视频解析', { taskId, prefer, hasVideo: !!videoFile, hasYtUrl: !!ytUrl });

  const errors = [];
  let report = '';
  let route = '';
  let model = '';

  if ((prefer === 'auto' || prefer === 'gemini') && an.geminiApiKey) {
    try {
      route = 'gemini';
      model = an.geminiModel;
      if (ytUrl && ytUrl.startsWith('http')) {
        writeStatus({ status: 'running', stage: 'gemini-url', route, model });
        try {
          report = await geminiGenerate({ apiKey: an.geminiApiKey, model, parts: [{ text: prompt }, { file_data: { file_uri: ytUrl } }] });
        } catch (e) {
          errors.push('gemini-url: ' + e.message);
          logger.warn('Gemini YouTube 链接直读失败，尝试上传本地视频', { error: e.message });
        }
      }
      if (!report && videoFile) {
        const sizeMB = fs.statSync(videoFile).size / 1048576;
        if (sizeMB > 2048) throw new Error('本地视频超过 Gemini 2GB 上限（' + Math.round(sizeMB) + 'MB）');
        writeStatus({ status: 'running', stage: 'gemini-upload', route, model, sizeMB: Math.round(sizeMB) });
        const fileUri = await geminiUploadVideo({ apiKey: an.geminiApiKey, filePath: videoFile });
        report = await geminiGenerate({ apiKey: an.geminiApiKey, model, parts: [{ text: prompt }, { file_data: { file_uri: fileUri, mime_type: 'video/mp4' } }] });
      }
      if (!report) throw new Error(errors.join(' | ') || 'Gemini 无可用输入');
    } catch (e) {
      errors.push('gemini: ' + e.message);
      if (prefer === 'gemini') {
        writeStatus({ status: 'error', route, error: e.message, at: new Date().toISOString() });
        throw e;
      }
      report = '';
      logger.warn('Gemini 路线失败，退化抽帧', { error: e.message });
    }
  } else if (prefer === 'gemini') {
    throw new Error('未配置 Gemini key（llm.videoAnalyzer.gemini.apiKey）');
  }

  if (!report && videoFile) {
    // 第三条路线：GLM 逐批细读（真视频帧，走 Ollama/现有 vision 额度）
    // 原单次抽帧（frames）保留为最后兜底（帧数受单请求限制，细读质量更高）
    route = 'glm-frames';
    model = 'vision:' + ((cfg.llm.vision && cfg.llm.vision.model) || cfg.llm.model || 'default');
    writeStatus({ status: 'running', stage: 'glm-frames', route, model });
    try {
      report = await glmFramesAnalyze({ videoFile, prompt, intervalSeconds: an.intervalSeconds, maxFrames: Math.max(an.maxFrames, 30), maxWidth: an.maxWidth });
    } catch (e) {
      errors.push('glm-frames: ' + e.message);
      logger.warn('GLM 逐批细读失败，退化单次抽帧', { error: e.message });
      route = 'frames';
      writeStatus({ status: 'running', stage: 'frames', route, model });
      report = await framesAnalyze({ videoFile, prompt, intervalSeconds: an.intervalSeconds, maxFrames: an.maxFrames, maxWidth: an.maxWidth });
    }
  }

  if (!report) {
    const err = new Error('所有解析路线均失败：' + errors.join(' | '));
    writeStatus({ status: 'error', route, error: err.message, at: new Date().toISOString() });
    throw err;
  }

  fs.writeFileSync(mdFile, report, 'utf8');
  writeStatus({ status: 'done', route, model, at: new Date().toISOString(), file: REPORT_FILE });
  logger.info('视频解析完成', { taskId, route, model, file: mdFile });
  return { ok: true, route, model, file: mdFile };
}

/** 查询解析状态（供 HTTP/MCP/UI 轮询） */
export function getVideoAnalysisStatus(taskId) {
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) return { status: 'none', error: '任务不存在' };
  const statusFile = path.join(dir, STATUS_FILE);
  const mdFile = path.join(dir, REPORT_FILE);
  const st = fs.existsSync(statusFile)
    ? JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    : { status: 'none' };
  st.markdown = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  return st;
}
