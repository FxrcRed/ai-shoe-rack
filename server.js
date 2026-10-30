// server.js — 托管 public/ 并转发 Semantix 请求。零依赖：node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { normalizeScheme } from './public/rack.js';
import { buildGenerateMessages, buildReviseMessages, buildSceneMessages, buildCheckMessages, chat, mergeScenes, mockGenerate, mockRevise } from './ai.js';

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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

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
  const vision = async (messages, tries = 3, timeout = 90000, temp = 0, start = 0) => {
    const models = env.visionModel.split(',').map(m => m.trim()).filter(Boolean);
    let err;
    for (let i = start; i < start + tries; i++) {
      try { return await chat({ ...env, timeout, model: models[i % models.length] }, messages, temp, { thinking: { type: 'disabled' } }); }
      catch (e) { console.warn(`识图失败（${models[i % models.length]}）：${e.message.slice(0, 200)}`); err = err || e; await new Promise(r => setTimeout(r, 1500 * (i - start + 1))); }
    }
    throw err;
  };
  if (url.pathname === '/api/check') {
    if (!body.image || !body.photo) return send(res, 400, { error: '缺少图片' });
    if (!env.key || !env.visionModel) return send(res, 200, { check: null, mock: true });
    try { return send(res, 200, { check: await vision(buildCheckMessages(body), 2, 45000) }); }
    catch (e) { return send(res, 200, { check: null, warning: 'AI 摆放检查失败：' + e.message }); }
  }
  if (url.pathname === '/api/scene') {
    if (!body.image && !body.photos?.length) return send(res, 400, { error: '缺少照片' });
    if (!env.key || !env.visionModel) return send(res, 200, { scene: null, mock: true });
    try {
      // 单次识图的点和墙别波动很大：并发问 3 次（温度/模型不同）取共识，多花 API 额度换稳定
      const msgs = buildSceneMessages(body), runs = (await Promise.allSettled([0, 1, 2].map(i => vision(msgs, 2, 90000, i ? 0.6 : 0, i))))
        .filter(r => r.status === 'fulfilled' && r.value && typeof r.value === 'object').map(r => r.value);
      if (!runs.length) throw new Error('3 次识图都失败');
      console.log(`识图共识：${runs.length} 次结果，墙 ${runs.map(r => r.wall).join('/')}`);
      return send(res, 200, { scene: mergeScenes(runs), runs: runs.length, mock: false });
    } catch (e) {
      return send(res, 200, { scene: null, mock: true, warning: 'AI 识图失败，已按常见拍摄角度摆放：' + e.message });
    }
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
    const file = path.normalize(path.join(PUB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
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
