// app.js — SMR 前端逻辑（原生 JS，零依赖）
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString());
const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');
const SMR_TOKEN = window.__SMR_TOKEN__ || '';
function authQuery(url) {
  if (!SMR_TOKEN) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(SMR_TOKEN);
}
function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (SMR_TOKEN) headers['X-SMR-Token'] = SMR_TOKEN;
  return fetch(url, { ...opts, headers });
}

let tasks = [];
let taskQuery = '';
let taskStatusFilter = 'all';
let taskTypeFilter = 'all';

// ---- 状态/配置摘要 ----
async function loadStatus() {
  try {
    const r = await apiFetch('/api/status');
    const s = await r.json();
    $('#svc-status').className = 'dot ok';
    $('#svc-text').textContent = '运行中 · ' + s.config.server.host + ':' + s.config.server.port;
    const c = s.config;
    $('#cfg-summary').textContent =
      `B站cookie:${c.cookies.bilibili.includes('未') ? '✗' : '✓'} ` +
      `LLM:${c.llm.apiKey.includes('未') ? '✗(' + c.llm.model + ')' : '✓(' + (c.llm.model || '?') + ')'} ` +
      `ASR:${c.asr?.enabled === false ? '关' : (c.asr?.ready ? '✓' : '✗')}(${c.asr?.presetLabel || c.asr?.preset || c.asr?.engine || '?'}) ` +
      `YouTube:${c.youtube.apiKey.includes('未') ? '✗' : '✓'}`;
    renderVisionToggle(c.llm.visionEnabled !== false);
    syncCrawlAsrPreset(c.asr);
    checkSetupModal(c);
  } catch {
    $('#svc-status').className = 'dot err';
    $('#svc-text').textContent = '服务不可达';
    const btn = $('#vision-toggle');
    if (btn) { btn.textContent = '❓ 识图模型: 状态未知'; btn.className = 'mini'; }
  }
}

// ---- 首次使用配置向导（分步） ----
const PROVIDER_URLS = {
  'https://api.deepseek.com/v1': 'DeepSeek',
  'https://api.openai.com/v1': 'OpenAI',
  'https://open.bigmodel.cn/api/paas/v4': '智谱 GLM',
  'https://api.moonshot.cn/v1': 'Kimi',
  'https://dashscope.aliyuncs.com/compatible-mode/v1': '通义千问',
  'https://api.siliconflow.cn/v1': '硅基流动',
  'https://api.commandcode.ai/provider/v1': 'Command Code',
};
let wizardStep = 1;

function checkSetupModal(c) {
  const modal = $('#setup-modal');
  if (!modal) return;
  const llmOk = !c.llm.apiKey.includes('未') && !c.llm.baseUrl.includes('未');
  if (!llmOk && !sessionStorage.getItem('smr_setup_dismissed')) openSetupModal();
}

function openSetupModal() {
  $('#setup-modal').classList.remove('hidden');
  wizardStep = 1;
  updateWizardUI();
  Promise.all([
    loadAsrPresets(),
    apiFetch('/api/status').then((r) => r.json()),
  ]).then(([, s]) => {
    const l = s.config.llm;
    if (l.baseUrl && l.baseUrl !== '未配置') $('#setup-baseurl').value = l.baseUrl;
    if (l.model && l.model !== '未配置') $('#setup-model').value = l.model;
    if (l.vision && l.vision.model && !l.vision.model.includes('跟随')) $('#setup-v-model').value = l.vision.model;
    const a = s.config.asr || {};
    fillAsrPresetSelect();
    if ($('#setup-asr-preset')) $('#setup-asr-preset').value = a.preset || 'auto';
    if (a.engine) $('#setup-asr-engine').value = a.engine;
    if (a.model && a.model !== '未配置') $('#setup-asr-model').value = a.model;
    if ($('#setup-asr-follow')) $('#setup-asr-follow').checked = a.followLlm !== false;
    applyAsrPresetUi({ skipFill: true });
    for (const [url] of Object.entries(PROVIDER_URLS)) {
      if ($('#setup-baseurl').value === url) { $('#setup-provider').value = url; break; }
    }
  }).catch(() => {});
}

function closeSetupModal() {
  $('#setup-modal').classList.add('hidden');
  sessionStorage.setItem('smr_setup_dismissed', '1');
  $('#setup-result').classList.add('hidden');
}

function updateWizardUI() {
  document.querySelectorAll('.wizard-step').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.step) === wizardStep);
    el.classList.toggle('done', Number(el.dataset.step) < wizardStep);
  });
  document.querySelectorAll('.wizard-panel').forEach((el) => {
    el.classList.toggle('hidden', Number(el.dataset.panel) !== wizardStep);
  });
  $('#setup-prev').classList.toggle('hidden', wizardStep === 1);
  $('#setup-next').classList.toggle('hidden', wizardStep >= 4);
  $('#setup-save').classList.toggle('hidden', wizardStep !== 4);
  $('#setup-skip').classList.toggle('hidden', wizardStep === 4);
  $('#setup-result').classList.add('hidden');
}

// 提供商选择自动填 URL
$('#setup-provider').addEventListener('change', () => {
  const v = $('#setup-provider').value;
  if (v && v !== 'custom') $('#setup-baseurl').value = v;
});
// "与文本模型相同" 勾选切换
$('#setup-vision-same').addEventListener('change', () => {
  $('#setup-vision-fields').classList.toggle('hidden', $('#setup-vision-same').checked);
});
function syncAsrFollowFields() {
  const follow = $('#setup-asr-follow');
  const fields = $('#setup-asr-fields');
  if (!follow || !fields) return;
  fields.classList.toggle('hidden', follow.checked);
}
$('#setup-asr-follow')?.addEventListener('change', syncAsrFollowFields);

