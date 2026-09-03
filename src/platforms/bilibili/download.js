// platforms/bilibili/download.js — 视频/音频下载（playurl DASH 流 + ffmpeg 合并）
// 输出: current.mp4（合并后）/ current_video.m4s + current_audio.m4s（未合并时保留分片）
// ffmpeg 来源: config.crawl.ffmpegPath > 环境变量 FFMPEG_PATH > 系统 PATH
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { apiGet, getWbiKeys, wbiUrl, UA, BASE_HEADERS } from './api.js';

export function findFfmpeg() {
  const cfg = loadConfig();
  if (cfg.crawl?.ffmpegPath && fs.existsSync(cfg.crawl.ffmpegPath)) return cfg.crawl.ffmpegPath;
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  return 'ffmpeg'; // 依赖系统 PATH
}

/** 获取播放地址（DASH 或 durl 老格式） */
export async function getPlayUrl({ bvid, cid }) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/player/playurl', {
    bvid, cid, fnval: 4048, fnver: 0, fourk: 1,
  }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`playurl 失败: ${json.code} ${json.message || ''}`);
  return json.data;
}

/** 清晰度名称 → DASH 流 id 映射 */
const QUALITY_MAP = {
  '240p': 6, '360p': 16, '480p': 32, '720p': 64, '720p60': 74,
  '1080p': 80, '1080p+': 112, '1080p60': 116, '4k': 120, 'hdr': 125, '8k': 127,
  'lowest': -1, 'highest': 9999,
};

/**
 * 选择分片: 优先 dash（视频+音频分离），兜底 durl
 * 清晰度策略（默认 1080p）:
 *   - preferHighQuality: 取最高可用（可能命中大会员码率）
 *   - quality: 目标清晰度（名称或数字 id）→ 取 >= 目标的最低流；全部低于目标时取最高可用
 */
export function pickStreams(data, { preferHighQuality = false, quality = '1080p' } = {}) {
  if (data?.dash) {
    const videos = (data.dash.video || []).filter((v) => v.baseUrl || v.base_url);
    const audios = (data.dash.audio || []).filter((a) => a.baseUrl || a.base_url);
    if (!videos.length || !audios.length) return null;
    videos.sort((a, b) => (a.id || 0) - (b.id || 0));
    // 同清晰度存在多个码率变体时取带宽最大的
    const bestOf = (list) => list.reduce((a, b) => ((b.bandwidth || 0) > (a.bandwidth || 0) ? b : a));
    const isHighest = String(quality).toLowerCase() === 'highest';
    let video;
    let target = null;
    if (preferHighQuality || isHighest) {
      const maxId = videos[videos.length - 1].id;
      video = bestOf(videos.filter((v) => v.id === maxId));
    } else {
      const num = Number(quality);
      target = Number.isFinite(num) ? num : (QUALITY_MAP[String(quality).toLowerCase()] ?? 80);
      if (target < 0) {
        video = bestOf(videos.filter((v) => v.id === videos[0].id)); // lowest: 省流量
      } else {
        // 先取 >= 目标的最低清晰度，再在该清晰度内选带宽最大的；全部低于目标则取最高可用
        const candidates = videos.filter((v) => (v.id || 0) >= target);
        if (candidates.length) {
          const minId = Math.min(...candidates.map((v) => v.id || 0));
          video = bestOf(candidates.filter((v) => v.id === minId));
        } else {
          video = videos[videos.length - 1];
        }
      }
    }
    audios.sort((a, b) => (a.id || 0) - (b.id || 0));
    const audio = String(quality).toLowerCase() === 'lowest'
      ? bestOf(audios.filter((a) => a.id === audios[0].id))
      : bestOf(audios);
    return { type: 'dash', video, audio, chosenId: video?.id, target };
  }
  if (data?.durl?.length) {
    return { type: 'durl', url: data.durl[0].url, size: data.durl[0].size };
  }
  return null;
}

