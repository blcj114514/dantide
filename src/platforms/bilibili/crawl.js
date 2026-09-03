// platforms/bilibili/crawl.js — 采集编排：URL 解析 → 任务目录 → 分步采集 → 聚合归档
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import {
  createTask, markTaskCompleted, markTaskFailed, markTaskCancelled, shouldSkipTask, sanitizeName, taskDir, updateTaskProgress,
  throwIfAborted, getTaskAbortSignal, isCancelledError, linkChildAbort,
} from '../../task.js';
import {
  parseUrl, getVideoDetail, crawlDanmaku, crawlComments, crawlSubtitles, crawlAiSummary,
  getUploaderVideos, searchVideos, getPopularVideos, getWeeklyVideos,
  getRecommendVideos, getHistoryVideos, UA, BASE_HEADERS,
  getCollectionInfo, getCollectionArchives, extractCollectionSections,
} from './api.js';
import { downloadVideoAndAudio } from './download.js';
import { resolveAsrEngine, transcribeMediaDir } from '../../asr.js';

function batchSourceUrl(type, param = {}) {
  if (type === 'uploader' && param.mid) return `https://space.bilibili.com/${param.mid}/upload/video`;
  if (type === 'search') {
    return `https://search.bilibili.com/video?keyword=${encodeURIComponent(param.keyword || '')}`;
  }
  if (type === 'popular') return 'https://www.bilibili.com/v/popular/all';
  if (type === 'weekly') return `https://www.bilibili.com/v/popular/weekly?num=${param.number || 1}`;
  if (type === 'recommend') return 'https://www.bilibili.com/video/recommend';
  if (type === 'history') return 'https://www.bilibili.com/history';
  return '';
}

/** 扫描已采集完成的视频 bvid 集合（读各任务 bilibili_all.json） */
export function getCrawledBvids() {
  const set = new Set();
  if (!fs.existsSync(DATA_DIR)) return set;
  for (const d of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const all = JSON.parse(fs.readFileSync(path.join(DATA_DIR, d.name, 'bilibili_all.json'), 'utf8'));
      if (all?.bvid) set.add(all.bvid);
    } catch { /* ignore */ }
  }
  return set;
}

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

function pageRelDir(index) {
  return index === 0 ? '' : 'p' + String(index + 1).padStart(2, '0');
}