let ASR_PRESETS = [];
function selectedAsrPreset() {
  const id = $('#setup-asr-preset')?.value;
  return ASR_PRESETS.find((p) => p.id === id) || null;
}
function asrFollowsLlm(p) {
  if (!p) return false;
  if (p.followLlm) return true;
  if (p.followLlmIf === 'siliconflow') return /siliconflow/i.test($('#setup-baseurl')?.value || '');
  return false;
}
function fillOneAsrPresetSelect(sel, preferred) {
  if (!sel || !ASR_PRESETS.length) return;
  const cur = preferred || sel.value;
  sel.innerHTML = '';
  const groups = {};
  for (const p of ASR_PRESETS) {
    if (!groups[p.group]) {
      const og = document.createElement('optgroup');
      og.label = p.groupLabel || p.group;
      groups[p.group] = og;
      sel.appendChild(og);
    }
    const opt = document.createElement('option');
    opt.value = p.id;
    let mark = '';
    if (p.localReady === true) mark = ' · 已就绪';
    if (p.localReady === false) mark = ' · 未下载';
    opt.textContent = p.label + mark;
    groups[p.group].appendChild(opt);
  }
  if (cur && ASR_PRESETS.some((p) => p.id === cur)) sel.value = cur;
}
function fillAsrPresetSelect() {
  fillOneAsrPresetSelect($('#setup-asr-preset'));
}
let lastAsrStatus = null;
function syncCrawlAsrPreset(asr) {
  if (asr) lastAsrStatus = asr;
  const cfg = asr || lastAsrStatus;
  if (!cfg) return;
  fillOneAsrPresetSelect($('#opt-asr-preset'), cfg.preset);
  const lab = $('#opt-asr-preset-label');
  if (lab) lab.textContent = cfg.presetLabel ? `当前：${cfg.presetLabel}` : '';
}
function applyAsrPresetUi(opts = {}) {
  const p = selectedAsrPreset();
  const hint = $('#setup-asr-hint');
  const dl = $('#setup-asr-download');
  const custom = $('#setup-asr-custom');
  const keyOnly = $('#setup-asr-key-only');
  if (!p) return;
  if (hint) hint.textContent = p.hint || '';
  if (dl) {
    if (p.downloadUrl) {
      dl.classList.remove('hidden');
      const ready = p.localReady ? '（tools/ 已有此文件）' : '（下载后放到项目 tools/ 目录）';
      dl.innerHTML = `模型文件 ${ready}：<a href="${esc(p.downloadUrl)}" target="_blank" rel="noopener">${esc(p.whisperFile || p.downloadUrl)}</a>`;
    } else {
      dl.classList.add('hidden');
      dl.innerHTML = '';
    }
  }
  const showCustom = p.id === 'custom' || p.id === 'auto' || p.id === 'local-openai-stt';
  custom?.classList.toggle('hidden', !showCustom);
  const showCloudKey = p.group === 'cloud' && p.needKey && !asrFollowsLlm(p);
  keyOnly?.classList.toggle('hidden', !showCloudKey);
  if (!opts.skipFill) {
    if (p.engine && $('#setup-asr-engine')) $('#setup-asr-engine').value = p.engine;
    if (p.model != null && $('#setup-asr-model')) $('#setup-asr-model').value = p.model;
    if (p.baseUrl && $('#setup-asr-baseurl')) $('#setup-asr-baseurl').value = p.baseUrl;
    if ($('#setup-asr-follow')) $('#setup-asr-follow').checked = asrFollowsLlm(p);
  }
  syncAsrFollowFields();
}
async function loadAsrPresets() {
  try {
    const r = await apiFetch('/api/asr/presets');
    const d = await r.json();
    ASR_PRESETS = d.presets || [];
    fillAsrPresetSelect();
    syncCrawlAsrPreset();
    applyAsrPresetUi({ skipFill: true });
  } catch { /* ignore */ }
}
loadAsrPresets();
$('#setup-asr-preset')?.addEventListener('change', () => applyAsrPresetUi());
$('#setup-provider')?.addEventListener('change', () => applyAsrPresetUi({ skipFill: true }));
$('#setup-baseurl')?.addEventListener('change', () => applyAsrPresetUi({ skipFill: true }));

$('#setup-prev').onclick = () => { if (wizardStep > 1) { wizardStep--; updateWizardUI(); } };
$('#setup-next').onclick = () => {
  if (wizardStep === 1) {
    if (!$('#setup-baseurl').value.trim()) { alert('请填写 API 地址'); return; }
    if (!$('#setup-apikey').value.trim()) { alert('请填写 API Key'); return; }
    if (!$('#setup-model').value.trim()) { alert('请填写模型名称'); return; }
  }
  if (wizardStep < 4) { wizardStep++; updateWizardUI(); }
};

$('#setup-close').onclick = closeSetupModal;
$('#setup-open').onclick = openSetupModal;
$('#setup-skip').onclick = closeSetupModal;
$('#setup-modal').onclick = (e) => { if (e.target.id === 'setup-modal') closeSetupModal(); };

// 连接测试
async function runTest(type) {
  const el = $(`#test-${type}-result`);
  el.textContent = '测试中…'; el.className = 'test-status';
  await saveCurrentConfig(true).catch(() => {});
  try {
    const r = await apiFetch('/api/settings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) });
    const d = await r.json();
    if (!d.ok) {
      el.textContent = `❌ ${d.error || '失败'}`;
      el.className = 'test-status err';
    } else {
      const kind = d.probe === 'config' ? '仅配置探测' : '连通';
      el.textContent = `✅ ${kind}（${d.model || 'ok'}${d.latencyMs != null ? '，' + d.latencyMs + 'ms' : ''}）${d.warning ? ' · ' + d.warning : ''}`;
      el.className = 'test-status ok';
    }
  } catch (e) { el.textContent = `❌ ${e.message}`; el.className = 'test-status err'; }
}
$('#test-text').onclick = () => runTest('text');
$('#test-vision').onclick = () => runTest('vision');
$('#test-asr')?.addEventListener('click', () => runTest('asr'));

function collectFormPayload() {
  const payload = { llm: { baseUrl: $('#setup-baseurl').value.trim(), apiKey: $('#setup-apikey').value.trim(), model: $('#setup-model').value.trim() } };
  const vModel = $('#setup-v-model').value.trim();
  if ($('#setup-vision-same').checked) {
    payload.llm.vision = { model: vModel || '', baseUrl: '', apiKey: '' };
  } else {
    payload.llm.vision = { model: vModel, baseUrl: $('#setup-v-baseurl').value.trim(), apiKey: $('#setup-v-apikey').value.trim() };
  }
  const cookie = $('#setup-cookie').value.trim();
  if (cookie) payload.cookies = { bilibili: cookie };
  const yt = $('#setup-yt-key')?.value.trim();
  if (yt) payload.youtube = { apiKey: yt };
  const asrPreset = $('#setup-asr-preset')?.value || 'auto';
  payload.asr = { preset: asrPreset };
  const cloudKey = $('#setup-asr-apikey-cloud')?.value.trim();
  const asrKey = $('#setup-asr-apikey')?.value.trim();
  if (cloudKey) payload.asr.apiKey = cloudKey;
  else if (asrKey) payload.asr.apiKey = asrKey;
  if (asrPreset === 'custom' || asrPreset === 'auto' || asrPreset === 'local-openai-stt') {
    payload.asr.engine = $('#setup-asr-engine')?.value || 'auto';
    payload.asr.enabled = payload.asr.engine !== 'off';
    payload.asr.model = $('#setup-asr-model')?.value.trim() || '';
    payload.asr.followLlm = $('#setup-asr-follow')?.checked !== false;
    if (!$('#setup-asr-follow')?.checked) {
      payload.asr.baseUrl = $('#setup-asr-baseurl')?.value.trim() || '';
    }
  }
  return payload;
}

async function saveCurrentConfig(silent = false) {
  const r = await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectFormPayload()) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '保存失败');
  return d;
}

