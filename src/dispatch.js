// dispatch.js — 按输入路由到 B 站或 YouTube 采集
'use strict';

import { crawlBilibili } from './platforms/bilibili/crawl.js';

export function looksLikeYoutube(input) {
  const s = String(input || '').trim();
  if (/youtu\.be\/|(?:^|\/\/)(?:www\.|m\.|music\.)?youtube\.com\//i.test(s)) return true;
  if (/^BV/i.test(s)) return false;
  return /^[A-Za-z0-9_-]{11}$/.test(s);
}

export async function crawlInput(input, opts = {}) {
  if (looksLikeYoutube(input)) {
    const { crawlYoutube } = await import('./platforms/youtube/crawl.js');
    return crawlYoutube(input, opts);
  }
  return crawlBilibili(input, opts);
}
