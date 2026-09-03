// asr.js — 无官方字幕时的语音转写
// 引擎（config.asr.engine=auto 时按顺序尝试）:
//   1. 本地 whisper.cpp（tools/whisper-cli.exe + ggml/gguf 模型，完全离线）
//   2. OpenAI 兼容 /v1/audio/transcriptions（如硅基流动 SenseVoice；可 followLlm）
// 输出与 B 站 BCC 相同结构，下游 subtitles.json / 合集报告 / 关键帧无需改协议。
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT, loadConfig } from './config.js';
import { logger } from './logger.js';
import { assertLlmBaseUrl } from './security.js';
import { findFfmpeg, runFfmpeg } from './platforms/bilibili/download.js';
import { getAsrPreset } from './asr-presets.js';
import { attachTaskAbort, throwIfAborted, TaskCancelledError, readTaskMeta } from './task.js';

const MEDIA_CANDIDATES = ['current.mp4', 'current.mp3', 'current_audio.m4s', 'current_audio.mp3'];

export function findMediaFile(dir) {
  for (const name of MEDIA_CANDIDATES) {
    const fp = path.join(dir, name);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 0) return fp;
  }
  return '';
}

function findOnPath(names) {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of exts) {
        const fp = path.join(dir, name.endsWith(ext) && ext ? name : name + ext);
        try { if (fs.existsSync(fp)) return fp; } catch { /* ignore */ }
      }
    }
  }
  return '';
}

function resolveExistingPath(p) {
  if (!p) return '';
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  const rel = path.join(ROOT, p);
  if (fs.existsSync(rel)) return rel;
  return '';
}

export function findWhisperBin() {
  const asr = loadConfig().asr || {};
  const configured = resolveExistingPath(asr.whisperBin);
  if (configured) return configured;
  const extra = [
    path.join(ROOT, 'tools', 'whisper-cli.exe'),
    path.join(ROOT, 'tools', 'whisper-cli'),
    path.join(ROOT, 'tools', 'main.exe'),
    path.join(ROOT, 'tools', 'whisper.cpp', 'whisper-cli.exe'),
    path.join(ROOT, 'tools', 'whisper.cpp', 'whisper-cli'),
  ];
  for (const fp of extra) if (fs.existsSync(fp)) return fp;
  return findOnPath(['whisper-cli', 'whisper-cli.exe', 'main', 'whisper']);
}

export function findWhisperModel() {
  const asr = loadConfig().asr || {};
  if (asr.whisperModel) return resolveExistingPath(asr.whisperModel);
  const tools = path.join(ROOT, 'tools');
  if (!fs.existsSync(tools)) return '';
  let files = [];
  try { files = fs.readdirSync(tools).filter((f) => /\.(bin|gguf)$/i.test(f)); } catch { return ''; }
  const prefer = ['small', 'base', 'medium', 'tiny', 'turbo', 'large'];
  for (const key of prefer) {
    const hit = files.find((f) => f.toLowerCase().includes(key));
    if (hit) return path.join(tools, hit);
  }
  return files[0] ? path.join(tools, files[0]) : '';
}

function isLoopbackUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch { return false; }
}

function resolveOpenAiAsr() {
  const cfg = loadConfig();
  const asr = cfg.asr || {};
  const follow = asr.followLlm !== false;
  const baseUrl = String(asr.baseUrl || (follow ? cfg.llm?.baseUrl : '') || '').trim();
  let apiKey = String(asr.apiKey || (follow ? cfg.llm?.apiKey : '') || '').trim();
  if (!apiKey && isLoopbackUrl(baseUrl)) apiKey = 'local';
  return {
    baseUrl,
    apiKey,
    model: String(asr.model || '').trim(),
  };
}

function transcriptionUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (b.endsWith('/audio/transcriptions')) return b;
  b = b.replace(/\/chat\/completions$/i, '');
  if (b.endsWith('/v1')) return b + '/audio/transcriptions';
  return b + '/v1/audio/transcriptions';
}

/**
 * @returns {{ engine: 'whisper-cpp'|'openai-compat'|null, reason: string }}
 */