$('#setup-save').onclick = async () => {
  const btn = $('#setup-save');
  const out = $('#setup-result');
  btn.disabled = true; btn.textContent = '保存中…';
  out.className = 'result'; out.classList.remove('hidden'); out.textContent = '保存并检测中…';
  try {
    const d = await saveCurrentConfig(false);
    const tags = [];
    if (d.textConfigured) tags.push('文本模型 ✓');
    if (d.visionConfigured) tags.push('视觉模型 ✓');
    if (d.biliCookieConfigured) tags.push('B站 Cookie ✓');
    if (d.youtubeConfigured) tags.push('YouTube Key ✓');
    out.className = 'result ok';
    out.textContent = '✅ 配置已保存: ' + tags.join(' / ') + '。页面即将刷新…';
    setTimeout(() => { closeSetupModal(); location.reload(); }, 1800);
  } catch (e) { out.className = 'result err'; out.textContent = '保存失败: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = '保存配置'; }
};

// ---- 识图模型分析总开关（视觉模型消费较高，可一键禁用） ----
function renderVisionToggle(enabled) {
  const btn = $('#vision-toggle');
  if (!btn) return;
  btn.textContent = enabled ? '👁 识图模型: 启用中' : '⛔ 识图模型: 已禁用';
  btn.className = 'mini' + (enabled ? ' vision-on' : ' vision-off');
  btn.title = enabled
    ? '识图模型分析已启用（关键帧/图片识别会消耗视觉模型额度）。点击禁用以节省消费'
    : '识图模型分析已禁用（不会调用视觉模型，仅使用文本模型）。点击启用';
}
$('#vision-toggle').addEventListener('click', async () => {
  const btn = $('#vision-toggle');
  const enabled = !btn.classList.contains('vision-on');
  btn.textContent = '切换中…';
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visionEnabled: enabled }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '设置失败');
    renderVisionToggle(d.visionEnabled);
  } catch (e) {
    btn.textContent = '设置失败';
  } finally {
    btn.disabled = false;
  }
});

// ---- 日志流 ----
function progressHtml(p) {
  if (!p) return '';
  const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
  return `
    <div class="task-progress">
      <div class="tp-row"><span class="tp-stage">${esc(p.stageLabel || '处理中')}</span><span class="tp-pct">${pct}%</span></div>
      <div class="tp-bar"><div class="tp-fill" style="width:${pct}%"></div></div>
      ${p.message ? `<div class="tp-msg">${esc(p.message)}</div>` : ''}
    </div>`;
}

function updateTaskProgressDom(taskId, p) {
  const box = $('#task-list');
  if (!box) return;
  const el = box.querySelector(`.task[data-id="${taskId}"]`);
  if (!el) return;
  const slot = el.querySelector('.task-progress-slot');
  if (slot) slot.innerHTML = progressHtml(p);
}

