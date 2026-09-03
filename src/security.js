// security.js — 本机 HTTP 防护 + LLM 地址校验 + 任务 ID 消毒
'use strict';

/** 任务目录名：禁止路径穿越 */
export function safeTaskId(id) {
  const s = String(id || '');
  if (!s || s.includes('..') || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  return s;
}

export function isLoopbackHostname(name) {
  const n = String(name || '').replace(/^\[|\]$/g, '').toLowerCase();
  return n === '127.0.0.1' || n === 'localhost' || n === '::1';
}

function hostNameFromHeader(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end >= 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(':')[0];
}

function extractToken(req) {
  const header = req.headers['x-smr-token'];
  if (header) return String(header).trim();
  const auth = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    return String(u.searchParams.get('token') || '').trim();
  } catch {
    return '';
  }
}

/**
 * 保护 /api 与 /mcp：
 * 1) 绑定回环时拒绝非本机 Host（DNS rebinding）
 * 2) 若带 Origin，必须也是回环（跨站 CSRF）
 * 3) 校验本机令牌（页面注入 / 请求头 / query）
 * @returns {string|null} 拒绝原因；null 表示放行
 */
export function denyApiRequest(req, cfg) {
  const bind = String(cfg?.server?.host || '127.0.0.1');
  const bindLoopback = isLoopbackHostname(bind);
  const hostName = hostNameFromHeader(req.headers.host);

  if (bindLoopback && !isLoopbackHostname(hostName)) {
    return '拒绝非本机 Host';
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (bindLoopback && !isLoopbackHostname(o.hostname)) return '拒绝跨站请求';
    } catch {
      return '非法 Origin';
    }
  }

  const expected = String(cfg?.server?.localToken || process.env.SMR_LOCAL_TOKEN || '');
  if (!expected) return '服务未初始化访问令牌';
  if (extractToken(req) !== expected) return '需要本机访问令牌';
  return null;
}

function ipv4Octets(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
  if (h === '0.0.0.0' || h === '::' || h === 'metadata.google.internal') return true;
  if (h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  const ip = ipv4Octets(h);
  if (ip) {
    const [a, b] = ip;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  if (h.includes(':') && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))) return true;
  return false;
}

/**
 * 校验用户填写的 OpenAI 兼容 baseUrl。
 * 允许：https 公网主机；http(s) localhost/127.0.0.1（本地模型）。
 * 拒绝：内网 IP、云元数据、非 http(s)、带用户名密码。
 * 空字符串表示「未配置」，原样返回。
 */
export function assertLlmBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new Error('模型 API 地址不是合法 URL'); }
  if (u.username || u.password) throw new Error('模型 API 地址不能包含用户名或密码');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('模型 API 地址必须是 http 或 https');
  }
  const host = u.hostname.toLowerCase();
  const loopback = isLoopbackHostname(host);
  if (loopback) return s.replace(/\/+$/, '');
  if (u.protocol !== 'https:') throw new Error('远程模型 API 必须使用 https');
  if (isBlockedHostname(host)) {
    throw new Error('不允许将模型 API 指向内网或云元数据地址');
  }
  return s.replace(/\/+$/, '');
}