export function resolveAsrEngine() {
  const asr = loadConfig().asr || {};
  if (asr.enabled === false) return { engine: null, reason: 'asr.enabled=false' };
  const wanted = String(asr.engine || 'auto').toLowerCase();
  if (wanted === 'off' || wanted === 'none') return { engine: null, reason: 'engine=off' };

  const whisperOk = !!(findWhisperBin() && findWhisperModel());
  const api = resolveOpenAiAsr();
  let apiOk = false;
  let apiReason = '';
  if (api.baseUrl && api.apiKey && api.model) {
    try {
      assertLlmBaseUrl(api.baseUrl);
      apiOk = true;
    } catch (e) {
      apiReason = e.message;
    }
  } else {
    apiReason = '未配置转写模型名 asr.model（聊天模型不能转写；可填 FunAudioLLM/SenseVoiceSmall）';
    if (!api.baseUrl || !api.apiKey) apiReason = '未配置转写 API（asr.baseUrl/apiKey，或开启 followLlm 并配好文本模型）';
  }

  if (wanted === 'whisper-cpp' || wanted === 'whisper') {
    if (!whisperOk) return { engine: null, reason: '未找到 whisper-cli 或 ggml/gguf 模型（放到 tools/ 或填写 asr.whisperBin / whisperModel）' };
    return { engine: 'whisper-cpp', reason: '' };
  }
  if (wanted === 'openai-compat' || wanted === 'openai' || wanted === 'api') {
    if (!apiOk) return { engine: null, reason: apiReason };
    return { engine: 'openai-compat', reason: '' };
  }
  if (whisperOk) return { engine: 'whisper-cpp', reason: '' };
  if (apiOk) return { engine: 'openai-compat', reason: '' };
  return { engine: null, reason: apiReason || '未配置本地 whisper.cpp，也未配置 /v1/audio/transcriptions' };
}

export function describeAsr(cfg = loadConfig()) {
  const a = cfg.asr || {};
  const resolved = resolveAsrEngine();
  const preset = getAsrPreset(a.preset);
  return {
    enabled: a.enabled !== false,
    preset: a.preset || 'auto',
    presetLabel: preset?.label || '',
    engine: a.engine || 'auto',
    resolvedEngine: resolved.engine,
    ready: !!(resolved.engine && a.enabled !== false),
    reason: resolved.reason || '',
    language: a.language || 'zh',
    model: a.model || '未配置',
    followLlm: a.followLlm !== false,
    baseUrl: a.baseUrl || (a.followLlm !== false ? '(跟随文本模型)' : '未配置'),
    apiKey: a.apiKey ? '已配置' : (a.followLlm !== false ? '(跟随文本模型)' : '未配置'),
    whisperBin: findWhisperBin() || '未找到',
    whisperModel: findWhisperModel() || (a.whisperModel ? `未找到(${a.whisperModel})` : '未找到'),
    downloadUrl: preset?.downloadUrl || '',
    timestamps: preset?.timestamps || '',
  };
}

/**
 * 向导/设置页检测：有 ffmpeg 时生成约 1 秒静音 wav 走真实转写路径；
 * 否则退回配置探测，并标明 probe=config。
 */
export async function testAsrConnection() {
  const started = Date.now();
  const asr = describeAsr();
  if (!asr.ready) {
    return {
      ok: false,
      error: asr.reason || '转写未就绪',
      model: asr.resolvedEngine || asr.engine,
      latencyMs: Date.now() - started,
      probe: 'config',
      asr,
    };
  }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return {
      ok: true,
      warning: '仅配置探测：本机没有 ffmpeg，未发送真实音频。配置看起来可用。',
      model: asr.resolvedEngine || asr.engine,
      latencyMs: Date.now() - started,
      probe: 'config',
      asr,
    };
  }
  const wav = path.join(os.tmpdir(), `smr-asr-probe-${process.pid}-${Date.now()}.wav`);
  try {
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:a', 'pcm_s16le', wav]);
    const language = asr.language || 'zh';
    const engine = asr.resolvedEngine;
    try {
      if (engine === 'whisper-cpp') await transcribeWavWhisperCpp(wav, { language });
      else await transcribeWavOpenAiWithFallback(wav, { language });
    } catch (e) {
      const msg = String(e.message || e);
      if (/结果为空|未写出 JSON/.test(msg)) {
        return {
          ok: true,
          warning: '引擎可达，静音样本无文本（正常）',
          model: engine,
          latencyMs: Date.now() - started,
          probe: 'live',
          asr,
        };
      }
      return { ok: false, error: msg, model: engine, latencyMs: Date.now() - started, probe: 'live', asr };
    }
    return { ok: true, model: engine, latencyMs: Date.now() - started, probe: 'live', asr };
  } catch (e) {
    return {
      ok: true,
      warning: '仅配置探测：无法生成测试音频（' + e.message + '）',
      model: asr.resolvedEngine || asr.engine,
      latencyMs: Date.now() - started,
      probe: 'config',
      asr,
    };
  } finally {
    try { fs.unlinkSync(wav); } catch { /* ignore */ }
  }
}

