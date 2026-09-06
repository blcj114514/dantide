// platforms/youtube/download.js — 本机 yt-dlp 下片 / 拉字幕（无则跳过，不抛错）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { TaskCancelledError } from '../../task.js';

export function findYtDlp() {
  const cfg = loadConfig().youtube || {};
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const cands = [cfg.ytdlpPath, path.join(ROOT, 'tools', exe)].filter(Boolean);
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['yt-dlp'], { encoding: 'utf8', windowsHide: true });
    const p = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }
  return '';
}

function parseClock(s) {
  const t = String(s || '').trim().replace(',', '.');
  const m = t.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

export function vttToBcc(text, { lan = 'zh-CN' } = {}) {
  const body = [];
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const m = block.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]+)/);
    if (!m) continue;
    const content = m[3].replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
    if (!content || content === 'WEBVTT') continue;
    body.push({
      from: Math.round(parseClock(m[1]) * 1000) / 1000,
      to: Math.round(parseClock(m[2]) * 1000) / 1000,
      location: 2,
      content,
    });
  }
  return { lan, source: 'youtube', available: [lan], body: { body } };
}

function spawnYtDlp(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    logger.info('调用 yt-dlp', { bin, args: args.join(' ') });
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    const onAbort = () => {
      try { p.kill(); } catch { /* ignore */ }
      reject(new TaskCancelledError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp 退出码 ${code}: ${err.slice(-400)}`));
    });
  });
}

function pickVtt(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.vtt$/i.test(f));
  const score = (f) => {
    const n = f.toLowerCase();
    if (/zh-hans|zh-cn|zh_cn/.test(n)) return 0;
    if (/(^|[._-])zh/.test(n)) return 1;
    if (/(^|[._-])en/.test(n)) return 2;
    return 3;
  };
  files.sort((a, b) => score(a) - score(b));
  return files[0] ? path.join(dir, files[0]) : '';
}

/**
 * 下载 YouTube 视频/音频与字幕。无 yt-dlp 时 skipped+reason，不抛错。
 */
export async function downloadYoutubeMedia(videoId, dir, {
  wantVideo = true, wantAudio = true, signal,
} = {}) {
  const bin = findYtDlp();
  if (!bin) {
    logger.info('未找到 yt-dlp，跳过下片', { videoId, hint: '将 yt-dlp 放到 tools/ 或配置 youtube.ytdlpPath' });
    return { skipped: true, reason: 'no-ytdlp' };
  }

  const mp4 = path.join(dir, 'current.mp4');
  const mp3 = path.join(dir, 'current.mp3');
  if (wantVideo && fs.existsSync(mp4)) {
    logger.info('YouTube 媒体已存在，跳过下载', { mp4 });
    return { skipped: true, reason: 'exists', video: mp4, audio: mp4, merged: true };
  }
  if (!wantVideo && wantAudio && fs.existsSync(mp3)) {
    return { skipped: true, reason: 'exists', video: null, audio: mp3, merged: true };
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outTpl = path.join(dir, 'current.%(ext)s');
  const args = [
    '--no-playlist', '--no-warnings', '-o', outTpl,
    '--write-subs', '--write-auto-subs',
    '--sub-langs', 'zh-Hans,zh-CN,zh.*,en.*,en',
    '--convert-subs', 'vtt',
  ];
  if (wantVideo) {
    args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
  } else {
    args.push('-f', 'ba', '-x', '--audio-format', 'mp3');
  }
  args.push(url);

  try {
    await spawnYtDlp(bin, args, { signal });
  } catch (e) {
    if (e instanceof TaskCancelledError || e.code === 'cancelled') throw e;
    logger.warn('yt-dlp 下片失败，继续只保留元数据/评论', { videoId, error: e.message });
    return { skipped: true, reason: 'ytdlp-failed', error: e.message };
  }

  const video = fs.existsSync(mp4) ? mp4 : null;
  const audio = video || (fs.existsSync(mp3) ? mp3 : null);

  let subtitles = null;
  const vtt = pickVtt(dir);
  if (vtt) {
    try {
      const bcc = vttToBcc(fs.readFileSync(vtt, 'utf8'), { lan: /en/i.test(path.basename(vtt)) ? 'en' : 'zh-CN' });
      if (bcc.body.body.length) {
        fs.writeFileSync(path.join(dir, 'subtitles.json'), JSON.stringify(bcc, null, 2), 'utf8');
        subtitles = path.join(dir, 'subtitles.json');
      }
    } catch (e) {
      logger.warn('YouTube 字幕转换失败', { vtt, error: e.message });
    }
  }

  return { skipped: false, video, audio, merged: !!video, subtitles };
}

function spawnYtDlpOut(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp 退出码 ${code}: ${err.slice(-300)}`));
        return;
      }
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('yt-dlp JSON 解析失败: ' + e.message)); }
    });
  });
}

