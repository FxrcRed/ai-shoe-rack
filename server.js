// server.js — 托管 public/ 并转发 Semantix 请求。零依赖：node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { normalizeScheme } from './public/rack.js';
import { buildGenerateMessages, buildReviseMessages, buildSceneMessages, chat, mergeScenes, mockGenerate, mockRevise } from './ai.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');

// 读 .env（KEY=VALUE，# 开头为注释）
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const env = {
  key: process.env.SEMANTIX_API_KEY || '',
  baseUrl: process.env.SEMANTIX_BASE_URL || 'https://sem.ensureok.ai/v1',
  model: process.env.SEMANTIX_MODEL || 'deepseek-v4-flash',
  visionModel: process.env.SEMANTIX_VISION_MODEL || '', // 能识图的模型，逗号分隔可写多个（依次备用），用 node probe-vision.js 找
};
const PORT = +process.env.PORT || 8787;
// 本地语义分割服务（seg/seg.py，Python）：SEG=off 不用；默认本机 8790，没在跑就自动启动一个（第一次要下载模型、加载约 10 秒）。
// 起不来（没装 Python/torch）就不用，摆放照常，只是少了「压家具/挡门」的检查和改窄建议
const SEG_URL = process.env.SEG_URL || 'http://127.0.0.1:8790';
let segProc = null;
const segStart = () => {
  if (segProc || process.env.SEG === 'off' || process.env.SEG_URL) return;
  segProc = spawn(process.env.PYTHON || 'python', ['-I', path.join(ROOT, 'seg', 'seg.py'), 'serve', new URL(SEG_URL).port], { stdio: ['ignore', 'inherit', 'ignore'] });
  segProc.on('error', e => console.warn('分割服务没起来：' + e.message));
  process.on('exit', () => segProc?.kill());
};
// 先连一下：已经有别的进程（另一个 server.js）起好的服务就不重复启动
fetch(SEG_URL, { method: 'HEAD' }).catch(segStart);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8' };
// 照片评测（tools/photo-eval/，只在本机用）：评测页和测试照片按目录托管；识图原始结果按照片缓存，改合并/几何时重跑不花额度
const EVAL = path.join(ROOT, 'tools', 'photo-eval'), DEV_DIRS = { '/eval/': EVAL, '/test-photos/': path.join(ROOT, 'test-photos') };
const isLocal = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress);
const cacheFile = k => /^[\w.-]{1,80}$/.test(k || '') ? path.join(EVAL, 'cache', k + '.json') : null;

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, fail) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 4e6) { fail(new Error('请求太大')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fail(e); } });
});
const consOf = b => ({ maxWidth: b.maxWidth, maxDepth: b.maxDepth, maxHeight: b.maxHeight });