function appendLog(entry) {
  const view = $('#log-view');
  const line = document.createElement('div');
  line.className = entry.level;
  const t = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${t}] [${entry.level}] ${entry.msg}`;
  if (entry.taskId) line.textContent += ` (${entry.taskId})`;
  view.appendChild(line);
  while (view.childNodes.length > 200) view.removeChild(view.firstChild);
  view.scrollTop = view.scrollHeight;
  // SSE 进度事件 → 实时更新任务列表里的进度条
  if (entry.msg === '采集进度' && entry.taskId) {
    const p = { stage: entry.stage, stageLabel: entry.stageLabel, percent: entry.percent, current: entry.current, total: entry.total, message: entry.message };
    updateTaskProgressDom(entry.taskId, p);
    const t = tasks.find((x) => x.taskId === entry.taskId);
    if (t) t.progress = p;
  }
  if (entry.msg === '语音转写完成' && currentTask && entry.taskId === currentTask.taskId && currentDetailTab === 'subtitles') {
    const body = $('#detail-body');
    if (body && !$('#detail-modal')?.classList.contains('hidden')) renderSubtitles(body);
  }
}

function connectEvents() {
  const es = new EventSource(authQuery('/api/events'));
  es.onmessage = (e) => {
    try { appendLog(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ---- 任务列表 ----
async function loadTasks() {
  try {
    const r = await apiFetch('/api/tasks');
    const d = await r.json();
    tasks = d.tasks || [];
    renderTasks();
  } catch { /* ignore */ }
}

function renderTasks() {
  const box = $('#task-list');
  const list = tasks.filter((t) => {
    if (taskStatusFilter !== 'all' && t.status !== taskStatusFilter) return false;
    if (taskTypeFilter !== 'all') {
      const kind = t.type === 'collection' ? 'collection' : (t.type === 'youtube' ? 'youtube' : 'bilibili');
      if (kind !== taskTypeFilter) return false;
    }
    const q = taskQuery.trim().toLowerCase();
    if (!q) return true;
    return [t.title, t.taskId, t.url].some((s) => String(s || '').toLowerCase().includes(q));
  });
  if (!tasks.length) { box.innerHTML = '<div class="empty">暂无任务，去上方发起采集吧</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的任务</div>'; return; }
  box.innerHTML = list.map((t) => `
    <div class="task" data-id="${esc(t.taskId)}">
      <div class="task-head">
        <div class="t">${esc(t.title)}</div>
        ${t.status !== 'running' ? '<button class="mini rerun-btn" title="重新采集（清标记重跑）">🔄</button>' : '<button class="mini cancel-btn" title="取消运行中的任务">取消</button>'}
        <button class="mini del-btn" title="删除任务及全部文件">🗑</button>
      </div>
      <div class="m">
        <span class="badge ${t.status}">${t.status}</span>
        <span>${fmtTime(t.createdAt)}</span>
        <span>${t.files?.length || 0} 个文件</span>
      </div>
      <div class="task-progress-slot">${t.status === 'running' || (t.progress && t.status !== 'finished') ? progressHtml(t.progress) : ''}</div>
    </div>`).join('');
  box.querySelectorAll('.task').forEach((el) => {
    el.onclick = () => openDetail(el.dataset.id);
    const del = el.querySelector('.del-btn');
    if (del) {
      del.onclick = async (e) => {
        e.stopPropagation();
        const task = tasks.find((x) => x.taskId === el.dataset.id);
        const name = task ? task.title : el.dataset.id;
        if (!confirm(`确定删除任务「${name}」吗？\n将连同全部文件（评论/弹幕/字幕/视频等）一起删除，不可恢复！`)) return;
        try {
          const r = await apiFetch('/api/tasks/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' });
          const d = await r.json();
          if (!r.ok) { alert('删除失败: ' + (d.error || r.status)); return; }
          tasks = tasks.filter((x) => x.taskId !== el.dataset.id);
          renderTasks();
        } catch (err) { alert('删除失败: ' + err.message); }
      };
    }
    const cancel = el.querySelector('.cancel-btn');
    if (cancel) {
      cancel.onclick = async (e) => {
        e.stopPropagation();
        const task = tasks.find((x) => x.taskId === el.dataset.id);
        const name = task ? task.title : el.dataset.id;
        if (!confirm(`确定取消任务「${name}」吗？`)) return;
        try {
          const r = await apiFetch('/api/tasks/' + encodeURIComponent(el.dataset.id) + '/cancel', { method: 'POST' });
          const d = await r.json();
          if (!r.ok) { alert('取消失败: ' + (d.error || r.status)); return; }
          loadTasks();
        } catch (err) { alert('取消失败: ' + err.message); }
      };
    }
    const rerun = el.querySelector('.rerun-btn');
    if (rerun) {
      rerun.onclick = async (e) => {
        e.stopPropagation();
        const task = tasks.find((x) => x.taskId === el.dataset.id);
        const name = task ? task.title : el.dataset.id;
        if (!confirm(`确定重新采集「${name}」吗？\n将清空完成/失败标记并重新执行（已下载的媒体文件会跳过下载）。`)) return;
        try {
          const r = await apiFetch('/api/tasks/' + encodeURIComponent(el.dataset.id) + '/rerun', { method: 'POST' });
          const d = await r.json();
          if (!r.ok) { alert('重采失败: ' + (d.error || r.status)); return; }
          loadTasks();
        } catch (err) { alert('重采失败: ' + err.message); }
      };
    }
  });
}

// ---- 任务详情 ----
let currentTask = null;
let currentDetailTab = 'all';
let currentAll = null; // 总览/字幕页共享的聚合 JSON（含多分 P pageList）
function hasTaskFile(...names) {
  const set = new Set((currentTask?.files || []).map((f) => f.name));
  return names.some((n) => set.has(n));
}
function updateDetailTabs() {
  const isYt = currentTask?.type === 'youtube';
  const map = {
    all: true,
    detail: hasTaskFile('bilibili_detail.json', 'youtube_detail.json'),
    comments: hasTaskFile('bilibili_comment.json', 'youtube_comments.json'),
    danmaku: hasTaskFile('bilibili_danmaku.json'),
    subtitles: hasTaskFile('subtitles.json', 'youtube_captions.json', 'current.mp4', 'current.mp3', 'current_audio.m4s', 'current_audio.mp3'),
    summary: hasTaskFile('bilibili_summary.json') && !isYt,
    words: hasTaskFile('bilibili_comment.json', 'youtube_comments.json', 'bilibili_danmaku.json'),
    analyze: true,
  };
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('hidden', map[b.dataset.tab] === false);
  });
  document.querySelectorAll('[data-export="danmaku"]').forEach((b) => {
    b.classList.toggle('hidden', !hasTaskFile('bilibili_danmaku.json'));
  });
  document.querySelectorAll('[data-export="comments"]').forEach((b) => {
    b.classList.toggle('hidden', !hasTaskFile('bilibili_comment.json', 'youtube_comments.json'));
  });
}
async function openDetail(id) {
  const r = await apiFetch('/api/tasks/' + encodeURIComponent(id));
  currentTask = await r.json();
  currentAll = null;
  $('#detail-title').textContent = currentTask.title + '  (' + currentTask.status + ')';
  $('#detail-modal').classList.remove('hidden');
  updateDetailTabs();
  switchTab('all');
}

function switchTab(tab) {
  currentDetailTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('#detail-body');
  body.innerHTML = '<div class="empty">加载中…</div>';
  if (tab === 'all') return renderOverview(body);
  if (tab === 'detail') return renderJson(body, 'bilibili_detail.json');
  if (tab === 'comments') return renderList(body, 'bilibili_comment.json', (i) => `${esc(i.user)} · 👍${fmt(i.like)} · ${fmtTime(i.ctime ? i.ctime * 1000 : i.publishedAt)}<div class="c">${esc(i.content)}</div>`);
  if (tab === 'danmaku') return renderList(body, 'bilibili_danmaku.json', (i) => `[${Number(i.time).toFixed(1)}s] <span class="u">${esc(i.pool)}</span><div class="c">${esc(i.content)}</div>`);
  if (tab === 'subtitles') return renderSubtitles(body);
  if (tab === 'summary') return renderJson(body, 'bilibili_summary.json');
  if (tab === 'words') return renderWords(body);
  if (tab === 'analyze') return renderAnalyze(body);
}

function downloadExport(type, format) {
  const id = encodeURIComponent(currentTask.taskId);
  const a = document.createElement('a');
  a.href = authQuery(`/api/tasks/${id}/export?type=${type}&format=${format}`);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function renderWords(body) {
  body.innerHTML = `
    <div class="row">
      <select id="wc-type">${hasTaskFile('bilibili_danmaku.json') ? '<option value="comments">评论</option><option value="danmaku">弹幕</option>' : '<option value="comments">评论</option>'}</select>
      <button id="wc-run">统计</button>
    </div>
    <div class="viz-grid">
      <div class="viz-card">
        <h4>高频词</h4>
        <div id="wc-out" class="words"></div>
      </div>
      <div class="viz-card">
        <h4 id="dist-title">时间分布</h4>
        <div id="dist-out" class="words"></div>
      </div>
    </div>`;
  const run = async () => {
    const out = $('#wc-out');
    out.innerHTML = '<div class="empty">统计中…</div>';
    const type = $('#wc-type').value;
    try {
      const r = await apiFetch(`/api/tasks/${encodeURIComponent(currentTask.taskId)}/wordcount?type=${type}&top=50`);
      const d = await r.json();
      const max = Math.max(1, ...(d.words || []).map((w) => w.count));
      out.innerHTML = `<div style="flex-basis:100%;color:var(--dim);font-size:12px">共 ${d.total} 条文本</div>` +
        (d.words || []).map((w) => `
          <div class="wbar">
            <span class="wbar-label">${esc(w.word)}</span>
            <div class="wbar-track"><div class="wbar-fill" style="width:${Math.round((w.count / max) * 100)}%"></div></div>
            <span class="wbar-n">${w.count}</span>
          </div>`).join('');
      await renderDistribution(type);
    } catch (e) { out.innerHTML = '<div class="empty">统计失败: ' + esc(e.message) + '</div>'; }
  };
  $('#wc-run').onclick = run;
  run();
}

/** 时间分布: 评论按天 / 弹幕按视频进度分桶（纯前端计算，零依赖） */
async function renderDistribution(type) {
  const out = $('#dist-out');
  const title = $('#dist-title');
  const file = type === 'danmaku' ? 'bilibili_danmaku.json' : 'bilibili_comment.json';
  try {
    const r = await loadTaskFile(file);
    if (!r || !r.ok) { out.innerHTML = '<div class="empty">无数据</div>'; return; }
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) { out.innerHTML = '<div class="empty">无数据</div>'; return; }
    if (type === 'danmaku') {
      // 按视频进度分 20 桶
      const maxT = Math.max(...items.map((i) => Number(i.time) || 0), 1);
      const buckets = new Array(20).fill(0);
      for (const i of items) {
        const b = Math.min(19, Math.floor(((Number(i.time) || 0) / maxT) * 20));
        buckets[b]++;
      }
      const bmax = Math.max(1, ...buckets);
      title.textContent = `弹幕时间分布（${fmt(maxT)} 秒，20 段）`;
      out.innerHTML = buckets.map((n, b) => `
        <div class="wbar">
          <span class="wbar-label" style="min-width:52px">${Math.round((b / 20) * maxT)}s</span>
          <div class="wbar-track"><div class="wbar-fill" style="width:${Math.round((n / bmax) * 100)}%"></div></div>
          <span class="wbar-n">${n}</span>
        </div>`).join('');
    } else {
      // 评论按天分布
      const dayMap = new Map();
      for (const i of items) {
        let ms = 0;
        if (Number(i.ctime)) ms = Number(i.ctime) * 1000;
        else if (i.publishedAt) ms = Date.parse(i.publishedAt) || 0;
        if (!ms) continue;
        const day = new Date(ms).toISOString().slice(0, 10);
        dayMap.set(day, (dayMap.get(day) || 0) + 1);
      }
      const days = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (!days.length) { out.innerHTML = '<div class="empty">评论无时间信息</div>'; return; }
      const dmax = Math.max(1, ...days.map(([, n]) => n));
      title.textContent = `评论按天分布（${days.length} 天，最早 ${days[0][0]}）`;
      out.innerHTML = days.map(([day, n]) => `
        <div class="wbar">
          <span class="wbar-label" style="min-width:92px">${esc(day.slice(5))}</span>
          <div class="wbar-track"><div class="wbar-fill" style="width:${Math.round((n / dmax) * 100)}%"></div></div>
          <span class="wbar-n">${n}</span>
        </div>`).join('');
    }
  } catch (e) { out.innerHTML = '<div class="empty">分布加载失败: ' + esc(e.message) + '</div>'; }
}

async function renderOverview(body) {
  const id = encodeURIComponent(currentTask.taskId);
  // 聚合数据先取（多分 P 的 pageList 决定播放器是否可切换）
  let r = await apiFetch(`/api/tasks/${id}/data/bilibili_all.json`).catch(() => null);
  if (!r || !r.ok) r = await apiFetch(`/api/tasks/${id}/data/youtube_all.json`).catch(() => null);
  let all = null;
  if (r && r.ok) { all = await r.json(); currentAll = all; }

  // 分 P 播放: 根目录 current.mp4 + 各 pNN/current.mp4
  const videoByDir = new Map();
  for (const f of (currentTask.files || [])) {
    const m = String(f.name).match(/^(p\d+)\/current\.mp4$/i);
    if (m) videoByDir.set(m[1], f.name);
  }
  if ((currentTask.files || []).some((f) => f.name === 'current.mp4')) {
    videoByDir.set('.', 'current.mp4');
  }
  const pageList = (all?.detail?.pageList) || [];
  const playable = pageList.length
    ? pageList.filter((p) => videoByDir.has(p.dir))
    : [...videoByDir.keys()].map((dir, i) => ({ index: i + 1, part: '', dir }));
  let videoHtml = '';
  if (playable.length) {
    const pageSel = playable.length > 1
      ? `<div class="row" style="margin:6px 0"><label>选择分P:
          <select id="ov-page">${playable.map((p) => `<option value="${esc(p.dir)}">P${p.index} ${esc(String(p.part || '').slice(0, 28))}</option>`).join('')}</select>
        </label></div>`
      : '';
    const first = videoByDir.get(playable[0].dir);
    videoHtml = pageSel
      + `<video controls id="ov-video" src="${esc(authQuery(`/api/tasks/${id}/data/${first.split('/').map(encodeURIComponent).join('/')}`))}"></video>`;
  }

  let allHtml = '';
  let collectionBtn = '';
  if (all) {
    if (all.type === 'collection') {
      collectionBtn = `<div class="row" style="margin-bottom:8px"><button id="ov-report" class="primary">生成合集学习报告</button></div>`;
    }
    const pageN = Number(all.stats?.pages || all.detail?.pages || 0);
    if (pageN > 1 && playable.length < 2) {
      allHtml = `<div class="empty" style="text-align:left;margin-bottom:8px">该稿件共 ${pageN} 个分P：第 1 P 在任务根目录（current.mp4 / 字幕 / 弹幕），第 2 P 起在 p02/ 等子目录（未下载的分 P 不出现在播放列表）。</div>`;
    }
    allHtml += `<pre>${esc(JSON.stringify(all, null, 2))}</pre>`;
  }
  const files = (currentTask.files || []).map((f) => `${esc(f.name)} (${fmt(f.size)}B)`).join('\n');
  body.innerHTML = collectionBtn + videoHtml + (allHtml || (files ? `<pre>${esc(files)}</pre>` : '<div class="empty">该任务无聚合文件</div>'));
  const pageSelEl = $('#ov-page');
  if (pageSelEl) {
    pageSelEl.onchange = () => {
      const file = videoByDir.get(pageSelEl.value);
      const v = $('#ov-video');
      if (file && v) v.src = authQuery(`/api/tasks/${id}/data/${file.split('/').map(encodeURIComponent).join('/')}`);
    };
  }
  const reportBtn = $('#ov-report');
  if (reportBtn) {
    reportBtn.onclick = () => { switchTab('analyze'); setTimeout(() => $('#col-report')?.click(), 0); };
  }
}

async function renderJson(body, file) {
  const r = await loadTaskFile(file);
  if (!r || !r.ok) { body.innerHTML = '<div class="empty">无该文件</div>'; return; }
  body.innerHTML = `<pre>${esc(JSON.stringify(await r.json(), null, 2))}</pre>`;
}

async function renderSubtitles(body) {
  const taskId = currentTask.taskId;
  // 分 P 字幕: 根目录 subtitles.json + 各 pNN/subtitles.json
  const subByDir = new Map();
  for (const f of (currentTask.files || [])) {
    const m = String(f.name).match(/^(p\d+)\/subtitles\.json$/i);
    if (m) subByDir.set(m[1], f.name);
  }
  if ((currentTask.files || []).some((f) => f.name === 'subtitles.json')) {
    subByDir.set('.', 'subtitles.json');
  }
  const pageList = (currentAll?.detail?.pageList) || [];
  const ordered = pageList.length
    ? pageList.map((p) => ({ dir: p.dir, label: `P${p.index} ${String(p.part || '').slice(0, 24)}` }))
    : [...subByDir.keys()].map((dir, i) => ({ dir, label: dir === '.' ? 'P1' : 'P' + dir.slice(1) }));

  body.innerHTML = `
    <div class="row" style="margin-bottom:8px;flex-wrap:wrap">
      ${ordered.length > 1 && subByDir.size > 0 ? `<label>选择分P: <select id="sub-page">${ordered.map((p) => {
        const has = subByDir.has(p.dir);
        return `<option value="${esc(p.dir)}" ${has ? '' : 'disabled'}>${esc(p.label)}${has ? '' : '（无字幕）'}</option>`;
      }).join('')}</select></label>` : ''}
      <button id="asr-run" class="mini">语音转写补字幕</button>
      <label class="mini"><input id="asr-force" type="checkbox"> 覆盖已有字幕</label>
      <span id="asr-hint" class="cfg"></span>
      <button id="va-run" class="mini">🎬 AI 视频解析</button>
      <span id="va-hint" class="cfg"></span>
    </div>
    <div id="va-body"></div>
    <div id="sub-body"><div class="empty">加载中…</div></div>`;
  const hint = $('#asr-hint');
  const box = $('#sub-body');
  if (ordered.length > 1) {
    hint.textContent = '补转写只处理第 1 P（根目录视频）';
  } else if (lastAsrStatus?.timestamps === 'weak') {
    hint.textContent = '本引擎通常无逐句时间轴（如 SenseVoice）';
  }
  $('#asr-run').onclick = async () => {
    hint.textContent = '已提交…';
    try {
      const r = await apiFetch('/api/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, force: !!$('#asr-force')?.checked }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      hint.textContent = d.message || '已入队，见实时日志';
    } catch (e) { hint.textContent = '失败: ' + e.message; }
  };
  $('#va-run').onclick = async () => {
    const vaHint = $('#va-hint');
    const vaBody = $('#va-body');
    vaHint.textContent = '已提交…';
    vaBody.innerHTML = '';
    try {
      const r = await apiFetch('/api/analyze-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId }),
      });
      const d0 = await r.json();
      if (!r.ok) throw new Error(d0.error || ('HTTP ' + r.status));
      vaHint.textContent = d0.message || '解析已开始…';
      for (let i = 0; i < 120; i++) {
        await new Promise((res2) => setTimeout(res2, 5000));
        const sr = await apiFetch('/api/analyze-video?task_id=' + encodeURIComponent(taskId));
        const sd = await sr.json();
        if (!sr.ok) throw new Error(sd.error || ('HTTP ' + sr.status));
        if (sd.status === 'running') { vaHint.textContent = '解析中… ' + (sd.stage || sd.route || ''); continue; }
        if (sd.status === 'done') {
          vaHint.textContent = '解析完成 · 路线 ' + (sd.route || '?') + ' · 模型 ' + (sd.model || '?') + ' · 已写入 video-analysis.md';
          vaBody.innerHTML = '<div class="empty" style="text-align:left;padding:0 0 10px">《视频内容解析报告》</div><pre style="white-space:pre-wrap;text-align:left">' + esc(sd.markdown || '') + '</pre>';
          return;
        }
        if (sd.status === 'error') throw new Error(sd.error || '解析失败');
        if (sd.status === 'none') { vaHint.textContent = '后台启动中…'; continue; }
      }
      vaHint.textContent = '轮询超时（解析仍在后台进行，稍后刷新此页查看）';
    } catch (e) { vaHint.textContent = '失败: ' + e.message; }
  };
  const showSubs = async (file) => {
    const r = await loadTaskFile(file);
    if (!r || !r.ok) {
      box.innerHTML = '<div class="empty">该分P无字幕。可点上方「语音转写补字幕」（需已下载音频/视频，并配置 whisper.cpp 或转写 API）。</div>';
      return;
    }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data?.body?.body || data?.body || []);
    const src = data?.source === 'asr' ? `语音转写 · ${data.engine || ''}` : (data?.lan ? `官方/平台 · ${data.lan}` : '字幕');
    if (!Array.isArray(arr) || !arr.length) {
      box.innerHTML = `<div class="empty">${esc(src)}（空）</div><pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
      return;
    }
    box.innerHTML = `<div class="empty" style="text-align:left;padding:0 0 10px">${esc(src)} · 共 ${fmt(arr.length)} 条</div>` +
      arr.map((s) => {
        const from = Number(s.from ?? s.start ?? 0);
        const text = s.content || s.text || '';
        return `<div class="item">[${from.toFixed(1)}s] <div class="c">${esc(text)}</div></div>`;
      }).join('');
  };
  const pageSel = $('#sub-page');
  if (pageSel) {
    pageSel.onchange = () => showSubs(subByDir.get(pageSel.value));
    showSubs(subByDir.get(pageSel.value));
  } else {
    await showSubs('subtitles.json');
  }
}

