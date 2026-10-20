// probe-vision.js — 找出 Semantix 上能识图的模型：node probe-vision.js
// 列出 /v1/models，每个模型各发一张纯红色小图问颜色，答对的就能识图。
// .env 里 SEMANTIX_VISION_MODEL 为空时，把第一个可用的写进去。
import fs from 'node:fs';
import zlib from 'node:zlib';

const envText = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const get = k => process.env[k] || (new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*([^\\r\\n]*?)[ \\t\\r]*$`, 'm').exec(envText) || [])[1] || '';
const key = get('SEMANTIX_API_KEY'), base = (get('SEMANTIX_BASE_URL') || 'https://sem.ensureok.ai/v1').replace(/\/$/, '');
if (!key) { console.log('.env 里没有 SEMANTIX_API_KEY'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

// 64×64 纯红 PNG
function redPng() {
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3).fill(Buffer.from([230, 20, 20]))]);
  const raw = Buffer.concat(Array(64).fill(row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const img = 'data:image/png;base64,' + redPng().toString('base64');

const list = await (await fetch(base + '/models', { headers: H })).json();
const all = (list.data || []).map(m => m.id);
console.log(`共 ${all.length} 个模型：${all.join(', ')}\n`);

const cands = all.filter(id => !/embed|tts|whisper|image-gen|dall|rerank/i.test(id));
const ok = [];
for (const model of cands) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', headers: H, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: [
        { type: 'text', text: '这张图片是什么颜色？只回答颜色。' }, { type: 'image_url', image_url: { url: img } }] }] }),
    });
    const j = await r.json();
    const a = (j.choices?.[0]?.message?.content || j.error?.message || JSON.stringify(j)).replace(/\s+/g, ' ').slice(0, 60);
    const pass = /红|red/i.test(a);
    if (pass) ok.push(model);
    console.log(`${pass ? '✔' : '✘'} ${model}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${a}`);
  } catch (e) { console.log(`✘ ${model}  ${e.message}`); }
}
console.log(`\n能识图：${ok.join(', ') || '无'}`);
if (ok.length && fs.existsSync('.env') && !get('SEMANTIX_VISION_MODEL')) {
  const line = `SEMANTIX_VISION_MODEL=${ok[0]}`;
  const re = /^[ \t]*SEMANTIX_VISION_MODEL[ \t]*=[^\r\n]*/m;
  fs.writeFileSync('.env', re.test(envText) ? envText.replace(re, line) : envText.replace(/\s*$/, '\n' + line + '\n'));
  console.log(`已写入 .env：${line}（想换就改这一行，然后重启 node server.js）`);
}
