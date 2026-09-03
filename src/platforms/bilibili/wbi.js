// platforms/bilibili/wbi.js — B站 WBI 签名（算法已动态验证）
'use strict';

import crypto from 'node:crypto';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const getMixinKey = (orig) => MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join('').slice(0, 32);

export function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  params.wts = wts;
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + mixinKey).digest('hex');
}

export function parseKeyPair(pairStr) {
  if (!pairStr || !pairStr.includes('-')) return null;
  const [imgUrl, subUrl] = pairStr.split('-');
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'));
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'));
  return { img_key: imgKey, sub_key: subKey };
}

export function generateWbiUrl(baseUrl, params, keys) {
  const q = encWbi({ ...params }, keys.img_key, keys.sub_key);
  return baseUrl + (baseUrl.includes('?') ? '&' : '?') + q;
}