async function renderList(body, file, fmtItem) {
  const r = await loadTaskFile(file);
  if (!r || !r.ok) { body.innerHTML = '<div class="empty">无该文件</div>'; return; }
  const items = await r.json();
  if (!Array.isArray(items)) { body.innerHTML = `<pre>${esc(JSON.stringify(items, null, 2))}</pre>`; return; }
  body.innerHTML = `<div class="empty" style="text-align:left;padding:0 0 10px">共 ${fmt(items.length)} 条</div>` +
    items.map((i) => `<div class="item">${fmtItem(i)}</div>`).join('');
}

const TASK_FILE_ALT = {
  'bilibili_detail.json': 'youtube_detail.json',
  'bilibili_comment.json': 'youtube_comments.json',
  'subtitles.json': 'youtube_captions.json',
};
async function loadTaskFile(file) {
  const id = encodeURIComponent(currentTask.taskId);
  let r = await apiFetch(`/api/tasks/${id}/data/${file}`).catch(() => null);
  if (r && r.ok) return r;
  const alt = TASK_FILE_ALT[file];
  if (!alt) return r;
  return apiFetch(`/api/tasks/${id}/data/${alt}`).catch(() => null);
}

async function renderAnalyze(body) {
  const id = encodeURIComponent(currentTask.taskId);
  const isCollection = currentTask.type === 'collection';
  const isYt = currentTask.type === 'youtube';
  const hasDanmaku = hasTaskFile('bilibili_danmaku.json');
  const hasVideo = hasTaskFile('current.mp4');
  const kfOk = hasDanmaku && hasVideo;
  const kfReason = !hasDanmaku ? '需要弹幕文件' : (!hasVideo ? '需要 current.mp4' : '');
  const danmakuOpt = (hasDanmaku && !isYt)
    ? '<option value="danmaku">仅弹幕</option>'
    : (isYt ? '<option value="danmaku" disabled>仅弹幕（YouTube 无弹幕）</option>' : '');
  body.innerHTML = `
    <div class="row">
      <select id="an-type">
        <option value="all">${isYt ? '综合（视频+评论）' : '综合（视频+弹幕+评论）'}</option>
        <option value="comments">仅评论</option>
        ${danmakuOpt}
      </select>
      <button id="an-run">开始 LLM 分析</button>
      ${kfOk
        ? '<button id="kf-run">🎯 关键帧分析（弹幕→识图模型）</button>'
        : `<button id="kf-run" disabled title="${esc(kfReason)}">🎯 关键帧分析（${esc(kfReason)}）</button>`}
      ${isCollection ? '<button id="col-report">合集学习报告</button>' : ''}
    </div>
    <div id="an-saved"></div>
    <pre id="an-out" class="hidden"></pre>
    <div id="kf-out" class="hidden"></div>`;
  // 展示已保存的分析结果（analysis.json）
  try {
    const r = await apiFetch(`/api/tasks/${id}/data/analysis.json`);
    if (r.ok) {
      const list = await r.json();
      const arr = Array.isArray(list) ? list : [];
      if (arr.length) {
        const last = arr[arr.length - 1];
        const typeName = { all: '综合', comments: '评论', danmaku: '弹幕' }[last.type] || last.type;
        $('#an-saved').innerHTML = `<div class="empty" style="margin:6px 0">📄 已保存分析（${arr.length} 次，最近: ${typeName} @ ${fmtTime(last.createdAt)}）—— 文件: analysis.json</div>`;
      }
    }
  } catch { /* ignore */ }
  $('#an-run').onclick = async () => {
    const out = $('#an-out');
    out.classList.remove('hidden');
    out.textContent = '分析中…';
    try {
      const r = await apiFetch('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: currentTask.taskId, type: $('#an-type').value }),
      });
      const d = await r.json();
      out.textContent = JSON.stringify(d, null, 2);
    } catch (e) { out.textContent = '分析失败: ' + e.message; }
  };
  $('#kf-run')?.addEventListener('click', async () => {
    if ($('#kf-run')?.disabled) return;
    const out = $('#kf-out');
    out.classList.remove('hidden');
    out.innerHTML = '<div class="empty">定位关键时间点并提取画面（需视频文件 + 弹幕 + 视觉模型），通常 1-2 分钟…</div>';
    try {
      const r = await apiFetch('/api/keyframes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: currentTask.taskId }),
      });
      const d = await r.json();
      if (d.error) { out.innerHTML = `<div class="empty">失败: ${esc(d.error)}</div>`; return; }
      out.innerHTML = '<div class="empty">共 ' + d.moments.length + ' 个关键时间点（定位: ' + (d.locator === 'llm' ? 'AI 语义分析' : '关键词规则') + '）' +
        (d.visionEnabled === false ? ' — ⛔ 视觉识别已禁用（识图模型开关已关），仅定位+提帧，可点击顶部 "识图模型" 按钮启用' : '') + '</div>' +
        d.moments.map((m) => `
          <div class="kf-item" style="margin:10px 0;padding:10px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
            <b>${esc(m.timeLabel)}</b> <span style="color:#999">得分 ${m.score}</span>
            ${m.reason ? `<div style="color:#0a58ca;font-size:13px;margin:2px 0">定位依据: ${esc(m.reason)}</div>` : ''}
            <div class="kf-danmaku" style="color:#666;font-size:13px;margin:4px 0">
              弹幕: ${esc((m.danmaku || []).map((h) => h.content).slice(0, 4).join(' / '))}
            </div>
            <div class="kf-frames" style="display:flex;gap:4px;flex-wrap:wrap;margin:6px 0">
              ${(m.frames || []).map((f) => `<img src="${esc(authQuery('/api/tasks/' + id + '/data/keyframes/' + encodeURIComponent(f)))}" style="height:90px;border-radius:4px" alt="${esc(f)}">`).join('')}
            </div>
            ${m.analysis ? `
            <div style="font-size:13px">画面: ${esc(m.analysis.description || '')}</div>
            ${m.analysis.on_screen_text?.length ? `<div style="font-size:13px;color:#0a58ca">画面文字: ${esc(m.analysis.on_screen_text.join('、'))}</div>` : ''}
            <div style="font-size:13px;color:#198754">为何值得截图: ${esc(m.analysis.why_key || '')}</div>` : '<div style="color:#dc3545">识别失败</div>'}
          </div>`).join('');
    } catch (e) { out.innerHTML = `<div class="empty">失败: ${esc(e.message)}</div>`; }
  });
  $('#col-report')?.addEventListener('click', async () => {
    const out = $('#an-out');
    out.classList.remove('hidden');
    out.textContent = '正在生成合集学习报告（逐视频提炼知识点后合并出题）…';
    try {
      const r = await apiFetch('/api/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: currentTask.taskId, questions: 8 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      out.textContent = JSON.stringify(d.report || d, null, 2);
    } catch (e) { out.textContent = '失败: ' + e.message; }
  });
}

