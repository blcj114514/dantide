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