function spawnCapture(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const onAbort = () => {
      try { p.kill(); } catch { /* ignore */ }
      reject(new TaskCancelledError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} 退出码 ${code}: ${(err || out).slice(-500)}`));
    });
  });
}

function spawnFfmpegInfo(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(findFfmpeg(), ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', () => resolve(err));
  });
}

export async function probeDuration(file) {
  try {
    const text = await spawnFfmpegInfo(file);
    const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch { /* ignore */ }
  return 0;
}

async function extractWav(input, output, { start = 0, duration = 0, signal } = {}) {
  const args = ['-y'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', input);
  if (duration > 0) args.push('-t', String(duration));
  args.push('-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output);
  await runFfmpeg(args, { signal });
}

function parseClock(s) {
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const t = String(s || '').trim().replace(',', '.');
  const m = t.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) {
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

function normalizeSegments(raw) {
  if (!raw) return [];
  const out = [];
  const push = (from, to, content) => {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const a = Number(from) || 0;
    let b = Number(to) || 0;
    if (b <= a) b = a + 0.01;
    out.push({ from: a, to: b, content: text });
  };

  if (Array.isArray(raw.transcription)) {
    for (const s of raw.transcription) {
      const from = s?.offsets?.from != null ? s.offsets.from / 1000 : parseClock(s?.timestamps?.from);
      const to = s?.offsets?.to != null ? s.offsets.to / 1000 : parseClock(s?.timestamps?.to);
      push(from, to, s?.text || s?.content);
    }
  }
  if (Array.isArray(raw.segments)) {
    for (const s of raw.segments) {
      push(s.start ?? s.from, s.end ?? s.to, s.text || s.content);
    }
  }
  if (!out.length && typeof raw.text === 'string' && raw.text.trim()) {
    push(0, 0, raw.text);
  }
  return out;
}

function toBcc(segments, { lan = 'zh-CN', engine, model } = {}) {
  const body = (segments || []).map((s) => ({
    from: Math.round(s.from * 1000) / 1000,
    to: Math.round(s.to * 1000) / 1000,
    location: 2,
    content: s.content,
  }));
  return {
    lan,
    source: 'asr',
    engine,
    model: model || '',
    available: ['asr-zh'],
    body: { body },
  };
}

function shiftSegments(segments, offsetSec) {
  return (segments || []).map((s) => ({
    ...s,
    from: s.from + offsetSec,
    to: s.to + offsetSec,
  }));
}

function readJsonIfExists(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

async function transcribeWavWhisperCpp(wavPath, { language, signal }) {
  const bin = findWhisperBin();
  const model = findWhisperModel();
  if (!bin || !model) throw new Error('whisper.cpp 未就绪');
  const prefix = wavPath.replace(/\.wav$/i, '');
  const args = ['-m', model, '-f', wavPath, '-l', language || 'zh', '-oj', '-of', prefix];
  logger.info('whisper.cpp 转写', { bin, model: path.basename(model) });
  await spawnCapture(bin, args, { signal });
  const jsonPath = fs.existsSync(prefix + '.json') ? prefix + '.json' : wavPath + '.json';
  if (!fs.existsSync(jsonPath)) throw new Error('whisper.cpp 未写出 JSON：' + jsonPath);
  const parsed = readJsonIfExists(jsonPath);
  try { fs.unlinkSync(jsonPath); } catch { /* ignore */ }
  const segs = normalizeSegments(parsed);
  if (!segs.length) throw new Error('whisper.cpp 结果为空');
  return segs;
}

async function transcribeWavOpenAi(wavPath, { language, responseFormat = 'verbose_json', signal }) {
  const api = resolveOpenAiAsr();
  const url = transcriptionUrl(assertLlmBaseUrl(api.baseUrl));
  const buf = fs.readFileSync(wavPath);
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(buf)], 'audio.wav', { type: 'audio/wav' }));
  fd.append('model', api.model);
  fd.append('response_format', responseFormat);
  if (language && language !== 'auto') fd.append('language', language);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10 * 60 * 1000);
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.apiKey}` },
      body: fd,
      signal: ac.signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new TaskCancelledError();
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`转写接口 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return [{ from: 0, to: 0, content: text.trim() }];
  }
  return normalizeSegments(parsed);
}

async function transcribeWavOpenAiWithFallback(wavPath, { language, signal }) {
  try {
    return await transcribeWavOpenAi(wavPath, { language, responseFormat: 'verbose_json', signal });
  } catch (e) {
    logger.warn('verbose_json 转写失败，改用 json', { error: e.message });
    return transcribeWavOpenAi(wavPath, { language, responseFormat: 'json', signal });
  }
}

function chunkSeconds() {
  const n = Number(loadConfig().asr?.chunkSeconds) || 600;
  return Math.min(1800, Math.max(60, n));
}

function cleanup(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/**
 * 对任务目录中的音视频做转写，返回 BCC 结构（不写盘）。
 */
export async function transcribeMediaDir(dir, { language, onProgress, signal } = {}) {
  const media = findMediaFile(dir);
  if (!media) throw new Error('任务目录中没有 current.mp4 / current.mp3 / current_audio.m4s，无法转写');
  const { engine, reason } = resolveAsrEngine();
  if (!engine) throw new Error(reason || 'ASR 未配置');
  const lang = language || loadConfig().asr?.language || 'zh';
  const duration = await probeDuration(media);
  let slice = chunkSeconds();
  if (engine === 'openai-compat') slice = Math.min(slice, 720);
  const chunks = duration > slice + 5 ? Math.ceil(duration / slice) : 1;
  const all = [];
  const temps = [];
  logger.info('开始语音转写', { engine, media: path.basename(media), duration, chunks });

  try {
    for (let i = 0; i < chunks; i++) {
      throwIfAborted(signal);
      const start = i * slice;
      const wav = path.join(dir, `asr_chunk_${i}.wav`);
      temps.push(wav);
      onProgress?.({ chunk: i + 1, chunks, message: `转写 ${i + 1}/${chunks}` });
      await extractWav(media, wav, { start, duration: chunks > 1 ? slice : 0, signal });
      if (!fs.existsSync(wav) || fs.statSync(wav).size < 1000) {
        logger.warn('音频切片为空，跳过', { i, wav });
        continue;
      }
      let segs;
      if (engine === 'whisper-cpp') segs = await transcribeWavWhisperCpp(wav, { language: lang, signal });
      else segs = await transcribeWavOpenAiWithFallback(wav, { language: lang, signal });
      const wavDur = await probeDuration(wav);
      segs = segs.map((s) => {
        if (s.to <= s.from && wavDur) return { ...s, to: wavDur };
        return s;
      });
      all.push(...shiftSegments(segs, start));
    }
  } finally {
    cleanup(temps);
  }

  if (!all.length) throw new Error('转写结果为空');
  const api = resolveOpenAiAsr();
  const model = engine === 'whisper-cpp' ? path.basename(findWhisperModel() || '') : api.model;
  return toBcc(all, { lan: lang === 'zh' ? 'zh-CN' : lang, engine, model });
}

function isOfficialSubtitles(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.source === 'asr') return false;
  const arr = Array.isArray(data) ? data : (data.body?.body || data.body || []);
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * 转写并写入 data/<taskId>/subtitles.json
 */
export async function transcribeTask(taskId, { force = false, language, onProgress } = {}) {
  const dir = path.join(DATA_DIR, taskId);
  if (!fs.existsSync(dir)) throw new Error('任务目录不存在: ' + taskId);
  const signal = attachTaskAbort(taskId);
  const meta = readTaskMeta(taskId) || {};
  const statusPath = path.join(dir, '.task-status.json');
  try {
    fs.writeFileSync(statusPath, JSON.stringify({
      taskId, title: meta.title || taskId, type: 'asr', status: 'running',
      pid: process.pid, startedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  try {
    const subPath = path.join(dir, 'subtitles.json');
    if (fs.existsSync(subPath) && !force) {
      const existing = readJsonIfExists(subPath);
      if (isOfficialSubtitles(existing)) {
        throw new Error('已有官方字幕。若要用语音转写覆盖，请加 --force 或 force=true');
      }
      if (existing?.source === 'asr') {
        return { skipped: true, reason: 'already-asr', file: subPath, engine: existing.engine };
      }
    }
    const result = await transcribeMediaDir(dir, { language, onProgress, signal });
    fs.writeFileSync(subPath, JSON.stringify(result, null, 2), 'utf8');
    try {
      const allPath = path.join(dir, 'bilibili_all.json');
      if (fs.existsSync(allPath)) {
        const all = JSON.parse(fs.readFileSync(allPath, 'utf8'));
        all.stats = { ...(all.stats || {}), subtitles: true, subtitleSource: 'asr' };
        fs.writeFileSync(allPath, JSON.stringify(all, null, 2), 'utf8');
      }
    } catch { /* ignore */ }
    logger.info('语音转写完成', { taskId, cues: result.body?.body?.length, engine: result.engine });
    return { skipped: false, file: subPath, engine: result.engine, cues: result.body?.body?.length || 0 };
  } catch (e) {
    if (e instanceof TaskCancelledError || e.code === 'cancelled' || String(e.message || '').includes('任务已取消')) {
      logger.warn('语音转写已取消', { taskId });
      throw e;
    }
    throw e;
  } finally {
    try { fs.unlinkSync(statusPath); } catch { /* ignore */ }
  }
}
