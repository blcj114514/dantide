// platforms/bilibili/api.js — B站 API 客户端（请求节奏/重试/WBI 签名/凭据注入）
'use strict';

import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { generateWbiUrl, parseKeyPair } from './wbi.js';
import { decodeDanmaku } from './danmaku.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 请求节奏（300±400ms 随机延迟），429 或 -502/-503/-504 瞬时故障时指数退避重试 */
const TRANSIENT_CODES = new Set([-502, -503, -504]);
export async function apiGet(url, { retries = 3, cookies } = {}) {
  const cfg = loadConfig();
  const delay = cfg.crawl.requestDelay;
  const cookie = cookies ?? cfg.cookies.bilibili;
  const headers = { ...BASE_HEADERS };
  if (cookie) headers.Cookie = cookie;
  for (let attempt = 1; ; attempt++) {
    await sleep(delay.base + Math.floor(Math.random() * delay.random));
    const res = await fetch(url, { headers });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { code: -1, message: 'non-json: ' + text.slice(0, 80) }; }
    const transient = res.status === 429 || TRANSIENT_CODES.has(json.code);
    if (transient && attempt <= retries) {
      logger.warn('B站接口瞬时不稳，退避重试', { attempt, status: res.status, code: json.code, url: String(url).slice(0, 120) });
      await sleep(2000 * attempt);
      continue;
    }
    if (json.code === -412) logger.warn('B站风控提示 -412', { url });
    if (json.code === -101) logger.warn('B站登录态已失效（-101 账号未登录），请更新 config.json 的 cookies.bilibili（SESSDATA 等）', { url });
    return { status: res.status, json };
  }
}

// ---- WBI 密钥管理（缓存 120 分钟） ----
let wbiCache = { keys: null, timestamp: 0 };
const WBI_CACHE_DURATION = 120 * 60 * 1000;

export async function getWbiKeys({ force = false } = {}) {
  if (!force && wbiCache.keys && Date.now() - wbiCache.timestamp < WBI_CACHE_DURATION) {
    return wbiCache.keys;
  }
  // 1) 配置中的密钥对（插件/手动维护）
  const cfg = loadConfig();
  if (cfg.bilibili?.wbiKeys) {
    const keys = parseKeyPair(cfg.bilibili.wbiKeys);
    if (keys) { wbiCache = { keys, timestamp: Date.now() }; return keys; }
  }
  // 2) nav 接口（登录 Cookie 可选）
  // 注意：匿名或 cookie 失效时 nav 返回 -101，但 data.wbi_img 仍有效——只以 wbi_img 是否存在为准
  const { json } = await apiGet('https://api.bilibili.com/x/web-interface/nav');
  if (json.data?.wbi_img) {
    const keys = parseKeyPair(`${json.data.wbi_img.img_url}-${json.data.wbi_img.sub_url}`);
    if (keys) { wbiCache = { keys, timestamp: Date.now() }; return keys; }
  }
  throw new Error(`无法获取 WBI 密钥 (nav: ${json.code} ${json.message || ''})，请检查 cookies 或网络`);
}

export function wbiUrl(baseUrl, params, keys) {
  return generateWbiUrl(baseUrl, params, keys || wbiCache.keys);
}

// ---- URL / BV 解析 ----
export function extractBvid(input) {
  const m = String(input).match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

export function parseUrl(input) {
  const s = String(input).trim();
  const lower = s.toLowerCase();
  const bvid = extractBvid(s);
  if (lower.includes('space.bilibili.com')) {
    const mid = s.match(/space\.bilibili\.com\/(\d+)/);
    const sid = s.match(/[?&]sid=(\d+)/);
    if (sid) return { type: 'collection', bvid: null, mid: mid?.[1] || null, sid: sid[1], raw: s };
    return { type: 'uploader', bvid: null, mid: mid?.[1] || null, raw: s };
  }
  if (lower.includes('search.bilibili.com')) {
    const kw = s.match(/keyword=([^&]+)/);
    return { type: 'search', bvid: null, keyword: kw ? decodeURIComponent(kw[1]) : null, raw: s };
  }
  if (lower.includes('/v/popular/weekly')) {
    const num = s.match(/num=(\d+)/);
    return { type: 'weekly', bvid: null, number: num ? Number(num[1]) : null, raw: s };
  }
  if (lower.includes('/v/popular/')) return { type: 'popular', bvid: null, raw: s };
  if (lower.includes('/history')) return { type: 'history', bvid: null, raw: s };
  if (lower.includes('bangumi') || lower.includes('/ep')) return { type: 'bangumi', bvid: null, raw: s };
  if (lower.includes('/recommend') || lower.includes('/video/recommend')) {
    return { type: 'recommend', bvid: null, raw: s };
  }
  if (bvid) return { type: 'video', bvid, raw: s };
  return { type: 'unknown', raw: s };
}

// ---- 详情 / 分P ----
export async function getVideoDetail(bvid) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/view', { bvid }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`view 接口失败: ${json.code} ${json.message || ''}`);
  return json.data;
}

