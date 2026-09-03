// export.js — 零依赖导出（CSV / Excel 兼容 HTML .xls）+ 词频统计
'use strict';

// ---------- CSV ----------
export function toCsv(rows, { bom = true } = {}) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  return (bom ? '\ufeff' : '') + body; // BOM 让 Excel 正确识别 UTF-8 中文
}

// ---------- Excel 兼容 HTML (.xls) ----------
export function toXlsHtml(title, headers, rows) {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="UTF-8"><title>${esc(title)}</title></head>
<body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

// ---------- 词频统计 ----------
const STOP_WORDS = new Set(('的了是在我有和就不人都一个上也很到说要去你会着没有看好她这那为与及等或而被把让从向对能可以什么怎么你们我们他们自己这个那个因为所以但是如果虽然只是还是就是不是没有非常真的特别应该可能可以已经正在现在今天明天昨天时候地方东西事情问题方法方式原因结果情况部分全部很多很少一些一点一直一定一起一样一直一直').split(''));

/**
 * 简单中文词频统计（无需分词库）:
 * 1) 提取连续中文串（2-6 字窗口）; 2) 双字词优先 + 停用词过滤; 3) 排序 topN
 * @param {string[]} texts
 * @returns {Array<{word, count}>}
 */
export function wordFrequency(texts, { topN = 30 } = {}) {
  const counts = new Map();
  const add = (w, n = 1) => counts.set(w, (counts.get(w) || 0) + n);
  const isCjk = (ch) => /[\u4e00-\u9fff]/.test(ch);

  for (const t of texts) {
    if (!t) continue;
    // 拆成连续中文段
    const segments = String(t).match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const seg of segments) {
      // 双字词 + 单字剔除停用词
      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg.slice(i, i + 2);
        if (!STOP_WORDS.has(bigram[0]) && !STOP_WORDS.has(bigram[1])) add(bigram);
      }
      // 3-4 字连续串（高于 4 字按 4 字窗口滑动）
      for (let i = 0; i <= seg.length - 4; i++) {
        add(seg.slice(i, i + 4));
      }
      for (const ch of seg) {
        if (!STOP_WORDS.has(ch)) add(ch);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
}

/** 从任务文件读取文本数组（comments/danmaku 结构兼容） */
export function collectTexts(items) {
  return (items || []).map((i) => i.content || '').filter(Boolean);
}
