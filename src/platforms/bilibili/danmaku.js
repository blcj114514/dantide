// platforms/bilibili/danmaku.js — 弹幕 protobuf 解码（手写，零依赖；已动态验证）
'use strict';

function decodeFields(buf) {
  const fields = [];
  let pos = 0;
  const readVarint = () => {
    let r = 0n, shift = 0n, b;
    do {
      if (pos >= buf.length) throw new Error('varint truncated');
      b = buf[pos++];
      r |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return r;
  };
  while (pos < buf.length) {
    const tag = readVarint();
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) fields.push({ fieldNo, wire, value: readVarint() });
    else if (wire === 2) {
      const len = Number(readVarint());
      fields.push({ fieldNo, wire, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) { fields.push({ fieldNo, wire, value: buf.subarray(pos, pos + 8) }); pos += 8; }
    else if (wire === 5) { fields.push({ fieldNo, wire, value: buf.subarray(pos, pos + 4) }); pos += 4; }
    else throw new Error('unsupported wire type ' + wire);
  }
  return fields;
}

const str = (f) => (f && f.wire === 2 ? Buffer.from(f.value).toString('utf8') : undefined);
const num = (f) => (f ? Number(f.value) : undefined);

/**
 * 解码 DmSegMobileReply → 弹幕数组
 * { id, time(秒), content, sender(midHash), sendTime(秒), mode, pool, attributes }
 */
export function decodeDanmaku(buf) {
  const reply = decodeFields(Buffer.from(buf));
  const elems = [];
  for (const f of reply) {
    if (f.fieldNo !== 1 || f.wire !== 2) continue;
    const fields = decodeFields(Buffer.from(f.value));
    const get = (no) => fields.find((x) => x.fieldNo === no);
    const attr = num(get(13)) || 0;
    elems.push({
      id: str(get(12)) || String(num(get(1)) || ''),
      time: (num(get(2)) || 0) / 1000,
      content: str(get(7)) || '',
      sender: str(get(6)) || '',
      sendTime: num(get(8)),
      mode: num(get(3)),
      pool: ['普通池', '字幕池', '特殊池'][num(get(11))] || '普通池',
      attributes: { protected: !!(1 & attr), live: !!(2 & attr), highLike: !!(4 & attr) },
    });
  }
  return elems;
}
