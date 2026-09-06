// platforms/youtube/crawl.js — YouTube 采集编排（视频 / 播单 / 频道）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';
import { loadConfig } from '../../config.js';
import {
  createTask, markTaskCompleted, markTaskFailed, markTaskCancelled, shouldSkipTask, sanitizeName, taskDir,
  getTaskAbortSignal, isCancelledError, throwIfAborted, linkChildAbort, updateTaskProgress,
} from '../../task.js';
import { resolveAsrEngine, transcribeMediaDir } from '../../asr.js';
import {
  getVideoInfo, getCommentThreads, getCaptionTracks, parseYoutubeInput,
  getPlaylistItems, getChannelUploads,
} from './api.js';
import {
  downloadYoutubeMedia, findYtDlp,
  ytdlpDumpJson, ytdlpInfoFromDump, ytdlpCommentsFromDump, ytdlpCaptionTracksFromDump,
} from './download.js';

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

export async function crawlYoutubeVideo(videoId, opts = {}) {
  logger.info('开始采集 YouTube 视频', { videoId });

  // 双路线：有 Google API key 走 Data API；没有则自动退化为 yt-dlp（元数据/评论/字幕轨）
  const hasApiKey = !!loadConfig().youtube.apiKey;
  let info = null;
  let dump = null;
  if (hasApiKey) {
    info = await getVideoInfo(videoId);
  } else {
    logger.info('未配置 youtube.apiKey，走 yt-dlp 元数据/评论回退', { videoId });
    dump = await ytdlpDumpJson(videoId, { comments: true, maxComments: opts.commentCount ?? 200 });
    if (!dump) {
      throw new Error('未配置 youtube.apiKey 且未找到 yt-dlp：请申请免费 Google API key 填入 config.json → youtube.apiKey，或下载 yt-dlp.exe 放到 tools/ 目录');
    }
    info = ytdlpInfoFromDump(dump);
  }
  const taskId = `${sanitizeName(info.title)}-${videoId}`;
  const skip = shouldSkipTask(taskId);
  if (skip.shouldSkip) {
    logger.info('任务已存在，跳过', { taskId, status: skip.status });
    return { taskId, dir: taskDir(taskId), skipped: true, status: skip.status };
  }

  const dir = taskDir(taskId);
  createTask(taskId, {
    title: info.title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    type: 'youtube',
    options: opts,
  });
  if (opts.parentTaskId) linkChildAbort(opts.parentTaskId, taskId);
  fs.mkdirSync(dir, { recursive: true });

  const stats = { comments: 0, subtitles: 0, detail: true, video: false };
  const signal = getTaskAbortSignal(taskId);
  try {
    writeJson(path.join(dir, 'youtube_detail.json'), info);

    throwIfAborted(signal);
    let comments = [];
    if (hasApiKey) {
      comments = await getCommentThreads(videoId, {
        maxResults: opts.commentCount ?? 100,
        maxReplies: opts.subCommentCount ?? 5,
      });
      stats.commentSource = 'data-api';
    } else {
      comments = ytdlpCommentsFromDump(dump, opts.commentCount ?? 200);
      stats.commentSource = 'yt-dlp';
    }
    writeJson(path.join(dir, 'youtube_comments.json'), comments);
    stats.comments = comments.length;

    const tracks = hasApiKey
      ? await getCaptionTracks(videoId)
      : ytdlpCaptionTracksFromDump(dump);
    if (tracks.length) {
      writeJson(path.join(dir, 'youtube_captions.json'), tracks);
      stats.subtitles = tracks.length;
    }

    const wantVideo = opts.fetchVideo !== false;
    const wantAudio = opts.fetchAudio !== false;
    let officialSubs = fs.existsSync(path.join(dir, 'subtitles.json'));
    if (wantVideo || wantAudio) {
      throwIfAborted(signal);
      const dl = await downloadYoutubeMedia(videoId, dir, { wantVideo, wantAudio, signal });
      stats.video = !!(dl.video || dl.audio);
      if (dl.subtitles) {
        officialSubs = true;
        stats.subtitles = true;
      }
    } else if (!findYtDlp()) {
      logger.info('未勾选下载，跳过 yt-dlp', { videoId });
    }

    const asrCfgOn = loadConfig().asr?.enabled !== false;
    const asrWanted = asrCfgOn && !opts.noAsr && !opts.noSubtitles;
    const needAsr = asrWanted && !officialSubs && !!resolveAsrEngine().engine
      && (fs.existsSync(path.join(dir, 'current.mp4')) || fs.existsSync(path.join(dir, 'current.mp3')));
    if (needAsr) {
      throwIfAborted(signal);
      try {
        const asrSubs = await transcribeMediaDir(dir, { signal });
        writeJson(path.join(dir, 'subtitles.json'), asrSubs);
        stats.subtitles = true;
      } catch (e) {
        if (isCancelledError(e)) throw e;
        logger.warn('YouTube 语音转写失败（继续）', { taskId, error: e.message });
      }
    }

    writeJson(path.join(dir, 'youtube_all.json'), {
      taskId, videoId, title: info.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      info, stats, collectedAt: new Date().toISOString(),
    });
    markTaskCompleted(taskId);
    logger.info('YouTube 采集完成', { taskId, stats });
    return { taskId, dir, skipped: false, stats };
  } catch (e) {
    if (isCancelledError(e)) {
      markTaskCancelled(taskId);
      throw e;
    }
    markTaskFailed(taskId, e.message);
    throw e;
  }
}