async function api(req, res, url) {
  if (url.pathname === '/api/status') return send(res, 200, { mock: !env.key, model: env.model, vision: env.key ? env.visionModel : '' });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const body = await readBody(req);
  const mockWanted = !env.key || body.mock;
  if (url.pathname === '/api/generate') {
    if (mockWanted) return send(res, 200, { schemes: mockGenerate(body), mock: true });
    try {
      const out = await chat(env, buildGenerateMessages(body), 0.8);
      const list = (out.schemes || []).slice(0, 1).map(s => normalizeScheme(s, consOf(body)));
      if (!list.length) throw new Error('模型没给出方案');
      return send(res, 200, { schemes: list, mock: false });
    } catch (e) {
      return send(res, 200, { schemes: mockGenerate(body), mock: true, warning: 'AI 调用失败，已改用模拟方案：' + e.message });
    }
  }
  // 识图调用：关思考（开着会把 token 全花在推理上且很慢）。网关偶尔报"暂时不可用"，最多试 3 次，轮流用列表里的模型
  const stat = { calls: 0, tokens: 0 }; // 本次请求实际调用次数（含失败重试）和 token，评测用
  const vision = async (messages, tries = 3, timeout = 90000, temp = 0, start = 0) => {
    const models = env.visionModel.split(',').map(m => m.trim()).filter(Boolean);
    let err;
    for (let i = start; i < start + tries; i++) {
      stat.calls++;
      try { const out = await chat({ ...env, timeout, model: models[i % models.length] }, messages, temp, { thinking: { type: 'disabled' } }); stat.tokens += out.usage?.total_tokens || 0; return out; }
      catch (e) { console.warn(`识图失败（${models[i % models.length]}）：${e.message.slice(0, 200)}`); err = err || e; await new Promise(r => setTimeout(r, 1500 * (i - start + 1))); }
    }
    throw err;
  };
  if (url.pathname === '/api/seg') {
    if (!body.image) return send(res, 400, { error: '缺少图片' });
    if (process.env.SEG === 'off') return send(res, 200, { data: null });
    try {
      const r = await fetch(SEG_URL + '/seg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: body.image }), signal: AbortSignal.timeout(20000) });
      const j = await r.json(); return send(res, 200, j.data ? { w: j.w, h: j.h, data: j.data } : { data: null, warning: '分割失败：' + (j.error || r.status) });
    } catch (e) { if (e.cause?.code === 'ECONNREFUSED') segStart(); return send(res, 200, { data: null, warning: '分割失败：' + (e.cause?.code || e.message) }); }
  }
  if (url.pathname === '/api/scene') {
    if (!body.image && !body.photos?.length) return send(res, 400, { error: '缺少照片' });
    const cf = isLocal(req) && cacheFile(body.cacheKey), cached = cf && fs.existsSync(cf) && JSON.parse(fs.readFileSync(cf, 'utf8'));
    if (cached) return send(res, 200, { scene: mergeScenes(cached.runs), runs: cached.runs.length, raw: cached.runs, ms: cached.ms, calls: cached.calls, tokens: cached.tokens, cached: true });
    if (!env.key || !env.visionModel) return send(res, 200, { scene: null, mock: true });
    try {
      // 单次识图的点和墙别波动很大：并发问 3 次（温度/模型不同）取共识，多花 API 额度换稳定
      const t0 = Date.now(), msgs = buildSceneMessages(body), runs = (await Promise.allSettled([0, 1, 2].map(i => vision(msgs, 2, 90000, i ? 0.6 : 0, i))))
        .filter(r => r.status === 'fulfilled' && r.value && typeof r.value === 'object').map(r => r.value);
      if (!runs.length) throw new Error('3 次识图都失败');
      console.log(`识图共识：${runs.length} 次结果，墙 ${runs.map(r => r.wall).join('/')}`);
      const ms = Date.now() - t0;
      if (cf) { fs.mkdirSync(path.dirname(cf), { recursive: true }); fs.writeFileSync(cf, JSON.stringify({ runs, ms, ...stat })); }
      return send(res, 200, { scene: mergeScenes(runs), runs: runs.length, mock: false, ...(cf ? { raw: runs, ms, ...stat } : {}) });
    } catch (e) {
      return send(res, 200, { scene: null, mock: true, warning: 'AI 识图失败，已按常见拍摄角度摆放：' + e.message });
    }
  }
  if (url.pathname === '/api/eval-save' && isLocal(req)) { // 评测结果：{ run, files: { 名字: JSON 对象或 dataURL 图片 } }
    if (!/^[\w.-]{1,40}$/.test(body.run || '')) return send(res, 400, { error: 'run' });
    const dir = path.join(EVAL, 'out', body.run); fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(body.files || {})) if (/^[\w.-]{1,80}$/.test(k))
      fs.writeFileSync(path.join(dir, k), typeof v === 'string' && v.startsWith('data:') ? Buffer.from(v.split(',')[1], 'base64') : JSON.stringify(v, null, 1));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/revise') {
    if (!body.scheme || !body.feedback) return send(res, 400, { error: '缺少 scheme 或 feedback' });
    if (mockWanted) return send(res, 200, { scheme: mockRevise(body), mock: true });
    try {
      const out = await chat(env, buildReviseMessages(body), 0.3);
      return send(res, 200, { scheme: normalizeScheme(out.scheme || out, consOf(body)), mock: false });
    } catch (e) {
      return send(res, 200, { scheme: mockRevise(body), mock: true, warning: 'AI 调用失败，已按关键词模拟修改：' + e.message });
    }
  }
  send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const dev = isLocal(req) && Object.keys(DEV_DIRS).find(d => url.pathname.startsWith(d)), base = dev ? DEV_DIRS[dev] : PUB;
    const file = path.normalize(path.join(base, decodeURIComponent(dev ? url.pathname.slice(dev.length) || 'index.html' : url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    // 文本类 gzip（three.module.js 1.3MB → ~300KB），走隧道/手机网络时快很多
    if (/text|javascript|json|svg/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  console.log(`光轴鞋架原型：http://localhost:${PORT}${lan ? `  手机同一 WiFi：http://${lan.address}:${PORT}` : ''}`);
  console.log(env.key ? `AI 模式：${env.model}，识图：${env.visionModel || '未配置（SEMANTIX_VISION_MODEL）'} @ ${env.baseUrl}` : '模拟模式（.env 里没有 SEMANTIX_API_KEY）');
});
