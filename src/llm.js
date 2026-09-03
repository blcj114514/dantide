// llm.js — OpenAI 兼容 LLM 客户端（支持国内模型: DeepSeek/通义/智谱/Kimi/硅基流动等）
// 支持: 文本对话、JSON 输出、多模态（base64 图片 + 文本，需 visionModel）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { assertLlmBaseUrl } from './security.js';
import { TASK_FILES, readTaskJson, taskDir } from './task.js';
import { extractSubtitleLines, subtitlePlainText } from './subtitles.js';

/** 严谨分析师人设（用于所有结构化分析） */
export const ANALYST_PERSONA = `你是一位严谨、资深的社交媒体舆情分析师（研究员），专精网络内容生态、传播学与群体心理研究。工作原则：
1. 只依据提供的原始文本数据下结论，绝不臆测或编造；
2. 观点、情绪与人群判断必须有文本依据，必要时引用原句佐证；
3. 语言精准、结构清晰、避免空话套话与营销腔；
4. 同时关注主流声音与少数派/争议性观点，保持中立客观。`;

export class LLMError extends Error {}

function collectExtraPageSubtitles(taskId) {
  const dir = taskDir(taskId);
  const chunks = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^p\d+$/i.test(f)) continue;
      const fp = path.join(dir, f, 'subtitles.json');
      if (!fs.existsSync(fp)) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const text = subtitlePlainText(data, 4000);
      if (text) chunks.push(`【${f}】\n${text}`);
    }
  } catch { /* ignore */ }
  return chunks.join('\n\n');
}