// ---- 弹幕 ----
export async function crawlDanmaku({ oid, duration, maxCount = 2000, onProgress }) {
  const all = [];
  const segments = Math.min(100, Math.max(1, Math.ceil((duration || 600) / 360)));
  for (let idx = 1; idx <= segments; idx++) {
    const url = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${oid}&segment_index=${idx}`;
    const res = await fetch(url, { headers: BASE_HEADERS });
    if (res.status !== 200) break;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) break;
    const elems = decodeDanmaku(buf);
    if (elems.length === 0) break;
    const need = maxCount - all.length;
    if (need <= 0) break;
    all.push(...elems.slice(0, need));
    onProgress?.(all.length);
    if (all.length >= maxCount) break;
    await sleep(300 + Math.floor(Math.random() * 400));
  }
  return all;
}

// ---- 评论（主评论 + 楼中楼） ----
export async function crawlComments({ oid, commentCount = 1000, subCommentCount = 20, onProgress }) {
  const out = [];
  let next = 0;
  for (let page = 0; page < 20 && out.length < commentCount; page++) {
    // 接口非 0 码且不是 -404(真无评论) 时重试一次（风控/网络抖动）
    let json = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const keys = await getWbiKeys();
      const url = wbiUrl('https://api.bilibili.com/x/v2/reply/wbi/main', {
        type: 1, mode: 3, next, oid, plat: 1,
      }, keys);
      const r = await apiGet(url);
      json = r.json;
      if (json.code === 0 || json.code === -404 || attempt === 2) break;
      logger.warn('主评论接口失败，重试', { code: json.code, message: json.message, attempt });
      await sleep(1500);
    }
    if (json.code !== 0) { logger.warn('主评论接口', { code: json.code, message: json.message }); break; }
    const replies = json.data?.replies || [];
    for (const r of replies) {
      out.push({
        rpid: String(r.rpid), user: r.member?.uname || '', like: r.like,
        content: r.content?.message || '', ctime: r.ctime, replyCount: r.count || r.rcount || 0,
      });
      const subTotal = r.count || r.rcount || 0;
      if (subCommentCount > 0 && subTotal > 0) {
        // 精确抓取: 每主评论最多 subCommentCount 条楼中楼
        const want = Math.min(subCommentCount, subTotal);
        const ps = Math.min(30, want);
        const subPages = Math.ceil(want / ps);
        for (let pn = 1; pn <= subPages && out.length < commentCount; pn++) {
          const subUrl = `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=1&root=${r.rpid}&ps=${ps}&pn=${pn}`;
          const s = await apiGet(subUrl);
          const subs = s.json?.data?.replies || [];
          if (!subs.length) break;
          for (const sr of subs) {
            out.push({
              rpid: String(sr.rpid), user: sr.member?.uname || '', like: sr.like,
              content: sr.content?.message || '', ctime: sr.ctime, parent: String(r.rpid),
            });
            if (out.length >= commentCount) break;
          }
        }
      }
    }
    onProgress?.(out.length);
    const cursor = json.data?.cursor;
    next = cursor?.next || 0;
    if (!replies.length || !cursor || cursor.is_end) break;
  }
  return out;
}

// ---- 官方字幕（多语言优先级: 人工中文 > AI中文 > 其他中文 > 英文 > 其他；失败自动重试） ----
export async function crawlSubtitles({ aid, cid }) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/player/wbi/v2', {
    aid: Number(aid), cid: Number(cid), isGaiaAvoided: false,
  }, keys);
  const { json } = await apiGet(url);
  const subs = json?.data?.subtitle?.subtitles || [];
  if (!subs.length) return null;
  // 优先级: 人工中文(zh-CN/zh-TW…) > AI中文(ai-zh) > 其他中文 > 英文 > 其他
  const pick =
    subs.find((s) => /^zh/i.test(s.lan) && !/^ai-/i.test(s.lan)) ||
    subs.find((s) => /^ai-/i.test(s.lan)) ||
    subs.find((s) => /^zh/i.test(s.lan)) ||
    subs.find((s) => /^en/i.test(s.lan)) ||
    subs[0];
  if (!pick?.subtitle_url) return null;
  const full = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url;
  // 抓取失败重试一次（偶发网络/CDN 抖动）
  let res = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    res = await fetch(full, { headers: BASE_HEADERS });
    if (res.status === 200) break;
    if (attempt === 1) await sleep(1000);
  }
  if (res.status !== 200) return null;
  return { lan: pick.lan, available: subs.map((s) => s.lan), body: await res.json() };
}

// ---- AI 总结 ----
export async function crawlAiSummary({ aid, bvid, cid, upMid }) {
  const keys = await getWbiKeys();
  const params = { cid: String(cid), up_mid: String(upMid) };
  if (aid) params.aid = String(aid); else params.bvid = bvid;
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/view/conclusion/get', params, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0 || !json.data?.model_result) return null;
  const mr = json.data.model_result;
  return {
    summary: mr.summary || '',
    outline: mr.outline || [],
    subtitle: mr.subtitle || [],
    likeNum: json.data.like_num || 0,
  };
}

// ---- 合集（高中数学大合集等） ----
/** 合集基本信息（seasons_archives_list 第一页的 meta） */
export async function getCollectionInfo({ mid, sid }) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/polymer/web-space/seasons_archives_list', {
    mid: Number(mid), season_id: Number(sid), page_num: 1, page_size: 20,
  }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`合集信息失败: ${json.code} ${json.message || ''}`);
  const data = json.data || {};
  return {
    sid: Number(sid),
    title: data.meta?.name || data.meta?.title || `合集 ${sid}`,
    description: data.meta?.description || '',
    cover: data.meta?.cover || '',
    total: data.meta?.total || data.page?.total || 0,
    pageSize: data.page?.size || 20,
  };
}

/** 合集内视频列表（分页，按合集顺序） */
export async function getCollectionArchives({ mid, sid, pageNum = 1, pageSize = 30 }) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/polymer/web-space/seasons_archives_list', {
    mid: Number(mid), season_id: Number(sid), page_num: pageNum, page_size: pageSize,
  }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`合集视频列表失败: ${json.code} ${json.message || ''}`);
  const archives = json.data?.archives || [];
  const total = json.data?.page?.total ?? json.data?.meta?.total ?? archives.length;
  return {
    videos: archives.map((a) => ({
      aid: a.aid, bvid: a.bvid, title: a.title,
      duration: a.duration, pic: a.pic, pubdate: a.pubdate,
      stat: a.stat ? { view: a.stat.view, danmaku: a.stat.danmaku, like: a.stat.like } : {},
    })),
    total,
    pageNum, pageSize,
  };
}

/** 从合集内任一视频的 ugc_season 提取合集板块结构（sections） */
export function extractCollectionSections(ugcSeason) {
  if (!ugcSeason?.sections) return [];
  return (ugcSeason.sections || []).map((s) => ({
    sectionId: s.id,
    title: s.title,
    count: (s.episodes || []).length,
  }));
}

// ---- 批量场景接口 ----
export async function getUploaderVideos({ mid, pn = 1, ps = 40, order = 'click' }) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/space/wbi/arc/search', {
    mid: String(mid), pn, ps, tid: 0, special_type: '', order, index: 0, keyword: '',
    order_avoided: true, platform: 'web',
  }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`UP主视频列表失败: ${json.code} ${json.message || ''}`);
  return json.data?.list?.vlist || [];
}

export async function searchVideos({ keyword, page = 1, pageSize = 42 }) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/wbi/search/type', {
    search_type: 'video', keyword, page, page_size: pageSize,
    category_id: '', __refresh__: 'true', _extra: '', context: '', order: '',
    pubtime_begin_s: 0, pubtime_end_s: 0, from_source: '', platform: 'pc',
    highlight: 1, single_column: 0, source_tag: 3, gaia_vtoken: '',
  }, keys);
  const { json } = await apiGet(url, { retries: 2 });
  if (json.code !== 0) throw new Error(`搜索失败: ${json.code} ${json.message || ''}`);
  return json.data?.result || [];
}

export async function getPopularVideos({ pn = 1, ps = 20 } = {}) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/popular', { ps, pn, web_location: '333.934' }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`热门失败: ${json.code} ${json.message || ''}`);
  return { list: json.data?.list || [], noMore: json.data?.no_more };
}

export async function getWeeklyVideos(number) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/popular/series/one', { number }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`每周必看失败: ${json.code} ${json.message || ''}`);
  return json.data;
}

/** 首页推荐流（需要登录 cookies） */
export async function getRecommendVideos({ ps = 30, lastShowList = '' } = {}) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd', {
    ps, fresh_type: 4, feed_version: 'V8', y_num: 3, last_showlist: lastShowList,
  }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`推荐流失败: ${json.code} ${json.message || ''}`);
  const items = json.data?.item || [];
  return {
    videos: items.filter((i) => i.bvid).map((i) => ({ bvid: i.bvid, title: i.title || '', reason: i.rcmd_reason?.content || '' })),
    lastShowList: (items[items.length - 1]?.id_str || lastShowList),
  };
}

/** 历史记录（需要登录 cookies），返回 { videos, cursor } */
export async function getHistoryVideos({ max = 0, viewAt = 0, business = '', ps = 20, type = 'all' } = {}) {
  const keys = await getWbiKeys();
  const url = wbiUrl('https://api.bilibili.com/x/web-interface/history/cursor', {
    max, view_at: viewAt, business, ps, type, web_location: '333.1007',
  }, keys);
  const { json } = await apiGet(url);
  if (json.code !== 0) throw new Error(`历史记录失败: ${json.code} ${json.message || ''}`);
  const list = json.data?.list || [];
  return {
    videos: list.filter((i) => i.bvid).map((i) => ({ bvid: i.bvid, title: i.title || '', viewAt: i.view_at || 0 })),
    cursor: json.data?.cursor || { max: 0, view_at: 0, business: '' },
  };
}

export { UA, BASE_HEADERS };