// ---- 事件绑定 ----
async function startCrawl() {
  const input = $('#crawl-input').value.trim();
  if (!input) return;
  const btn = $('#crawl-btn');
  btn.disabled = true; btn.textContent = '采集中…';
  const box = $('#crawl-result');
  box.classList.remove('hidden');
  box.className = 'result';
  box.textContent = '已提交，任务在后台执行（详情见下方任务列表与日志）…';
  try {
    const r = await apiFetch('/api/crawl', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        options: {
          danmakuCount: Number($('#opt-danmaku').value) || 0,
          commentCount: Number($('#opt-comments').value) || 0,
          subCommentCount: Number($('#opt-sub').value) || 0,
          limit: Number($('#opt-limit').value) || 5,
          quality: $('#opt-quality').value,
          section: $('#opt-section').value.trim() || undefined,
          offset: Number($('#opt-offset')?.value) || 0,
          fetchVideo: $('#opt-video').checked,
          fetchAudio: $('#opt-audio').checked,
          noComments: $('#opt-noc').checked,
          noSubtitles: $('#opt-nos').checked,
          noSummary: $('#opt-nosum').checked,
          noAsr: $('#opt-asr') ? !$('#opt-asr').checked : false,
        },
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    box.className = 'result ok';
    box.textContent = d.accepted
      ? '⏳ ' + d.message + '\n完成通知会出现在实时日志中，任务会出现在下方列表'
      : `✅ 完成: ${d.taskId}`;
    // 轮询刷新任务列表
    setTimeout(loadTasks, 3000);
  } catch (e) {
    box.className = 'result err';
    box.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '开始';
  }
}

async function analyzeClipboard() {
  const text = $('#clipboard-text').value.trim();
  if (!text) return;
  const btn = $('#clipboard-btn');
  btn.disabled = true; btn.textContent = '分析中…';
  const box = $('#crawl-result');
  box.classList.remove('hidden');
  box.className = 'result';
  box.textContent = '分析中…';
  try {
    const r = await apiFetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    box.className = 'result ok';
    box.textContent = d.analysis || JSON.stringify(d, null, 2);
  } catch (e) {
    box.className = 'result err';
    box.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'LLM 分析文本';
  }
}

async function analyzeImageFile() {
  const input = $('#image-file');
  const file = input?.files?.[0];
  if (!file) { alert('请先选择图片'); return; }
  if (file.size > 3.5 * 1024 * 1024) { alert('图片请小于 3.5MB（请求体上限约 5MB）'); return; }
  const btn = $('#image-btn');
  btn.disabled = true; btn.textContent = '分析中…';
  const box = $('#crawl-result');
  box.classList.remove('hidden');
  box.className = 'result';
  box.textContent = '分析图片中…';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
    const prompt = ($('#image-prompt')?.value || '').trim();
    const r = await apiFetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, prompt: prompt || undefined }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    box.className = 'result ok';
    box.textContent = d.analysis || JSON.stringify(d, null, 2);
  } catch (e) {
    box.className = 'result err';
    box.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'LLM 分析图片';
  }
}