async function crawlYoutubeBatch(kind, title, url, videos, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 5);
  const offset = Math.max(0, Number(opts.offset) || 0);
  const window = videos.slice(offset, offset + limit);
  const batchId = `youtube-${kind}-${Date.now()}`;
  createTask(batchId, { title, url, type: 'youtube', options: opts });
  const dir = taskDir(batchId);
  const parentSig = getTaskAbortSignal(batchId);
  const results = [];
  const total = window.length;
  for (const [i, v] of window.entries()) {
    throwIfAborted(parentSig);
    const vid = v.videoId || v;
    logger.info(`YouTube ${kind} 进度 ${i + 1}/${total}`, { videoId: vid });
    updateTaskProgress(batchId, {
      stage: 'youtube-batch', stageLabel: title,
      percent: Math.round((i / Math.max(1, total)) * 100),
      current: offset + i + 1, total: videos.length, message: String(v.title || vid).slice(0, 40),
    });
    try {
      const r = await crawlYoutubeVideo(vid, { ...opts, parentTaskId: batchId });
      results.push({ videoId: vid, title: v.title, ...r });
    } catch (e) {
      if (isCancelledError(e)) { markTaskCancelled(batchId); throw e; }
      logger.error('YouTube 子任务失败（继续）', { videoId: vid, error: e.message });
      results.push({ videoId: vid, title: v.title, failed: true, error: e.message });
    }
  }
  writeJson(path.join(dir, 'youtube_all.json'), {
    type: kind, batchId, title, url, offset, limit,
    videoCount: videos.length, window: window.length,
    results: results.map((r) => ({ videoId: r.videoId, title: r.title, taskId: r.taskId, failed: r.failed, error: r.error })),
    createdAt: new Date().toISOString(),
  });
  markTaskCompleted(batchId);
  logger.info(`YouTube ${kind} 采集完成`, { title, done: results.filter((r) => !r.failed).length });
  return { taskId: batchId, dir, results };
}

export async function crawlYoutube(input, opts = {}) {
  const parsed = parseYoutubeInput(input);
  if (parsed.type === 'playlist') {
    const needed = Math.max(1, Number(opts.limit) || 5) + Math.max(0, Number(opts.offset) || 0);
    const items = await getPlaylistItems(parsed.playlistId, { max: needed });
    if (!items.length) throw new Error('播放列表为空: ' + parsed.playlistId);
    const url = `https://www.youtube.com/playlist?list=${parsed.playlistId}`;
    return crawlYoutubeBatch('playlist', `YouTube 播单 ${parsed.playlistId}`, url, items, opts);
  }
  if (parsed.type === 'channel') {
    const needed = Math.max(1, Number(opts.limit) || 5) + Math.max(0, Number(opts.offset) || 0);
    const ch = await getChannelUploads({
      handle: parsed.handle, channelId: parsed.channelId, max: needed,
    });
    const url = parsed.handle
      ? `https://www.youtube.com/@${parsed.handle}`
      : `https://www.youtube.com/channel/${ch.channelId}`;
    return crawlYoutubeBatch('channel', `YouTube 频道 ${ch.title}`, url, ch.videos, opts);
  }
  if (parsed.type === 'video') return crawlYoutubeVideo(parsed.videoId, opts);
  throw new Error('无法识别 YouTube 链接或 ID: ' + input);
}
