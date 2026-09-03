// subtitles.js — 统一解析 subtitles.json（官方 BCC / ASR / 纯数组）
'use strict';

/**
 * 从字幕 JSON 提取带时间的行。
 * 兼容: [{from,content}] | { body: { body: [...] } } | { body: [...] }
 */
export function extractSubtitleLines(subtitles) {
  if (subtitles == null) return [];
  const arr = Array.isArray(subtitles)
    ? subtitles
    : (subtitles.body?.body || subtitles.body || subtitles.segments || []);
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => {
    if (typeof s === 'string') return { from: 0, content: s.trim() };
    return {
      from: Number(s?.from ?? s?.start ?? 0) || 0,
      content: String(s?.content || s?.text || '').trim(),
    };
  }).filter((s) => s.content);
}

/** 拼成一段纯文本（分析/合集报告用） */
export function subtitlePlainText(subtitles, maxLen = 4000) {
  const text = extractSubtitleLines(subtitles).map((s) => s.content).join(' ');
  return maxLen ? text.slice(0, maxLen) : text;
}