/** 提取一个流的所有可用 URL（主 URL + 备用 URL） */
function streamUrls(stream) {
  if (!stream) return [];
  const backups = stream.backupUrl || stream.backup_url || [];
  return [stream.baseUrl || stream.base_url, ...(Array.isArray(backups) ? backups : [])].filter(Boolean);
}

/**
 * 下载文件到 dest。urls 可按优先级传多个（主 URL + backupUrl），
 * 逐个尝试，每个最多重试 3 次（应对 CDN 限流/网络抖动）。
 * @returns {Promise<number>} 字节数
 */
async function downloadFile(urls, dest, headers, onProgress, signal) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) throw new Error('没有可用的下载地址');
  let lastErr = null;
  for (const [idx, url] of list.entries()) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { code: 'cancelled' });
      try {
        const res = await fetch(url, { headers, redirect: 'follow', signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        let got = 0;
        const ws = fs.createWriteStream(dest);
        const reader = res.body.getReader();
        for (;;) {
          if (signal?.aborted) {
            try { await reader.cancel(); } catch { /* ignore */ }
            try { ws.destroy(); } catch { /* ignore */ }
            throw Object.assign(new Error('任务已取消'), { code: 'cancelled' });
          }
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          ws.write(value);
          if (total && got % (4 * 1024 * 1024) < 1024 * 1024) {
            const pct = Math.round((got / total) * 100);
            logger.info('下载进度', { dest: path.basename(dest), pct });
            onProgress?.(pct);
          }
        }
        await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
        onProgress?.(100);
        return got;
      } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError' || e?.code === 'cancelled') {
          throw Object.assign(new Error('任务已取消'), { code: 'cancelled' });
        }
        lastErr = e;
        logger.warn('下载失败，重试', { url: url.slice(0, 100), urlIndex: idx, attempt, error: e.message });
        await sleep(800 * attempt);
      }
    }
  }
  throw lastErr || new Error('下载失败');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('任务已取消'), { code: 'cancelled' }));
      return;
    }
    const ffmpeg = findFfmpeg();
    logger.info('调用 ffmpeg', { ffmpeg, args: args.join(' ') });
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    const onAbort = () => {
      try { p.kill(); } catch { /* ignore */ }
      reject(Object.assign(new Error('任务已取消'), { code: 'cancelled' }));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-300)}`));
    });
    p.on('error', (e) => reject(e));
  });
}

/**
 * 下载并合并视频。输出到 dir:
 *   current.mp4          — 视频+音频合并（有 ffmpeg 时）
 *   current_video.m4s    — 视频分片（未合并时保留）
 *   current_audio.m4s    — 音频分片（未合并时保留）
 * 已存在检查: current.mp4 / current.mp3 已存在则跳过对应下载
 * @returns {Promise<{video: string|null, audio: string|null, merged: boolean, skipped?: boolean}>}
 */
export async function downloadVideoAndAudio({ bvid, cid, dir, preferHighQuality = false, wantAudio = true, wantVideo = true, quality, onProgress, signal }) {
  const videoPath = path.join(dir, 'current_video.m4s');
  const audioPath = path.join(dir, 'current_audio.m4s');
  const mergedPath = path.join(dir, 'current.mp4');
  const mp3Path = path.join(dir, 'current.mp3');

  // ---- 已存在检查: 避免重复下载（省流量/时间） ----
  if (wantVideo && wantAudio && fs.existsSync(mergedPath)) {
    logger.info('媒体已存在，跳过下载', { mergedPath });
    return { video: mergedPath, audio: mergedPath, merged: true, skipped: true };
  }
  if (wantAudio && !wantVideo && (fs.existsSync(mp3Path) || fs.existsSync(audioPath))) {
    const audio = fs.existsSync(mp3Path) ? mp3Path : audioPath;
    logger.info('音频已存在，跳过下载', { audio });
    return { video: null, audio, merged: true, skipped: true };
  }
  if (wantVideo && !wantAudio && fs.existsSync(mergedPath)) {
    logger.info('视频已存在，跳过下载', { mergedPath });
    return { video: mergedPath, audio: null, merged: true, skipped: true };
  }
  // 未合并的分片已存在: 跳过对应下载，保留合并/补全逻辑
  const skipVideoDl = wantVideo && fs.existsSync(videoPath);
  const skipAudioDl = wantAudio && fs.existsSync(audioPath);
  if (skipVideoDl || skipAudioDl) {
    logger.info('分片已存在，跳过对应下载', { skipVideoDl, skipAudioDl });
  }

  const data = await getPlayUrl({ bvid, cid });
  const cfg = loadConfig().crawl.bilibili || {};
  const finalQuality = quality || cfg.quality || '1080p';
  const streams = pickStreams(data, {
    preferHighQuality,
    quality: finalQuality,
  });
  if (streams?.chosenId) {
    logger.info('选择清晰度', { quality: finalQuality, streamId: streams.chosenId });
  }
  if (!streams) {
    logger.warn('未获取到可下载的流（可能需要更高权限 cookies）', { bvid, cid });
    return { video: null, audio: null, merged: false };
  }
  const headers = { ...BASE_HEADERS, Referer: 'https://www.bilibili.com/', 'User-Agent': UA };

  let videoSaved = null, audioSaved = null;
  try {
    if (streams.type === 'dash') {
      if (wantVideo && !skipVideoDl) {
        const n = await downloadFile(streamUrls(streams.video), videoPath, { ...headers, Referer: 'https://www.bilibili.com/' }, (pct) => onProgress?.({ kind: 'video', pct }), signal);
        videoSaved = videoPath;
        logger.info('视频分片下载完成', { size: n });
      }
      if (wantAudio && !skipAudioDl) {
        const n = await downloadFile(streamUrls(streams.audio), audioPath, { ...headers, Referer: 'https://www.bilibili.com/' }, (pct) => onProgress?.({ kind: 'audio', pct }), signal);
        audioSaved = audioPath;
        logger.info('音频下载完成', { size: n });
      }
      // 仅音频模式: 用 ffmpeg 把 AAC 音轨转成真正的 mp3；无 ffmpeg/失败则保留 m4s（ASR 兼容）
      if (wantVideo === false && audioSaved === audioPath) {
        try {
          await runFfmpeg(['-y', '-i', audioPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', mp3Path], { signal });
          fs.unlinkSync(audioPath);
          audioSaved = mp3Path;
          logger.info('音频已转码为 mp3', { mp3Path });
        } catch (e) {
          if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { code: 'cancelled' });
          logger.warn('音频转码 mp3 失败，保留 m4s 分片', { error: e.message });
          audioSaved = audioPath;
        }
      }
      // 合并
      if (wantVideo && wantAudio && fs.existsSync(videoPath) && fs.existsSync(audioPath)) {
        try {
          await runFfmpeg(['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', mergedPath], { signal });
          logger.info('视频合并完成', { mergedPath });
          fs.unlinkSync(videoPath); fs.unlinkSync(audioPath);
          return { video: mergedPath, audio: mergedPath, merged: true };
        } catch (e) {
          logger.warn('ffmpeg 合并失败，保留分片', { error: e.message });
        }
      }
      return { video: videoSaved, audio: audioSaved, merged: false };
    }
    // durl 老格式: 单文件直接下
    if (wantVideo) {
      const n = await downloadFile(streamUrls({ baseUrl: streams.url }), path.join(dir, 'current.mp4'), headers, undefined, signal);
      videoSaved = path.join(dir, 'current.mp4');
      logger.info('视频(durl)下载完成', { size: n });
    }
    return { video: videoSaved, audio: null, merged: true };
  } catch (e) {
    logger.warn('下载失败（保留已下载部分）', { error: e.message });
    return { video: videoSaved, audio: audioSaved, merged: false, error: e.message };
  }
}