function normalizeBaseUrl(u) {
  let base = String(u || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/chat/completions')) return base;
  return base + '/chat/completions';
}

/** 解析视觉模型配置: vision.baseUrl/apiKey/model 为空时回退到文本模型凭据 */
function resolveVision(cfg) {
  const v = cfg.vision || {};
  return {
    baseUrl: v.baseUrl || cfg.baseUrl,
    apiKey:   v.apiKey  || cfg.apiKey,
    model:    v.model   || cfg.visionModel || cfg.model,
    visionEnabled: cfg.visionEnabled,
    maxTokens: cfg.maxTokens,
  };
}

/**
 * 调用 LLM（OpenAI 兼容，支持国内模型）。
 * @param {object} opts
 * @param {'text'|'vision'} [opts.provider='text'] — 使用文本模型或视觉模型凭据
 *   当传入 imageUrl/imageUrls 且未显式指定 provider 时自动切换为 'vision'
 * @param {string} [opts.model] — 显式模型名（覆盖 provider 默认模型）
 * @returns {Promise<string>} 模型回复文本
 */
export async function chat({ system, prompt, messages, json = false, imageUrl, imageUrls, maxTokens, model, provider }) {
  const cfg = loadConfig().llm;
  // 自动选择 provider: 有图片且未显式指定 → vision; 否则按指定; 默认 text
  const hasImages = !!(imageUrl || (imageUrls && imageUrls.length));
  const isVision = provider === 'vision' || (!provider && hasImages);
  const prov = isVision ? resolveVision(cfg) : cfg;

  const url = normalizeBaseUrl(assertLlmBaseUrl(prov.baseUrl));
  if (!url || !prov.apiKey) {
    const label = isVision ? '视觉模型' : 'LLM';
    throw new LLMError(`${label} 未配置: 请在 Web UI "设置" 或 config.json 中填写 baseUrl/apiKey`);
  }
  const m = model || prov.model;
  if (!m) throw new LLMError(`模型名未配置（${isVision ? '视觉' : '文本'}模型）`);

  if (hasImages && cfg.visionEnabled === false) {
    throw new LLMError('视觉分析已禁用（识图模型消费较高）。可在 Web UI 顶部开关重新启用');
  }

  let msgs = messages;
  if (!msgs) {
    msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    if (hasImages) {
      const urls = imageUrls && imageUrls.length ? imageUrls : [imageUrl];
      msgs.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt || '请分析这些图片' },
          ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
        ],
      });
    } else {
      msgs.push({ role: 'user', content: prompt || '' });
    }
  }

  const body = {
    model: m,
    messages: msgs,
    // 思考档位开启时，思考内容也计入 max_tokens，额外留余量防止正文/JSON 被截断
    max_tokens: (maxTokens ?? cfg.maxTokens ?? 2000)
      + (/^(low|high|max)$/i.test(String(cfg.reasoningEffort || '')) ? 1200 : 0),
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };
  // 思考强度（Ollama Pro 等兼容 reasoning_effort 的服务商）: none/low/high/max
  if (!isVision && /^(none|low|high|max)$/i.test(String(cfg.reasoningEffort || ''))) {
    body.reasoning_effort = String(cfg.reasoningEffort).toLowerCase();
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LLMError(`LLM 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LLMError('LLM 响应异常: ' + JSON.stringify(data).slice(0, 200));
  }
  logger.debug('LLM 调用完成', { provider: isVision ? 'vision' : 'text', model: m, url, promptLength: (prompt || '').length, replyLength: content.length });
  return content;
}

/**
 * 测试 LLM 连接（真实调用一个最小 prompt）
 * @param {'text'|'vision'} type
 * @returns {Promise<{ok:boolean, model?:string, latencyMs?:number, error?:string}>}
 */
export async function testLlmConnection(type = 'text') {
  const cfg = loadConfig().llm;
  const t0 = Date.now();
  try {
    if (type === 'text') {
      if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) return { ok: false, error: '文本模型未配置完整（需要 baseUrl + apiKey + model）' };
      const reply = await chat({ prompt: '请回复:pong', maxTokens: 300, provider: 'text' });
      return { ok: true, model: cfg.model, latencyMs: Date.now() - t0, reply: String(reply || '').slice(0, 50) };
    }
    if (type === 'vision') {
      const v = resolveVision(cfg);
      if (!v.baseUrl || !v.apiKey || !v.model) return { ok: false, error: '视觉模型未配置完整（需要 baseUrl + apiKey + model）' };
      // 1x1 白色 PNG 测试图
      const testImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIwAAAABJRU5ErkJggg==';
      const reply = await chat({ prompt: 'Describe this image in one word.', imageUrl: testImg, maxTokens: 300, provider: 'vision' });
      return { ok: true, model: v.model, latencyMs: Date.now() - t0, reply: String(reply || '').slice(0, 50) };
    }
    return { ok: false, error: `未知类型: ${type}` };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - t0 };
  }
}

/** 解析 JSON 输出（容忍 markdown 代码块包裹） */
export function parseJsonReply(text) {
  const t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : t;
  try { return JSON.parse(raw); }
  catch (e) { throw new LLMError('LLM 返回不是合法 JSON: ' + raw.slice(0, 200)); }
}

/**
 * 阶段1: 用文本模型（model，如 deepseek-v4-flash）从弹幕+字幕中定位"值得截图的关键时间点"
 * @param {object} input { videoTitle, danmakuText, subtitleText, duration }
 * @param {{topN?: number}} opts
 * @returns {Promise<Array<{time:number, reason:string, evidence:string[]}>>}
 */
export async function locateKeyMoments({ videoTitle, danmakuText, subtitleText, duration }, { topN = 5 } = {}) {
  const system = ANALYST_PERSONA + `
你现在执行"视频关键时间点定位"任务，角色是视频内容研究分析师：
- 你擅长从带时间戳的弹幕与字幕中识别观众集体关注的时刻
- 判定依据（按重要性排序）:
  1. 弹幕明确提示: "重点/注意/高能/划重点/截图/要考/记住/干货/前方高能" 等标记词
  2. 弹幕在某一时刻密集爆发，多条弹幕围绕同一内容（演示、公布、转折）
  3. 弹幕讨论的具体对象值得截图留存（界面、工具、代码、画面文字、教程步骤）
- 只输出 JSON，不输出任何其他文字`;
  const prompt = [
    `视频《${videoTitle || ''}》${duration ? `（时长约 ${Math.floor(duration / 60)} 分 ${Math.floor(duration % 60)} 秒）` : ''}，以下是带时间戳的弹幕与字幕数据。`,
    `请找出 ${topN} 个最值得截图的关键时间点。要求:`,
    `1. 输出 JSON: {"moments": [{"time": 秒数(数字), "reason": "为何值得截图(50字内,基于证据)", "evidence": ["1-2条相关弹幕或字幕原文"]}]}`,
    `2. time 必须是下方数据中真实出现过的秒数（弹幕的 t= 或字幕的 [s]），严禁编造时间`,
    `3. 优先选弹幕有明确标记或密集讨论的时刻；避免选无弹幕支撑的纯字幕时刻`,
    `4. moments 按时间升序排列`,
    '',
    '---弹幕（t=秒）---',
    (danmakuText || '(无)').slice(0, 18000),
    '---字幕（[s] 秒）---',
    (subtitleText || '(无)').slice(0, 12000),
    '---数据结束---',
  ].join('\n');
  const reply = await chat({ system, prompt, json: true, maxTokens: 2000 });
  const parsed = parseJsonReply(reply);
  const moments = Array.isArray(parsed?.moments) ? parsed.moments : [];
  return moments
    .filter((m) => Number.isFinite(Number(m?.time)))
    .map((m) => ({
      time: Math.max(0, Number(m.time)),
      reason: String(m.reason || '').slice(0, 200),
      evidence: Array.isArray(m.evidence) ? m.evidence.map(String).slice(0, 2) : [],
    }))
    .slice(0, topN);
}

/** 分析文本（评论/弹幕等）→ 结构化结果 */
export async function analyzeText(text, { kind = '分析', extraPrompt = '' } = {}) {
  const system = ANALYST_PERSONA + '\n你是分析执行者：对输入数据做严谨结构化分析，只输出 JSON，不要任何多余文字。';
  const prompt = [
    `请对以下${kind}数据进行严谨分析，输出 JSON，字段包括:`,
    `{"summary": "总体概述(150字内，基于数据的客观概括)", "keywords": ["关键词1", ...], "sentiment": {"positive": 0-100数字, "neutral": 0-100, "negative": 0-100}, "highlights": ["值得注意的3-5条要点"], "quotes": ["数据中真实出现的代表性原句1-2条"], "focus": ["用户关注的3-5个焦点话题"], "controversy": "存在争议/分歧的点(无明显争议则写'无明显争议')"}`,
    `要求: sentiment 三项之和必须为 100；quotes 必须是数据原文，禁止改写；focus 从文本实际讨论内容归纳，不要泛泛而谈。`,
    extraPrompt ? `额外要求: ${extraPrompt}` : '',
    '---数据开始---',
    text.slice(0, 20000),
    '---数据结束---',
  ].filter(Boolean).join('\n');
  const reply = await chat({ system, prompt, json: true });
  return parseJsonReply(reply);
}

/**
 * 综合交叉分析：视频信息 + 字幕 + AI总结 + 弹幕 + 评论 一起分析
 * @param {object} input { video, subtitles, summary, comments, danmaku } 各字段为字符串（已截断）
 */
export async function analyzeCombined(input, { kind = '视频' } = {}) {
  const system = ANALYST_PERSONA + '\n你是分析执行者：基于多源数据做交叉印证的综合分析，只输出 JSON，不要任何多余文字。';
  const sections = [];
  if (input.video) sections.push(`【视频信息】\n${input.video}`);
  if (input.subtitles) sections.push(`【字幕节选】\n${input.subtitles}`);
  if (input.summary) sections.push(`【平台AI总结】\n${input.summary}`);
  if (input.comments) sections.push(`【评论】\n${input.comments}`);
  if (input.danmaku) sections.push(`【弹幕】\n${input.danmaku}`);
  const prompt = [
    `请对以下${kind}内容及其互动数据进行综合交叉分析，输出 JSON，字段包括:`,
    `{"summary": "视频内容与整体舆论概况(200字内)", "keywords": ["关键词1", ...], "sentiment": {"positive": 0-100, "neutral": 0-100, "negative": 0-100}, "content_feedback": "观众对视频内容的评价(信息量/质量/干货程度等)", "controversy": "存在争议或分歧的点(无明显争议则写'无明显争议')", "focus": ["观众关注的3-5个焦点话题"], "highlights": ["综合各来源得出的3-5条关键发现"], "quotes": ["弹幕或评论中真实出现的代表性原句2-3条"], "gap": "弹幕与评论关注点之间的差异(无明显差异则写'无明显差异')", "suggestions": ["给内容创作者或研究者的2-3条建议"]}`,
    `要求: sentiment 三项之和必须为 100；quotes 必须是数据原文，禁止改写；结论需有文本依据，可在总结中简要说明依据来源(如'弹幕多次提及…')。`,
    '---数据开始---',
    sections.join('\n\n').slice(0, 50000),
    '---数据结束---',
  ].filter(Boolean).join('\n');
  const reply = await chat({ system, prompt, json: true, maxTokens: 3000 });
  return parseJsonReply(reply);
}

/**
 * 读取任务目录数据并组装为分析输入（供 /api/analyze、CLI、MCP 共用）
 * @param {string} taskId
 * @param {'comments'|'danmaku'|'all'} type
 * @returns {{text?: string, input?: object, meta: object}}
 *   text — 单源类型（comments/danmaku）的分析文本
 *   input — 综合类型（all）的分段输入 {video, subtitles, summary, comments, danmaku}
 *   meta — 各源统计
 */
export function buildTaskAnalysisInput(taskId, type = 'comments') {
  const meta = {};
  if (type === 'comments') {
    const items = readTaskJson(taskId, TASK_FILES.comments);
    meta.total = Array.isArray(items) ? items.length : 0;
    const text = (Array.isArray(items) ? items : [])
      .map((i) => i.content || '').filter(Boolean).join('\n');
    return { text: text.slice(0, 20000), meta };
  }
  if (type === 'danmaku') {
    const items = readTaskJson(taskId, TASK_FILES.danmaku);
    meta.total = Array.isArray(items) ? items.length : 0;
    const text = (Array.isArray(items) ? items : [])
      .map((i) => i.content || '').filter(Boolean).join('\n');
    return { text: text.slice(0, 20000), meta };
  }
  if (type === 'all') {
    const biliDetail = readTaskJson(taskId, 'bilibili_detail.json');
    const ytDetail = readTaskJson(taskId, 'youtube_detail.json');
    const comments = readTaskJson(taskId, TASK_FILES.comments);
    const danmaku = readTaskJson(taskId, TASK_FILES.danmaku);
    const subtitles = readTaskJson(taskId, TASK_FILES.subtitles);
    const extraSubtitleText = collectExtraPageSubtitles(taskId);
    const summary = readTaskJson(taskId, TASK_FILES.summary);
    const commentItems = Array.isArray(comments) ? comments : [];
    const danmakuItems = Array.isArray(danmaku) ? danmaku : [];
    const subtitleLines = extractSubtitleLines(subtitles);
    meta.comments = commentItems.length;
    meta.danmaku = danmakuItems.length;
    meta.subtitles = subtitleLines.length > 0 || !!extraSubtitleText;
    meta.aiSummary = !!summary;
    meta.platform = ytDetail && !biliDetail ? 'youtube' : 'bilibili';

    let video = '';
    if (biliDetail) {
      const d = biliDetail;
      const stat = d.stat || {};
      video = [
        `标题: ${d.title || ''}`,
        `UP主: ${d.owner?.name || ''} (mid: ${d.owner?.mid || ''})`,
        `分区: ${d.tname || ''}`,
        `发布时间: ${d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : ''}`,
        `时长: ${d.duration || 0}秒`,
        `数据: 播放${stat.view ?? '-'} / 弹幕${stat.danmaku ?? '-'} / 点赞${stat.like ?? '-'} / 投币${stat.coin ?? '-'} / 收藏${stat.favorite ?? '-'} / 转发${stat.share ?? '-'}`,
        d.desc ? `简介: ${String(d.desc).slice(0, 500)}` : '',
      ].filter(Boolean).join('\n');
    } else if (ytDetail) {
      video = [
        `标题: ${ytDetail.title || ''}`,
        `频道: ${ytDetail.channel || ''} (${ytDetail.channelId || ''})`,
        `发布时间: ${ytDetail.publishedAt || ''}`,
        `时长: ${ytDetail.duration || ''}`,
        `数据: 播放${ytDetail.viewCount ?? '-'} / 点赞${ytDetail.likeCount ?? '-'} / 评论${ytDetail.commentCount ?? '-'}`,
        ytDetail.description ? `简介: ${String(ytDetail.description).slice(0, 500)}` : '',
      ].filter(Boolean).join('\n');
    }

    const subtitleText = [subtitlePlainText(subtitles, 4000), extraSubtitleText].filter(Boolean).join('\n\n').slice(0, 12000);

    let summaryText = '';
    if (summary) {
      try { summaryText = JSON.stringify(summary, null, 0).slice(0, 3000); } catch { /* ignore */ }
    }

    const dmTexts = danmakuItems.map((i) => i.content || '').filter(Boolean);
    const dmSample = dmTexts.length > 500 ? dmTexts.slice(0, 250).concat(dmTexts.slice(-250)) : dmTexts;
    const dmText = dmSample.join('\n').slice(0, 20000);

    const cmTexts = commentItems.map((i) => i.content || '').filter(Boolean);
    const cmSample = cmTexts.length > 500 ? cmTexts.slice(0, 250).concat(cmTexts.slice(-250)) : cmTexts;
    const cmText = cmSample.join('\n').slice(0, 20000);

    return {
      input: {
        video: video || undefined,
        subtitles: subtitleText || undefined,
        summary: summaryText || undefined,
        comments: cmText ? `评论共 ${cmTexts.length} 条，抽样如下:\n${cmText}` : undefined,
        danmaku: dmText ? `弹幕共 ${dmTexts.length} 条，抽样如下:\n${dmText}` : undefined,
      },
      meta,
    };
  }
  throw new Error(`未知分析类型: ${type}（支持 comments / danmaku / all）`);
}

/** 图片分析（多模态模型，使用视觉模型凭据） */
export async function analyzeImage(imageDataUrl, { prompt = '请详细描述这张图片的内容、风格和文字信息。' } = {}) {
  return chat({ prompt, imageUrl: imageDataUrl, provider: 'vision' });
}

/** 剪贴板分析：文本 + 自定义 prompt */
export async function analyzeClipboard(text, userPrompt = '分析正文和评论') {
  const system = ANALYST_PERSONA + '\n请以严谨研究者的风格输出分析结论，条理清晰、观点有据。';
  const reply = await chat({ system, prompt: `${userPrompt}\n\n---内容---\n${String(text).slice(0, 30000)}\n---内容结束---` });
  return reply;
}