async function collectBilibiliPage({
  taskId, bvid, aid, page, index, pageCount, taskDirPath, duration, opts, cfg, signal, maxDanmaku,
}) {
  const rel = pageRelDir(index);
  const pageDir = rel ? path.join(taskDirPath, rel) : taskDirPath;
  if (rel) fs.mkdirSync(pageDir, { recursive: true });
  const cid = page.cid;
  const label = `P${index + 1}/${pageCount}`;
  logger.info('采集分P', { taskId, bvid, cid, page: index + 1, of: pageCount, title: page.part || '' });
  throwIfAborted(signal);

  const danmaku = await crawlDanmaku({
    oid: cid, duration: page.duration || duration, maxCount: maxDanmaku,
    onProgress: (n) => {
      updateTaskProgress(taskId, {
        stage: 'danmaku', stageLabel: `${label} 弹幕`,
        percent: 30 + (65 * index + 10 * (n / Math.max(1, maxDanmaku))) / Math.max(1, pageCount),
        current: n, total: maxDanmaku, message: `${label} 弹幕 ${n} 条`,
      });
    },
  });
  writeJson(path.join(pageDir, 'bilibili_danmaku.json'), danmaku);

  let officialSubs = null;
  if (!opts.noSubtitles) {
    updateTaskProgress(taskId, {
      stage: 'subtitles', stageLabel: `${label} 官方字幕`,
      percent: 30 + (65 * (index + 0.25)) / pageCount,
      message: `${label} 获取字幕`,
    });
    try {
      officialSubs = await crawlSubtitles({ aid, cid });
      if (officialSubs) writeJson(path.join(pageDir, 'subtitles.json'), officialSubs);
    } catch (e) {
      logger.warn('官方字幕采集失败（继续）', { taskId, page: index + 1, error: e.message });
    }
  }

  const asrCfgOn = loadConfig().asr?.enabled !== false;
  const asrWanted = asrCfgOn && !opts.noAsr && !opts.noSubtitles;
  const needAsr = asrWanted && !officialSubs && !!resolveAsrEngine().engine;
  const wantVideo = opts.fetchVideo ?? cfg.fetchVideo;
  const wantAudio = (opts.fetchAudio ?? cfg.fetchAudio) || needAsr;
  let dl = { video: null, audio: null, merged: false };
  throwIfAborted(signal);
  if (wantVideo || wantAudio) {
    logger.info('开始下载分P', { taskId, page: index + 1, fetchVideo: wantVideo, fetchAudio: wantAudio });
    dl = await downloadVideoAndAudio({
      bvid, cid, dir: pageDir,
      preferHighQuality: opts.preferHighQuality ?? cfg.preferHighQuality,
      quality: opts.quality || cfg.quality || '1080p',
      wantVideo, wantAudio, signal,
      onProgress: (p) => {
        updateTaskProgress(taskId, {
          stage: 'download', stageLabel: `${label} 下载`,
          percent: 30 + (65 * (index + 0.4 + 0.4 * (p.pct / 100))) / pageCount,
          message: `${label} ${p.kind === 'video' ? '视频' : '音频'} ${p.pct}%`,
        });
      },
    });
  }

  let subtitleSource = officialSubs ? 'bilibili' : '';
  if (asrWanted && !officialSubs) {
    const asr = resolveAsrEngine();
    if (!asr.engine) {
      logger.warn('无官方字幕且 ASR 未就绪，跳过转写', { taskId, page: index + 1, reason: asr.reason });
    } else {
      updateTaskProgress(taskId, {
        stage: 'asr', stageLabel: `${label} 语音转写`,
        percent: 30 + (65 * (index + 0.9)) / pageCount,
        message: `${label} ${asr.engine}`,
      });
      try {
        const asrSubs = await transcribeMediaDir(pageDir, { signal });
        writeJson(path.join(pageDir, 'subtitles.json'), asrSubs);
        subtitleSource = 'asr';
      } catch (e) {
        if (isCancelledError(e)) throw e;
        logger.warn('语音转写失败（继续）', { taskId, page: index + 1, error: e.message });
      }
    }
  }

  return {
    index: index + 1, cid, part: page.part || '', dir: rel || '.',
    danmaku: danmaku.length, subtitles: !!subtitleSource, subtitleSource,
    video: !!dl.video, audio: !!dl.audio, merged: !!dl.merged,
  };
}

/**
 * 采集一个 B站视频（多分 P 串行全采；第 1 P 仍写任务根目录）
 * @param {string} input URL 或 BV 号
 * @param {object} opts { danmakuCount, commentCount, subCommentCount, noComments, noSubtitles, noSummary, noAsr }
 * @returns {Promise<{taskId, dir, stats}>}
 */