$('#crawl-btn').onclick = startCrawl;
$('#clipboard-btn').onclick = analyzeClipboard;
$('#image-btn')?.addEventListener('click', analyzeImageFile);
$('#refresh-btn').onclick = loadTasks;
$('#task-search')?.addEventListener('input', () => { taskQuery = $('#task-search').value; renderTasks(); });
$('#task-status')?.addEventListener('change', () => { taskStatusFilter = $('#task-status').value; renderTasks(); });
$('#task-type')?.addEventListener('change', () => { taskTypeFilter = $('#task-type').value; renderTasks(); });
$('#opt-asr-preset')?.addEventListener('change', async () => {
  const preset = $('#opt-asr-preset').value;
  try {
    await apiFetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asr: { preset } }),
    });
    loadStatus();
  } catch { /* ignore */ }
});
$('#clear-log').onclick = () => { $('#log-view').innerHTML = ''; };
$('#modal-close').onclick = () => $('#detail-modal').classList.add('hidden');
$('#detail-modal').onclick = (e) => { if (e.target.id === 'detail-modal') $('#detail-modal').classList.add('hidden'); };
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
document.querySelectorAll('.export-bar button').forEach((b) => {
  b.onclick = () => downloadExport(b.dataset.export, b.dataset.format);
});
$('#crawl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCrawl(); });

loadStatus();
loadTasks();
connectEvents();
setInterval(loadStatus, 30000);
setInterval(loadTasks, 10000); // 任务列表自动刷新（后台任务完成可见）
