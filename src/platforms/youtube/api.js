// platforms/youtube/api.js — YouTube Data API v3（需要 Google API key）
// 凭据: config.json → youtube.apiKey，或环境变量 SMR_YOUTUBE_API_KEY
'use strict';

import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';

export function getApiKey() {
  const key = loadConfig().youtube.apiKey;
  if (!key) throw new Error('YouTube API key 未配置: 设置 config.json 的 youtube.apiKey 或环境变量 SMR_YOUTUBE_API_KEY');
  return key;
}

export function parseVideoId(input) {
  const s = String(input).trim();
  const m = s.match(/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  return m ? m[1] : /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

/** 识别视频 / 播单 / 频道（含裸 11 位 ID） */
export function parseYoutubeInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { type: 'unknown', raw };

  const handle = raw.match(/youtube\.com\/@([^/?#]+)/i);
  if (handle) return { type: 'channel', handle: decodeURIComponent(handle[1]), raw };
  const ch = raw.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/i);
  if (ch) return { type: 'channel', channelId: ch[1], raw };

  const list = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
  const playlistPage = /youtube\.com\/playlist/i.test(raw);
  if (list && (playlistPage || /^(PL|OL|UU)/.test(list[1]))) {
    return { type: 'playlist', playlistId: list[1], videoId: parseVideoId(raw), raw };
  }

  const videoId = parseVideoId(raw);
  if (videoId) return { type: 'video', videoId, raw };
  return { type: 'unknown', raw };
}

async function ytGet(pathname, params, { signal } = {}) {
  const key = getApiKey();
  const qs = new URLSearchParams({ ...params, key });
  const res = await fetch(`https://youtube.googleapis.com/youtube/v3${pathname}?${qs}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await res.json();
  if (data.error) throw new Error('YouTube API 错误: ' + (data.error.message || JSON.stringify(data.error).slice(0, 200)));
  return data;
}

/** 视频信息（含统计、字幕轨道可用性） */
export async function getVideoInfo(videoId) {
  const data = await ytGet('/videos', {
    part: 'snippet,contentDetails,statistics', id: videoId,
  });
  const v = data.items?.[0];
  if (!v) throw new Error('视频不存在或不可用: ' + videoId);
  return {
    id: v.id,
    title: v.snippet?.title || '',
    description: v.snippet?.description || '',
    channel: v.snippet?.channelTitle || '',
    channelId: v.snippet?.channelId || '',
    publishedAt: v.snippet?.publishedAt || '',
    duration: v.contentDetails?.duration || '',
    viewCount: v.statistics?.viewCount, likeCount: v.statistics?.likeCount,
    commentCount: v.statistics?.commentCount,
    thumbnails: v.snippet?.thumbnails || {},
  };
}

/** 评论线程（含回复） */
export async function getCommentThreads(videoId, { maxResults = 100, maxReplies = 5 } = {}) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 10 && out.length < maxResults; i++) {
    const data = await ytGet('/commentThreads', {
      part: 'snippet,replies', videoId, maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    const items = data.items || [];
    for (const it of items) {
      const top = it.snippet?.topLevelComment?.snippet || {};
      out.push({
        id: it.id, user: top.authorDisplayName || '', like: top.likeCount || 0,
        content: top.textDisplay || '', publishedAt: top.publishedAt || '',
      });
      const replies = (it.replies?.comments || []).slice(0, maxReplies);
      for (const r of replies) {
        out.push({
          id: r.id, user: r.snippet?.authorDisplayName || '', like: r.snippet?.likeCount || 0,
          content: r.snippet?.textDisplay || '', publishedAt: r.snippet?.publishedAt || '',
          parent: it.id,
        });
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken || !items.length) break;
  }
  return out;
}

/** 字幕轨道列表（v3 captions 需 OAuth，公开只读场景通常拿不到；这里做探测并降级） */
export async function getCaptionTracks(videoId) {
  try {
    const data = await ytGet('/captions', { part: 'snippet', videoId });
    return (data.items || []).map((c) => ({
      id: c.id, language: c.snippet?.language, name: c.snippet?.name || '',
      trackKind: c.snippet?.trackKind,
    }));
  } catch (e) {
    logger.warn('字幕轨道探测失败（多数情况需 OAuth，忽略）', { videoId, error: e.message });
    return [];
  }
}

export { ytGet };

/** 播放列表条目（串行分页，最多 max 条） */
export async function getPlaylistItems(playlistId, { max = 50, signal } = {}) {
  const out = [];
  let pageToken = '';
  const cap = Math.max(1, Math.min(200, max));
  while (out.length < cap) {
    const data = await ytGet('/playlistItems', {
      part: 'contentDetails,snippet',
      playlistId,
      maxResults: String(Math.min(50, cap - out.length)),
      ...(pageToken ? { pageToken } : {}),
    }, { signal });
    for (const it of data.items || []) {
      const id = it.contentDetails?.videoId;
      if (id) out.push({ videoId: id, title: it.snippet?.title || '', position: it.snippet?.position });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken || !(data.items || []).length) break;
  }
  return out;
}

/** 频道上传列表（forHandle / channelId → uploads 播单） */
export async function getChannelUploads({ handle, channelId, max = 50, signal } = {}) {
  let id = channelId || '';
  if (!id && handle) {
    const h = String(handle).replace(/^@/, '');
    try {
      const data = await ytGet('/channels', { part: 'id,contentDetails,snippet', forHandle: h }, { signal });
      id = data.items?.[0]?.id || '';
    } catch { /* 旧 key 可能不支持 forHandle */ }
    if (!id) {
      const data = await ytGet('/search', { part: 'snippet', q: '@' + h, type: 'channel', maxResults: '1' }, { signal });
      id = data.items?.[0]?.snippet?.channelId || data.items?.[0]?.id?.channelId || '';
    }
  }
  if (!id) throw new Error('无法解析 YouTube 频道: ' + (handle || channelId || ''));
  const ch = await ytGet('/channels', { part: 'contentDetails,snippet', id }, { signal });
  const item = ch.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('频道没有可列出的上传列表: ' + id);
  const videos = await getPlaylistItems(uploads, { max, signal });
  return {
    channelId: id,
    title: item?.snippet?.title || handle || id,
    uploads,
    videos,
  };
}