/**
 * yt-dlp 元数据 JSON 直出（--dump-single-json），可选抓取评论。
 * 未找到 yt-dlp 时返回 null（调用方决定回退策略）。
 */
export async function ytdlpDumpJson(videoId, { comments = false, maxComments = 200 } = {}) {
  const bin = findYtDlp();
  if (!bin) return null;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const args = ['--dump-single-json', '--no-playlist', '--no-warnings'];
  if (comments) {
    args.push('--write-comments');
    args.push('--extractor-args', `youtube:max_comments=${Math.max(10, Number(maxComments) || 200)},0;comment_sort=top`);
  }
  args.push(url);
  try {
    return await spawnYtDlpOut(bin, args);
  } catch (e) {
    logger.warn('yt-dlp 元数据获取失败', { videoId, error: String(e.message || e).slice(-300) });
    return null;
  }
}

/** dump JSON → 与 Data API 同构的视频信息（无 key 时回退用） */
export function ytdlpInfoFromDump(dump) {
  const d = dump || {};
  const dur = Number(d.duration);
  const iso = Number.isFinite(dur) && dur > 0
    ? `PT${Math.floor(dur / 3600)}H${Math.floor((dur % 3600) / 60)}M${Math.round(dur % 60)}S`
    : '';
  return {
    id: d.id || '',
    title: d.title || '',
    description: d.description || '',
    channel: d.uploader || d.channel || '',
    channelId: d.uploader_id || d.channel_id || '',
    publishedAt: d.upload_date
      ? `${d.upload_date.slice(0, 4)}-${d.upload_date.slice(4, 6)}-${d.upload_date.slice(6, 8)}`
      : '',
    duration: iso,
    durationSeconds: Number.isFinite(dur) ? dur : undefined,
    viewCount: d.view_count, likeCount: d.like_count,
    commentCount: d.comment_count,
    thumbnails: Array.isArray(d.thumbnails) && d.thumbnails.length
      ? { source: d.thumbnails[d.thumbnails.length - 1] } : {},
    source: 'yt-dlp',
  };
}

/** dump JSON → 与 Data API 同构的评论列表（按点赞降序，截断到 cap） */
export function ytdlpCommentsFromDump(dump, cap = 200) {
  const list = Array.isArray(dump?.comments) ? dump.comments.slice() : [];
  list.sort((a, b) => (Number(b.like_count) || 0) - (Number(a.like_count) || 0));
  return list.slice(0, Math.max(1, cap)).map((c) => ({
    id: c.id || '',
    user: c.author || '',
    like: Number(c.like_count) || 0,
    content: c.text || '',
    publishedAt: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : '',
    parent: c.parent && c.parent !== 'root' ? c.parent : undefined,
  })).filter((c) => c.content);
}

/** dump JSON → 字幕轨列表（官方全部收录；自动字幕只保留中英避免噪音） */
export function ytdlpCaptionTracksFromDump(dump) {
  const d = dump || {};
  const tracks = [];
  for (const lang of Object.keys(d.subtitles || {})) {
    tracks.push({ id: 'sub:' + lang, language: lang, name: lang, trackKind: 'official' });
  }
  for (const lang of Object.keys(d.automatic_captions || {})) {
    if (/^(zh|en)/i.test(lang)) tracks.push({ id: 'auto:' + lang, language: lang, name: lang, trackKind: 'asr' });
  }
  return tracks;
}