export async function crawlBilibiliVideo(input, opts = {}) {
  const { bvid } = parseUrl(input);
  if (!bvid) throw new Error('无法识别 BV 号: ' + input);
  const cfg = loadConfig().crawl.bilibili;
  const maxDanmaku = opts.danmakuCount ?? cfg.danmakuCount;
  const commentCount = opts.commentCount ?? cfg.commentCount;
  const subCommentCount = opts.subCommentCount ?? cfg.subCommentCount;

  logger.info('开始采集 B站视频', { bvid });

  const detail = await getVideoDetail(bvid);
  const title = detail.title || bvid;
  const taskId = `${sanitizeName(title)}-${detail.aid}`;
  const skip = shouldSkipTask(taskId);
  if (skip.shouldSkip) {
    logger.info('任务已存在，跳过', { taskId, status: skip.status });
    return { taskId, dir: taskDir(taskId), skipped: true, status: skip.status };
  }

  const dir = taskDir(taskId);
  createTask(taskId, { title, url: `https://www.bilibili.com/video/${bvid}`, options: opts });
  if (opts.parentTaskId) linkChildAbort(opts.parentTaskId, taskId);
  fs.mkdirSync(dir, { recursive: true });

  const stats = { comments: 0, danmaku: 0, subtitles: false, aiSummary: false, detail: false, cover: false };
  const signal = getTaskAbortSignal(taskId);
  try {
    // 详情
    writeJson(path.join(dir, 'bilibili_detail.json'), detail);
    stats.detail = true;
    updateTaskProgress(taskId, { stage: 'detail', stageLabel: '获取视频详情', percent: 5, message: '详情获取完成' });

    // 封面下载
    try {
      if (detail.pic && !fs.existsSync(path.join(dir, 'cover.jpg')) && !fs.existsSync(path.join(dir, 'cover.png'))) {
        const picRes = await fetch(detail.pic, { headers: { ...BASE_HEADERS, Referer: 'https://www.bilibili.com/' } });
        if (picRes.ok) {
          const buf = Buffer.from(await picRes.arrayBuffer());
          const ct = picRes.headers.get('content-type') || '';
          const ext = ct.includes('png') ? 'png' : 'jpg';
          fs.writeFileSync(path.join(dir, `cover.${ext}`), buf);
          stats.cover = true;
          logger.info('封面已下载', { taskId, file: `cover.${ext}`, size: buf.length });
        }
      }
    } catch (e) {
      logger.warn('封面下载失败（继续）', { taskId, error: e.message });
    }

    const pages = (detail.pages && detail.pages.length)
      ? detail.pages
      : [{ cid: detail.cid, part: title, duration: detail.duration }];
    const cid = pages[0]?.cid || detail.cid;
    stats.pages = pages.length;
    if (pages.length > 1) {
      logger.info('多分P稿件将串行全采', { taskId, bvid, pages: pages.length });
    }

    throwIfAborted(signal);

    // 评论（稿件级，只采一次）
    if (!opts.noComments) {
      logger.info('采集评论', { taskId, oid: detail.aid });
      try {
        const comments = await crawlComments({
          oid: detail.aid, commentCount, subCommentCount,
          onProgress: (n) => {
            updateTaskProgress(taskId, {
              stage: 'comments', stageLabel: '采集评论', percent: Math.min(60, 30 + 30 * (n / Math.max(1, commentCount))),
              current: n, total: commentCount, message: `已采集评论 ${n} 条`,
            });
          },
        });
        writeJson(path.join(dir, 'bilibili_comment.json'), comments);
        stats.comments = comments.length;
        updateTaskProgress(taskId, { stage: 'comments', stageLabel: '采集评论', percent: 25, current: comments.length, message: `评论完成，共 ${comments.length} 条` });
      } catch (e) {
        logger.warn('评论采集失败（继续）', { taskId, error: e.message });
      }
    }

    // AI 总结（稿件级，只采一次）
    if (!opts.noSummary) {
      updateTaskProgress(taskId, { stage: 'summary', stageLabel: '获取AI总结', percent: 28, message: '获取中…' });
      try {
        const summary = await crawlAiSummary({ aid: detail.aid, bvid, cid, upMid: detail.owner?.mid });
        if (summary) { writeJson(path.join(dir, 'bilibili_summary.json'), summary); stats.aiSummary = true; }
      } catch (e) {
        logger.warn('AI总结失败（继续）', { taskId, error: e.message });
      }
    }

    const pageStats = [];
    for (const [i, page] of pages.entries()) {
      throwIfAborted(signal);
      const ps = await collectBilibiliPage({
        taskId, bvid, aid: detail.aid, page, index: i, pageCount: pages.length,
        taskDirPath: dir, duration: detail.duration, opts, cfg, signal, maxDanmaku,
      });
      pageStats.push(ps);
    }
    stats.danmaku = pageStats[0]?.danmaku || 0;
    stats.subtitles = pageStats.some((p) => p.subtitles);
    stats.subtitleSource = pageStats[0]?.subtitleSource || '';
    stats.video = pageStats.some((p) => p.video);
    stats.audio = pageStats.some((p) => p.audio);
    stats.merged = pageStats.some((p) => p.merged);
    stats.pageStats = pageStats;

    // 聚合
    const all = {
      taskId, bvid, title,
      url: `https://www.bilibili.com/video/${bvid}`,
      detail: {
        aid: detail.aid, cid, owner: detail.owner?.name, mid: detail.owner?.mid,
        pubdate: detail.pubdate, stat: detail.stat, duration: detail.duration, tname: detail.tname,
        pages: pages.length, pageTitle: pages[0]?.part || '',
        pageList: pages.map((p, i) => ({ index: i + 1, cid: p.cid, part: p.part || '', dir: pageRelDir(i) || '.' })),
      },
      stats,
      collectedAt: new Date().toISOString(),
    };
    writeJson(path.join(dir, 'bilibili_all.json'), all);
    markTaskCompleted(taskId);
    logger.info('采集完成', { taskId, stats });
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

/**
 * 批量采集：UP主视频列表 / 搜索结果 / 热门 / 每周必看 → 每个视频一个子任务
 */
export async function crawlBilibiliBatch(type, param, opts = {}) {
  const cfg = loadConfig().crawl.bilibili;
  const limit = opts.limit ?? Math.max(1, Math.floor((cfg.baseTargetCount || 1500) / 200));

  let videos = [];
  let taskName = '';
  let taskIdPrefix = '';

  if (type === 'uploader') {
    taskName = `UP主采集 ${param.mid}`;
    taskIdPrefix = `uploader-${param.mid}`;
    let pn = 1;
    while (videos.length < limit) {
      const page = await getUploaderVideos({ mid: param.mid, pn, ps: 40, order: param.order || 'click' });
      if (!page.length) break;
      videos.push(...page);
      if (page.length < 40) break;
      pn++;
    }
  } else if (type === 'search') {
    taskName = `搜索 "${param.keyword}"`;
    taskIdPrefix = `search-${sanitizeName(param.keyword)}-b-1`;
    let page = 1;
    while (videos.length < limit && page <= 5) {
      const result = await searchVideos({ keyword: param.keyword, page, pageSize: 42 });
      if (!result.length) break;
      videos.push(...result);
      page++;
    }
  } else if (type === 'popular') {
    taskName = '热门视频';
    taskIdPrefix = `bilibili_popular_${new Date().toISOString().slice(0, 10)}`;
    let pn = 1;
    for (;;) {
      const { list, noMore } = await getPopularVideos({ pn, ps: 20 });
      if (!list.length) break;
      videos.push(...list);
      if (noMore || videos.length >= limit) break;
      pn++;
    }
  } else if (type === 'weekly') {
    taskName = `每周必看 #${param.number}`;
    taskIdPrefix = `bilibili_weekly_${param.number}`;
    const data = await getWeeklyVideos(param.number);
    videos = data?.list || [];
  } else if (type === 'recommend') {
    taskName = '首页推荐';
    taskIdPrefix = `bilibili_recommend_${new Date().toISOString().slice(0, 10)}`;
    let last = '';
    while (videos.length < limit) {
      const { videos: page, lastShowList } = await getRecommendVideos({ ps: 30, lastShowList: last });
      if (!page.length) break;
      videos.push(...page);
      if (!lastShowList || page.length < 30) break;
      last = lastShowList;
    }
  } else if (type === 'history') {
    taskName = '历史记录';
    taskIdPrefix = `bilibili_history_${new Date().toISOString().slice(0, 10)}`;
    let cursor = { max: 0, view_at: 0, business: '' };
    while (videos.length < limit) {
      const { videos: page, cursor: next } = await getHistoryVideos({
        max: cursor.max, viewAt: cursor.view_at, business: cursor.business, ps: 20,
      });
      if (!page.length) break;
      videos.push(...page);
      if (!next?.max || page.length < 20) break;
      cursor = next;
    }
  } else {
    throw new Error('未知批量类型: ' + type);
  }

  const unique = [];
  const seen = new Set();
  for (const v of videos) {
    const bvid = v.bvid;
    if (!bvid || seen.has(bvid)) continue;
    seen.add(bvid);
    unique.push(bvid);
  }
  // 批量防重复: 跳过已采集完成的视频
  const crawled = getCrawledBvids();
  const fresh = unique.filter((b) => !crawled.has(b));
  const alreadyDone = unique.filter((b) => crawled.has(b));
  if (alreadyDone.length) {
    logger.info('批量跳过已采集视频', { count: alreadyDone.length, bvids: alreadyDone.slice(0, 10) });
  }
  logger.info('批量采集: 获取视频列表', { type, taskName, total: unique.length, fresh: fresh.length, alreadyDone: alreadyDone.length });

  const batchId = `${taskIdPrefix}-batch-${Date.now()}`;
  createTask(batchId, { title: taskName, url: batchSourceUrl(type, param), type: 'batch', options: opts });
  const dir = taskDir(batchId);
  const parentSig = getTaskAbortSignal(batchId);
  const results = [];
  const total = Math.min(fresh.length, limit);
  for (const [i, bvid] of fresh.slice(0, limit).entries()) {
    throwIfAborted(parentSig);
    logger.info(`批量进度 ${i + 1}/${total}`, { bvid });
    updateTaskProgress(batchId, {
      stage: 'batch', stageLabel: '批量采集', percent: Math.round((i / total) * 100),
      current: i, total, message: `正在处理第 ${i + 1}/${total} 个视频: ${bvid}`,
    });
    try {
      const r = await crawlBilibiliVideo(bvid, { ...opts, parentTaskId: batchId });
      results.push({ bvid, ...r });
    } catch (e) {
      if (isCancelledError(e)) { markTaskCancelled(batchId); throw e; }
      logger.error('子任务失败（继续）', { bvid, error: e.message });
      results.push({ bvid, failed: true, error: e.message });
    }
  }
  updateTaskProgress(batchId, { stage: 'batch', stageLabel: '批量采集', percent: 100, current: total, total, message: '批量采集完成' });
  writeJson(path.join(dir, 'bilibili_all.json'), {
    type, taskName, batchId, param,
    total: unique.length, fresh: fresh.length, alreadyDone,
    results: results.map((r) => ({ bvid: r.bvid, taskId: r.taskId, failed: r.failed, error: r.error })),
    createdAt: new Date().toISOString(),
  });
  markTaskCompleted(batchId);
  logger.info('批量采集完成', { taskName, done: results.filter((r) => !r.failed).length, failed: results.filter((r) => r.failed).length });
  return { taskId: batchId, dir, results };
}

/**
 * 合集采集: 按合集（可指定板块 section）分批下载
 * @param {object} param { mid, sid }
 * @param {object} opts { limit, offset, section, ...crawlBilibiliVideo opts }
 *   section: 板块标题关键词（如 "导数"），只采集该板块
 *   offset: 从合集第 N 个开始（配合 limit 分批续传）
 */
export async function crawlBilibiliCollection({ mid, sid }, opts = {}) {
  const cfg = loadConfig().crawl.bilibili;
  const limit = opts.limit ?? Math.max(1, Math.floor((cfg.baseTargetCount || 1500) / 200));
  const offset = Math.max(0, Number(opts.offset) || 0);

  // 1) 合集信息
  const info = await getCollectionInfo({ mid, sid });
  logger.info('合集信息', { sid, title: info.title, total: info.total });

  // 2) 板块结构（从合集内最新视频 detail 的 ugc_season 拿）
  let sections = [];
  try {
    const first = await getCollectionArchives({ mid, sid, pageNum: 1, pageSize: 1 });
    if (first.videos[0]?.bvid) {
      const detail = await getVideoDetail(first.videos[0].bvid);
      sections = extractCollectionSections(detail.ugc_season);
    }
  } catch { /* 板块信息非必须 */ }
  if (sections.length) {
    logger.info('合集板块结构', { sections: sections.map((s) => `${s.title}(${s.count})`).join(' / ') });
  }

  // 3) 拉取全部视频列表（分页）
  const allVideos = [];
  let pageNum = 1;
  for (;;) {
    const page = await getCollectionArchives({ mid, sid, pageNum, pageSize: 30 });
    allVideos.push(...page.videos);
    if (allVideos.length >= page.total || !page.videos.length || page.videos.length < page.pageSize) break;
    pageNum++;
  }
  logger.info('合集视频列表拉取完成', { total: allVideos.length });

  // 4) 板块过滤
  let videos = allVideos;
  let sectionInfo = null;
  if (opts.section) {
    const kw = String(opts.section);
    // 尝试按 sectionId 或标题匹配
    sectionInfo = sections.find((s) => String(s.sectionId) === kw || s.title.includes(kw));
    if (!sectionInfo) {
      // 未匹配到板块 → 报错提示可用板块
      throw new Error(`未找到板块「${kw}」。可用板块: ${sections.map((s) => s.title).join(' / ') || '(合集无板块信息)'}`);
    }
    const secEpisodes = [];
    try {
      const detail = await getVideoDetail(allVideos[0].bvid);
      const sec = (detail.ugc_season?.sections || []).find((s) => s.id === sectionInfo.sectionId || s.title.includes(kw));
      if (sec) {
        for (const ep of sec.episodes || []) {
          const v = allVideos.find((x) => x.bvid === ep.bvid) || {
            aid: ep.aid, bvid: ep.bvid, title: ep.title, duration: ep.duration, pic: ep.arc?.pic,
          };
          secEpisodes.push(v);
        }
      }
    } catch { /* 板块 episodes 拿不到则退回标题过滤 */ }
    if (secEpisodes.length) videos = secEpisodes;
    logger.info('板块过滤', { section: sectionInfo.title, count: videos.length });
  }

  // 5) 先按合集顺序 offset/limit，再跳过窗口内已采集（offset 相对合集列表，不是相对剩余列表）
  const crawled = getCrawledBvids();
  const window = videos.slice(offset, offset + limit);
  const slice = window.filter((v) => v.bvid && !crawled.has(v.bvid));
  const alreadyDone = videos.filter((v) => crawled.has(v.bvid));
  const skippedInWindow = window.filter((v) => v.bvid && crawled.has(v.bvid));
  logger.info('合集采集准备', {
    total: videos.length, offset, limit,
    window: window.length, toFetch: slice.length, skippedInWindow: skippedInWindow.length,
  });

  const batchId = `collection-${sid}-batch-${Date.now()}`;
  const collectionUrl = `https://space.bilibili.com/${mid}/channel/collectiondetail?sid=${sid}`;
  createTask(batchId, { title: info.title || `合集 ${sid}`, url: collectionUrl, type: 'collection', options: opts });
  const dir = taskDir(batchId);
  const parentSig = getTaskAbortSignal(batchId);
  const results = [];
  const total = slice.length;
  for (const [i, v] of slice.entries()) {
    throwIfAborted(parentSig);
    logger.info(`合集进度 ${offset + i + 1}/${videos.length}`, { bvid: v.bvid, title: v.title });
    updateTaskProgress(batchId, {
      stage: 'collection', stageLabel: `合集: ${info.title}`, percent: Math.round((i / Math.max(1, total)) * 100),
      current: offset + i + 1, total: videos.length, message: `${String(v.title || '').slice(0, 30)}`,
    });
    try {
      const r = await crawlBilibiliVideo(`https://www.bilibili.com/video/${v.bvid}`, { ...opts, parentTaskId: batchId });
      results.push({ bvid: v.bvid, title: v.title, ...r });
    } catch (e) {
      if (isCancelledError(e)) { markTaskCancelled(batchId); throw e; }
      logger.error('子任务失败（继续）', { bvid: v.bvid, error: e.message });
      results.push({ bvid: v.bvid, title: v.title, failed: true, error: e.message });
    }
  }
  writeJson(path.join(dir, 'bilibili_all.json'), {
    type: 'collection', sid, mid, batchId,
    collection: { title: info.title, description: info.description, cover: info.cover, total: info.total },
    sections,
    section: sectionInfo?.title || null,
    offset, limit,
    videoCount: videos.length, window: window.length, fresh: slice.length,
    alreadyDone: alreadyDone.map((v) => v.bvid), skippedInWindow: skippedInWindow.map((v) => v.bvid),
    results: results.map((r) => ({ bvid: r.bvid, title: r.title, taskId: r.taskId, failed: r.failed, error: r.error })),
    createdAt: new Date().toISOString(),
  });
  markTaskCompleted(batchId);
  logger.info('合集采集完成', { title: info.title, done: results.filter((r) => !r.failed).length, failed: results.filter((r) => r.failed).length });
  return { taskId: batchId, dir, results, collection: info, sections };
}

/** 统一入口：根据 URL/输入自动路由 */
export async function crawlBilibili(input, opts = {}) {
  const parsed = parseUrl(input);
  switch (parsed.type) {
    case 'video': return crawlBilibiliVideo(input, opts);
    case 'uploader': return crawlBilibiliBatch('uploader', { mid: parsed.mid }, opts);
    case 'search': return crawlBilibiliBatch('search', { keyword: parsed.keyword }, opts);
    case 'popular': return crawlBilibiliBatch('popular', {}, opts);
    case 'weekly': return crawlBilibiliBatch('weekly', { number: parsed.number || 1 }, opts);
    case 'recommend': return crawlBilibiliBatch('recommend', {}, opts);
    case 'history': return crawlBilibiliBatch('history', {}, opts);
    case 'collection': {
      if (!parsed.mid || !parsed.sid) throw new Error('合集链接缺少 mid 或 sid 参数');
      return crawlBilibiliCollection({ mid: parsed.mid, sid: parsed.sid }, opts);
    }
    case 'bangumi':
      throw new Error('暂不支持番剧，请贴普通视频 BV（www.bilibili.com/video/BVxxxx）');
    default: throw new Error('暂不支持的输入类型: ' + input);
  }
}
