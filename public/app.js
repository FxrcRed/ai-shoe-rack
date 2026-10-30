// app.js — 页面流程：主页 → 拍照（+可选一句需求）→ 方案（只出 1 个）/修改 → 材质与结算
import { RackViewer, Turntable } from './viewer.js';
import { shoeLayout } from './shoes.js';
import { computeBOM, bomToCSV, BOARD_MATERIALS, ROD_FINISHES, ROD_DIAMETERS, normalizeScheme, evenShelves, UMBRELLA_OUT } from './rack.js';
import { mockGenerate, mockRevise } from './mock.js';
import { readFocal35, shrink, toScene, hfovOf, LENS_MM, photoQuality, photoLight } from './scene.js';
import { detectHorizon } from './vp.js';

const $ = id => document.getElementById(id);
const yuan = n => '<small class="cur">¥</small>' + n.toLocaleString('zh-CN'); // 宜家标价样式：货币符号缩小
let viewer, turntable; // 方案页才创建；先声明，避免它之前的代码出错时 show() 里引用到未初始化变量导致按钮全失效
const S = {
  photo: '', scene: null, placed: false, mock: true, rec: null, variant: 0, nag: 0, sizeOk: false,
  schemes: [],   // 只有 1 项：[{ versions: [scheme...], cur: 0 }]，「换一个」整个替换
  active: 0, final: null, rows: [], priceEdits: {}, offline: false,
};
const QUICK = ['再窄一点', '换玻璃隔板', '加一层', '加挂伞杆', '黑色杆', '杆粗一点'];
const ORDER = ['s-photo', 's-design', 's-pay'];
// 零件价格表只给管理员看：网址加 ?admin（前端开关，不是真正的权限控制）
const ADMIN = new URLSearchParams(location.search).has('admin');
// 给客户的预估价 = 零件参考价 × 加工系数 + 固定加工费，取整到 10 元
const MARKUP = 1.25, LABOR = 50;
// 在 Artifacts 等别的网站的 iframe 里（读不到 top 的地址就是跨域）；自己的 phone.html 预览框同源，不算
const IN_FRAME = (() => { try { return window.self !== window.top && window.top.location.origin !== location.origin; } catch { return true; } })();
if (IN_FRAME) $('csv').textContent = '复制零件表';
$('admin-bom').hidden = !ADMIN;

function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, ms);
}
// 报错说人话：接口原文、request id 这些只给 ?admin 看
const FRIENDLY = [
  [/^AI 调用失败，已改用模拟方案/, 'AI 暂时不可用，先用示例方案给你看效果'],
  [/^AI 调用失败，已按关键词模拟修改/, 'AI 暂时不可用，已按你的描述做了简单修改'],
  [/^AI 识图失败/, '照片没能识别清楚，先按常见角度摆放，可以手动拖动调整'],
  [/^AI 摆放检查失败/, 'AI 没能复查摆放位置，可以手动拖动调整'],
];
function oops(msg, detail) { toast(ADMIN && detail ? `${msg}（${detail}）` : msg, 6000); }
function show(id) {
  document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== id);
  S.page = id;
  document.body.classList.toggle('home', id === 's-home');
  document.body.classList.toggle('appmode', ['s-design', 's-pay'].includes(id));
  if (id === 's-pay') turntable.start(); else turntable?.stop();
  renderSteps();
  scrollTo(0, 0);
  viewer?.resize(); if (viewer) placeHandles();
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));

// 顶部步骤条：走到过的步骤都能点回去（改了照片/需求后再往后走会按新的重新摆放）
function canGo(k) { return k === 0 || S.schemes.length > 0; }
function renderSteps() {
  const k = ORDER.indexOf(S.page);
  $('stepbar').hidden = k < 0;
  $('steps-btn').textContent = k >= 0 ? `${k + 1}/3 ${$('steps').children[k].textContent}` : '';
  [...$('segs').children].forEach((b, i) => b.className = i <= k ? 'on' : '');
  [...$('steps').children].forEach((li, i) => {
    li.className = i === k ? 'on' : k >= 0 && (i < k || canGo(i) && i > 0) ? 'done' : '';
    li.firstChild.disabled = i === k || !canGo(i);
  });
}
[...$('steps').children].forEach((li, i) => li.firstChild.onclick = () => { openSteps(false); goStep(i); });
// 步骤菜单平时收起，点步骤条左边的「2/5 需求」展开
function openSteps(on) { $('steps').hidden = !on; $('steps-btn').setAttribute('aria-expanded', on); }
$('steps-btn').onclick = e => { e.stopPropagation(); openSteps($('steps').hidden); };
document.addEventListener('click', e => { if (!$('steps').hidden && !$('steps').contains(e.target)) openSteps(false); });
function goStep(i) {
  if (i === 0) { show('s-photo'); renderPhotos(); }
  else if (i === 1) enterDesign();
  else if (i === 2) choose();
}
$('brand').onclick = () => show('s-home');

const rgba = (n, a = 1) => `rgba(${n >> 16}, ${n >> 8 & 255}, ${n & 255}, ${a})`;
// dot(v) 给出颜色时每个选项前加色点（材质/杆色），这一行改成横向滑动不换行
function chips(el, list, cur, onPick, dot) {
  el.innerHTML = ''; el.classList.toggle('swatch', !!dot);
  for (const v of list) {
    const b = document.createElement('button');
    if (dot) b.innerHTML = `<i class="dot" style="background:${dot(v)}"></i>${v}`; else b.textContent = v;
    b.className = v === cur ? 'on' : '';
    b.onclick = () => { [...el.children].forEach(c => c.className = ''); b.className = 'on'; onPick(v); };
    el.appendChild(b);
  }
}

// 没有后端时（Artifacts / GitHub Pages 等静态托管）直接在浏览器里跑模拟模式
async function post(url, body) {
  if (S.offline && url.endsWith('scene')) return { scene: null, mock: true };
  if (S.offline && url.endsWith('check')) return { check: null, mock: true };
  if (S.offline) return url.endsWith('generate') ? { schemes: mockGenerate(body), mock: true } : { scheme: mockRevise(body), mock: true };
  let r, j;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    j = await r.json();
  } catch { S.offline = true; return post(url, body); } // 静态托管返回的不是 JSON
  if (!r.ok) throw new Error(j.error || r.status);
  if (j.warning) { const f = FRIENDLY.find(([re]) => re.test(j.warning)); oops(f ? f[1] : j.warning.split('：')[0], j.warning); }
  return j;
}

// ---------- 状态 ----------
fetch('api/status').then(r => r.json()).then(j => {
  S.mock = j.mock;
  $('mode').hidden = !ADMIN; // 模拟/AI 状态只给后台（?admin）看
  $('mode').textContent = j.mock ? '模拟模式' : ADMIN ? 'AI：' + j.model : 'AI 已接入'; // 具体模型只给后台（?admin）看
  $('mode').className = 'badge' + (j.mock ? '' : ' live');
}).catch(() => { S.offline = true; $('mode').textContent = '模拟模式（离线）'; });

// ---------- 拍照页（最多 3 张，角度略有不同）----------
// 每张选完立刻做本地几何检查（消失点 → 地平线等）并显示能不能用；照片变动后稍等片刻把所有照片一起发给 AI：
// AI 挑最适合展示的一张、给出靠哪面墙/墙脚点/拍摄高度、指出每张的问题。拍得不好可以单张重拍。
const MAX_PHOTOS = 3;
S.photos = [];
const loadImg = url => new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = url; });

async function addPhotos(files, at) {
  for (const file of files) {
    if (!file || S.photos.length >= MAX_PHOTOS && at === undefined) break;
    const url = URL.createObjectURL(file);
    let img; try { img = await loadImg(url); } catch { toast('这张图片打不开'); continue; }
    const aspect = img.naturalWidth / img.naturalHeight, f35 = await readFocal35(file);
    let hfov = hfovOf(f35 || LENS_MM.main, aspect), geo = null;
    try {
      geo = detectHorizon(img, hfov);
      // 没 EXIF（截图、微信转发会丢）：用正交消失点估出的视角重算（AI 判断镜头类型实测会把主摄认成超广角）
      if (!f35 && geo?.hfovEst) { hfov = geo.hfovEst; geo = detectHorizon(img, hfov) || geo; }
    } catch (e) { console.warn('透视检测失败', e); }
    const p = { url, img, aspect, f35, hfov, geo, q: photoQuality(img, geo), ai: '' };
    if (p.q.level !== 'ok' && ++S.nag > 2) p.q.forced = true; // 最多提示 2 次，之后按默认姿态继续
    if (at !== undefined) { URL.revokeObjectURL(S.photos[at].url); S.photos[at] = p; at = undefined; } else S.photos.push(p);
  }
  photosChanged();
}
function removePhoto(i) { URL.revokeObjectURL(S.photos[i].url); S.photos.splice(i, 1); photosChanged(); }
function retake(i) { S.retakeAt = i; $('cam').click(); }

// 三档：ok 能用 / warn 建议重拍（可「仍然使用」）/ bad 必须重拍；最多提示 2 次，之后按默认姿态继续
const usable = p => p.q.level === 'ok' || p.q.forced || p.accepted;
function renderPhotos() {
  const box = $('photos'); box.innerHTML = '';
  S.photos.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'ph' + (S.best === i && S.photos.length > 1 ? ' best' : '');
    const ok = p.q.level === 'ok', open = !usable(p), best = S.best === i && S.photos.length > 1 ? '（用这张）' : '';
    const msg = ok ? (S.analyzing ? '分析中…' : '✓ ' + p.q.msg + best) : '⚠ ' + p.q.msg + (p.q.forced ? '，按默认角度继续，尺寸标「约」' : p.accepted ? '（仍然使用）' : '');
    d.innerHTML = `<img src="${p.url}" alt=""><button class="x" title="删除">✕</button>
      <div class="q ${open ? 'bad' : ok && !S.analyzing ? 'ok' : 'wait'}">${msg}</div>`
      + (p.ai && !S.analyzing ? `<div class="q wait">AI 建议：${p.ai.replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`)}</div>` : '');
    if (open) {
      const r = document.createElement('button'); r.className = 'redo'; r.textContent = '重拍这张'; r.onclick = () => retake(i); d.appendChild(r);
      if (p.q.level === 'warn') { const k = document.createElement('button'); k.className = 'redo'; k.textContent = '仍然使用'; k.onclick = () => { p.accepted = true; renderPhotos(); }; d.appendChild(k); }
    }
    d.querySelector('.x').onclick = () => removePhoto(i);
    box.appendChild(d);
  });
  $('gen').disabled = !S.photos.some(usable);
  $('skip-photo').hidden = S.photos.length > 0;
  $('gen').textContent = S.schemes.length ? '重新生成方案' : '生成方案';
}

function photosChanged() {
  S.placed = false; S.best = undefined; S.rec = null;
  clearTimeout(S.analyzeTimer);
  const seq = S.seq = (S.seq || 0) + 1;
  S.analyzing = !!S.photos.length;
  renderPhotos();
  if (!S.photos.length) { S.scene = null; return; }
  S.scene = new Promise(done => { S.analyzeTimer = setTimeout(() => analyze(seq).then(done), 600); }); // 连拍时等一下再一起分析
}

async function analyze(seq) {
  const ph = S.photos;
  let ai = null;
  try {
    const j = await post('api/scene', { photos: ph.map(p => ({ image: shrink(p.img), aspect: p.aspect, horizonY: p.geo?.horizonY })), need: $('desc').value });
    ai = j.scene;
  } catch (e) { oops('照片分析失败，先按常见角度摆放，可以手动拖动调整', e.message); }
  if (seq !== S.seq) return null; // 期间照片又变了，以新的为准
  // 用哪张：AI 选的那张透视可用就用它，否则用几何最可靠的一张（AI 的墙脚点只对它选的那张有效）
  const geoBest = ph.reduce((b, p, i) => p.q.score > ph[b].q.score ? i : b, 0);
  let best = Number.isInteger(ai?.best) && ph[ai.best]?.q.ok ? ai.best : geoBest;
  if (ai && best !== ai.best) ai = { ...ai, wallBase: null, doorTop: null, doorBottom: null, door: null };
  ph.forEach((p, i) => { p.ai = Array.isArray(ai?.issues) && typeof ai.issues[i] === 'string' ? ai.issues[i].trim() : ''; });
  const p = ph[best];
  let { hfov, geo } = p;
  if (!p.f35 && !p.geo?.hfovEst && ai?.lens && ai.lens !== 'main' && LENS_MM[ai.lens]) { // 没 EXIF 时按 AI 判断的镜头重算
    hfov = hfovOf(LENS_MM[ai.lens], p.aspect);
    try { geo = detectHorizon(p.img, hfov) || geo; } catch {}
  }
  S.rec = validRec(ai?.rec) || DEFAULT_REC;
  S.best = best; S.analyzing = false; renderPhotos();
  const sp = $('stage-photo'); sp.src = p.url;
  $('stage').style.aspectRatio = `${p.img.naturalWidth} / ${p.img.naturalHeight}`; document.documentElement.style.setProperty('--ar', p.aspect); viewer.resize();
  let light = null; try { light = photoLight(p.img, geo?.horizonY, hfov); } catch {}
  const opts = { f35: p.f35, aspect: p.aspect, geo, hfov, light };
  const scene = toScene(ai, opts);
  scene.weak = !p.q.ok;
  S.sceneCtx = ai ? { ai, opts, img: p.img, weak: scene.weak, seq } : null; // 给 AI 复查用
  return scene;
}

$('cam').onchange = e => { const at = S.retakeAt; S.retakeAt = undefined; addPhotos([...e.target.files], at); e.target.value = ''; };
$('pick').onchange = e => { addPhotos([...e.target.files]); e.target.value = ''; };
// 进方案页：照片换过还没重新摆就先等分析结果再摆
async function enterDesign() {
  if (!S.schemes.length) return;
  if (!S.placed && S.scene) {
    toast('AI 正在分析照片…');
    const scene = await S.scene;
    show('s-design'); renderDesign(); return placeScene(scene);
  }
  show('s-design'); renderDesign();
}
function placeScene(scene) {
  if (!scene) return;
  viewer.placeScene(scene); S.placed = true;
  if (scene.weak) toast('照片里地面/墙脚线条不清楚，摆放可能不准，建议点「重拍照片」', 6000);
  else if (scene.note) toast('AI：' + scene.note);
  checkPlacement();
}

// AI 复查：把鞋架合成到照片上给识图模型看——是否落在地面、挡不挡门的开启范围和过道；不行就按它给的新墙脚点重摆，最多挪 2 次
async function checkPlacement() {
  const ctx = S.sceneCtx, msg = $('check-msg');
  if (!ctx || S.checking) return;
  S.checking = true; msg.hidden = false;
  const photo = shrink(ctx.img), why = [];
  let text = '';
  try {
    for (let round = 0; round < 3; round++) {
      msg.textContent = round ? `AI 已把鞋架挪开（${why[why.length - 1]}），正在再检查一次…` : 'AI 正在检查摆放：是否落地、碰不碰家具、挡不挡门和过道…';
      const j = await post('api/check', { photo, image: shrink(viewer.composite(ctx.img)), wall: viewer.scene0?.wall, need: $('desc').value });
      const c = j.check;
      if (ctx.seq !== S.seq || viewer.dragged || S.sceneCtx !== ctx) { text = ''; break; } // 照片换了或用户自己拖过：以用户为准
      if (!c) { text = ''; break; }
      if (c.ok === true || c.onFloor !== false && c.clearOfDoor !== false && c.clearOfPath !== false && c.clearOfFurniture !== false) {
        text = why.length ? `✓ 已按 AI 检查调整位置（${why.join('；')}）` : '✓ AI 检查通过：落在地面上，不碰家具、不挡门和过道'; break;
      }
      const problem = String(c.problem || '摆放不合理').slice(0, 40);
      // 碰家具/挡门但落了地：家具和门的位置程序已经知道，只是 AI 估的大小偏小 → 禁区外扩 8cm 重新避让，比换墙脚点稳
      // 只外扩一次；外扩后放不下就退回原位只提醒（实测 AI 复查对「碰到家具」误报多：离长凳 8cm 也说穿插）
      const geoOk = c.onFloor !== false && viewer.hasZones() && viewer.anchor;
      if (geoOk && viewer.pad) { text = `⚠ AI 仍提醒：${problem}（AI 检查偶尔误报，可对照地上的虚线框自己拖动）`; break; }
      if (geoOk && (c.clearOfFurniture === false || c.clearOfDoor === false)) {
        viewer.pad = 0.08; viewer.fitAnchor();
        if (viewer.suggestW || /放哪都会/.test(viewer.fitNote)) { viewer.pad = 0; viewer.fitAnchor(); text = `⚠ AI 提醒：${problem}（AI 检查偶尔误报，可对照地上的虚线框自己拖动）`; break; }
        why.push(problem); continue;
      }
      if (!Array.isArray(c.wallBase) || round === 2) { text = `⚠ AI 提醒：${problem}。可以拖动鞋架或旋转调整`; break; }
      why.push(problem);
      let wb = c.wallBase.map(Number); const cur = viewer.scene0?.base;
      // 说没落地却给了差不多的点：程序往地面方向（下）挪 4% 画面高度
      if (c.onFloor === false && cur && Math.hypot(wb[0] - cur[0], wb[1] - cur[1]) < 0.04) wb = [cur[0], Math.max(wb[1], cur[1]) + 0.04];
      ctx.ai = { ...ctx.ai, wall: ['left', 'back', 'right'].includes(c.wall) ? c.wall : ctx.ai.wall, wallBase: wb };
      const sc = toScene(ctx.ai, ctx.opts); sc.weak = ctx.weak;
      viewer.placeScene(sc);
    }
  } catch (e) { text = ''; console.warn('摆放检查失败', e); }
  msg.textContent = text; msg.hidden = !text;
  S.checking = false;
}

// 材质 / 风格 / 色卡推荐：只认能生产的 5 种隔板、4 种杆色；没有 AI 结果时给常见搭配
const DEFAULT_REC = { style: '常见搭配', shelfMaterial: '实木', rodFinish: '黑色', ai: false };
const validRec = r => r && r.shelfMaterial in BOARD_MATERIALS && r.rodFinish in ROD_FINISHES
  ? { style: String(r.style || '').replace(/[<>&]/g, '').slice(0, 10), shelfMaterial: r.shelfMaterial, rodFinish: r.rodFinish, ai: true } : null;
const cons = () => ({ maxWidth: undefined, maxDepth: undefined, maxHeight: undefined }); // 已去掉可用尺寸输入

// 生成时分步显示进度：真 AI 要 10~30 秒，只改按钮上的字像卡住了。照片分析从上传就开始了，和生成方案并行
function progress(labels) {
  const el = $('gen-progress'), t0 = Date.now();
  el.innerHTML = labels.map(l => `<li>${l}</li>`).join(''); el.hidden = false;
  const li = [...el.children];
  const tick = setInterval(() => li.forEach(x => { if (x.className === 'doing') x.dataset.sec = Math.round((Date.now() - t0) / 1000) + ' 秒'; }), 1000);
  return { doing: i => li[i].className = 'doing', done: i => { li[i].className = 'done'; delete li[i].dataset.sec; }, close: () => { clearInterval(tick); el.hidden = true; } };
}
async function generate() {
  const btn = $('gen'); btn.disabled = true; btn.textContent = '生成中…'; $('skip-photo').disabled = true;
  const photo = !S.placed && !!S.scene; // 有照片且还没摆过：要等照片分析
  const p = progress([...(photo ? ['看懂照片：透视、墙面、门'] : []), '设计方案', S.photos.length ? '摆进你的照片里' : '摆进示例场景里']);
  const [iPhoto, iGen, iPut] = photo ? [0, 1, 2] : [-1, 0, 1];
  try {
    if (photo) { p.doing(iPhoto); S.scene.then(() => p.done(iPhoto)); }
    p.doing(iGen);
    S.variant = 0;
    const j = await post('api/generate', { description: $('desc').value, variant: 0, ...cons() });
    p.done(iGen); p.doing(iPut);
    S.schemes = [{ versions: [j.schemes[0]], cur: 0 }]; S.active = 0; S.seen = [j.schemes[0].name]; S.final = null;
    const scene = S.placed ? null : await (S.scene || toScene(null, { aspect: 0.75 }));
    S.rec ||= DEFAULT_REC;
    show('s-design'); renderDesign();
    placeScene(scene);
  } catch (e) { oops('生成失败了，请稍后再试一次', e.message); }
  p.close(); $('skip-photo').disabled = false; renderPhotos();
}
$('gen').onclick = generate;
$('skip-photo').onclick = generate;
// 换一个：整个替换成另一个思路的方案（点了才再生成）
$('another').onclick = async () => {
  const btn = $('another'); btn.disabled = true; btn.textContent = '生成中…';
  try {
    const j = await post('api/generate', { description: $('desc').value, variant: ++S.variant, avoid: S.seen, ...cons() });
    S.schemes = [{ versions: [j.schemes[0]], cur: 0 }]; S.seen.push(j.schemes[0].name); S.final = null;
    renderDesign();
  } catch (e) { oops('换方案失败了，请稍后再试一次', e.message); }
  btn.disabled = false; btn.textContent = '换一个';
};

// ---------- 方案 / 修改 ----------
viewer = new RackViewer($('stage'));
const syncSliders = t => {
  $('t-scale').value = t.scale; $('t-rot').value = t.rot; $('t-pitch').value = t.pitch; $('t-light').value = t.lightAz;
  $('light-src').textContent = viewer.scene0?.light?.src === 'ai' ? '光照方向已由 AI 按照片判断，可拖动微调。' : viewer.scene0?.light ? '光照方向按照片亮度估计，可拖动微调。' : '拖动调整光照方向，让影子和照片一致。';
  showFit();
};
// 门的开启范围：自动避让的结果 / 太宽的建议 / 用户拖进去的警告
function showFit() {
  const el = $('fit-msg'), v = viewer;
  const warn = v.conflict && !v.suggestW, note = warn ? '⚠ 鞋架压到了门的开启范围、家具或墙（红色虚线），请拖开一点' : v.fitNote;
  el.hidden = !note; el.className = 'fit-msg' + (warn || v.suggestW ? ' warn' : '');
  if (!note) { el.dataset.note = ''; return; }
  if (el.dataset.note === note) return;
  el.dataset.note = note; el.textContent = note;
  if (v.suggestW && !warn && S.schemes.length && v.suggestW < current().width) {
    const b = document.createElement('button'); b.className = 'primary'; b.textContent = `改成 ${v.suggestW}cm 宽`;
    b.onclick = () => { viewer.anchor && (viewer.dragged = false); editDim('width', v.suggestW); };
    el.appendChild(b);
  }
}
viewer.onChange = syncSliders; syncSliders(viewer.t);
viewer.onFrame = () => placeHandles();
for (const k of ['scale', 'rot', 'pitch']) $('t-' + k).oninput = e => { viewer.dragged = true; viewer.set({ [k]: +e.target.value }); };
$('t-light').oninput = e => viewer.set({ lightAz: +e.target.value });
// 旋转 90°（俯视看：顺时针 = rot 减小）；转了就不再自动贴原来那面墙
const turn = deg => { viewer.anchor = null; viewer.dragged = true; viewer.set({ rot: ((viewer.t.rot + deg + 540) % 360) - 180 }); };
$('rot-cw').onclick = () => turn(-90);
$('rot-ccw').onclick = () => turn(90);
$('t-reset').onclick = () => viewer.scene0 && viewer.placeScene(viewer.scene0);
$('retake').onclick = () => goStep(0);
// 分段切换控件面板；尺寸手柄只在「尺寸」面板显示
S.pane = 'tips';
$('seg').querySelectorAll('button').forEach(b => b.onclick = () => {
  S.pane = b.dataset.pane;
  $('seg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('#s-design .pane').forEach(p => p.hidden = p.dataset.pane !== S.pane);
  placeHandles();
});
const current = () => { const e = S.schemes[S.active]; return e.versions[e.cur]; };
const pairs = s => { const l = shoeLayout(s); return `${l.male + l.female} 双（男 ${l.male} / 女 ${l.female}）`; }; // 按真实鞋子尺寸摆出来的双数
const dimsShort = s => { const l = shoeLayout(s); return `${s.width}×${s.depth}×${s.height}cm · ${s.shelves.length} 层<br>可放 ${l.male + l.female} 双`; };
const dims = s => `${s.width}×${s.depth}×${s.height} cm · ${s.shelves.length} 层（离地 ${s.shelves.join('/')} cm）· 可放 ${pairs(s)} · Φ${s.rodDiameter} ${s.rodFinish} · ${s.shelfMaterial}隔板`
  + (s.hooks ? ` · 挂钩×${s.hooks}` : '') + (s.umbrella ? ' · 挂伞杆' : '');

function renderDesign() {
  const s = current(), e = S.schemes[S.active];
  $('scheme-intro').textContent = s.intro;
  $('scheme-dims').innerHTML = dimsShort(s);
  const v = $('versions'); v.innerHTML = '';
  if (e.versions.length > 1) e.versions.forEach((x, i) => {
    const b = document.createElement('button');
    b.textContent = 'v' + (i + 1) + (x.manual ? ' ✎' : ''); b.className = i === e.cur ? 'on' : '';
    b.onclick = () => { e.cur = i; renderDesign(); };
    v.appendChild(b);
  });
  fillDims(s);
  viewer.setScheme(s);
  placeHandles();
}

// ---------- 尺寸参数：滑块 + 步进按钮 + 照片上拖手柄；拖动时 3D 实时变化，松手存为一个手改版本 ----------
const dial = k => document.querySelector(`#s-design [data-k="${k}"]`);
chips($('rods'), ROD_DIAMETERS.map(d => 'Φ' + d), null, v => commit({ rodDiameter: +v.slice(1) }));
function fillDims(s) {
  for (const k of ['width', 'depth', 'height']) { const d = dial(k); d.querySelector('input').value = s[k]; d.querySelector('output').textContent = s[k] + ' cm'; }
  dial('levels').querySelector('b').textContent = s.shelves.length;
  dial('hooks').querySelector('b').textContent = s.hooks;
  [...$('rods').children].forEach(b => b.className = b.textContent === 'Φ' + s.rodDiameter ? 'on' : '');
  $('umb').checked = s.umbrella;
}
// patch 是绝对值（基于当前已保存的版本）；改总高时各层按比例缩放
function makeScheme(patch) {
  const s = current(), raw = { ...s, ...patch };
  if ('height' in patch && !('shelves' in patch)) raw.shelves = s.shelves.map(h => h * patch.height / s.height);
  const ns = normalizeScheme(raw); // 只按结构极限夹紧（不按 ② 填的可用空间，用户明确要改）
  ns.manual = true; return ns;
}
let liveT = 0, liveNext = null;
function preview(patch) {
  liveNext = patch;
  if (liveT) return;
  liveT = setTimeout(() => { liveT = 0; const ns = makeScheme(liveNext); viewer.setScheme(ns, true); fillDims(ns); $('scheme-dims').innerHTML = dimsShort(ns); }, 30);
}
function commit(patch) {
  clearTimeout(liveT); liveT = 0;
  const s = current(), ns = makeScheme(patch);
  if (JSON.stringify(ns) === JSON.stringify({ ...s, manual: true })) return renderDesign();
  for (const k of ['width', 'depth', 'height', 'hooks']) if (k in patch && ns[k] !== Math.round(patch[k])) toast(`已按结构限制调整为 ${ns[k]}`);
  if ('shelves' in patch && ns.shelves.length !== patch.shelves.length) toast('相邻两层至少隔 12cm，层数已按总高调整');
  const c = cons();
  if (c.maxWidth && ns.width + (ns.umbrella ? UMBRELLA_OUT : 0) > c.maxWidth || c.maxDepth && ns.depth > c.maxDepth || c.maxHeight && ns.height > c.maxHeight)
    toast('注意：超出了 ② 里填的可用空间', 4500);
  const e = S.schemes[S.active];
  if (s.manual && e.cur === e.versions.length - 1) e.versions[e.cur] = ns; // 连续手改只占一个版本
  else { e.versions.push(ns); e.cur = e.versions.length - 1; }
  renderDesign();
}
const editDim = (k, v) => commit({ [k]: v }); // 「改成 Xcm 宽」按钮也用它
for (const k of ['width', 'depth', 'height']) {
  const d = dial(k), r = d.querySelector('input');
  r.oninput = () => preview({ [k]: +r.value });
  r.onchange = () => commit({ [k]: +r.value });
  d.querySelectorAll('.step').forEach(b => b.onclick = () => commit({ [k]: current()[k] + +b.dataset.d }));
}
dial('levels').querySelectorAll('.step').forEach(b => b.onclick = () => {
  const s = current(), n = Math.max(1, Math.min(8, s.shelves.length + +b.dataset.d));
  commit({ shelves: evenShelves(n, s.height) });
});
dial('hooks').querySelectorAll('.step').forEach(b => b.onclick = () => commit({ hooks: Math.max(0, Math.min(10, current().hooks + +b.dataset.d)) }));
$('umb').onchange = e => commit({ umbrella: e.target.checked });

// 照片上的手柄：右边缘中点 = 宽（鞋架居中，宽度变化 = 2×位移），顶边中点 = 高，左前角每层一个 = 该层隔板离地高度
// 拖动量 = 手指位移在该轴屏幕投影方向上的分量 ÷ 每米像素数（已含缩放和透视）
const HD_FOOT = 0.015;
function handleDefs(s) {
  const W = s.width / 100, D = s.depth / 100, H = s.height / 100, z = D / 2;
  return [
    { k: 'width', at: [W / 2, H / 2, z], ax: [1, 0, 0], mul: 2, label: `宽 ${s.width}` },
    { k: 'height', at: [0, HD_FOOT + H + 0.06, z], ax: [0, 1, 0], mul: 1, label: `高 ${s.height}` },
    ...s.shelves.map((h, i) => ({ k: 'shelf', i, at: [-W / 2, HD_FOOT + h / 100, z], ax: [0, 1, 0], mul: 1, label: `${h}cm`, l: true })),
  ];
}
function placeHandles() {
  const box = $('handles');
  const on = S.page === 's-design' && S.pane === 'size' && S.schemes.length > 0 && !!viewer.cur;
  box.hidden = !on; if (!on) return;
  const defs = handleDefs(viewer.cur);
  while (box.children.length > defs.length) box.lastChild.remove();
  while (box.children.length < defs.length) { const h = document.createElement('div'); h.className = 'hd'; h.innerHTML = '<i></i>'; bindHandle(h); box.appendChild(h); }
  const W = box.clientWidth, H = box.clientHeight;
  defs.forEach((d, i) => {
    const h = box.children[i], p = viewer.screenOf(...d.at);
    h._def = d; h.className = 'hd' + (d.l ? ' l' : '') + (h === S.dragH ? ' on' : '');
    h.hidden = !p.front || p.x < 0 || p.y < 0 || p.x > W || p.y > H;
    h.style.left = p.x + 'px'; h.style.top = p.y + 'px'; h.firstChild.textContent = d.label;
  });
}
function bindHandle(h) {
  let st = null;
  h.addEventListener('pointerdown', e => {
    e.preventDefault(); try { h.setPointerCapture(e.pointerId); } catch {}
    const d = h._def, p0 = viewer.screenOf(...d.at), p1 = viewer.screenOf(...d.at.map((v, j) => v + d.ax[j] * 0.1));
    const ax = { x: (p1.x - p0.x) * 10, y: (p1.y - p0.y) * 10 }, ppm = Math.hypot(ax.x, ax.y) || 1; // 每米像素
    st = { d, s: current(), x: e.clientX, y: e.clientY, ux: ax.x / ppm, uy: ax.y / ppm, ppm }; S.dragH = h;
  });
  h.addEventListener('pointermove', e => {
    if (!st) return;
    const cm = ((e.clientX - st.x) * st.ux + (e.clientY - st.y) * st.uy) / st.ppm * 100 * st.d.mul, s = st.s;
    if (st.d.k === 'shelf') { const sh = s.shelves.slice(); sh[st.d.i] = Math.round(sh[st.d.i] + cm); st.patch = { shelves: sh.sort((a, b) => a - b) }; }
    else st.patch = { [st.d.k]: Math.round(s[st.d.k] + cm) };
    preview(st.patch);
  });
  const up = () => { if (!st) return; const p = st.patch; st = null; S.dragH = null; if (p) commit(p); else placeHandles(); };
  h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
}

chips($('quick'), QUICK, null, v => { $('feedback').value = v; });
$('revise').onclick = async () => {
  const fb = $('feedback').value.trim();
  if (!fb) return toast('先写一句想怎么改');
  const btn = $('revise'); btn.disabled = true; btn.textContent = '修改中…';
  try {
    const j = await post('api/revise', { scheme: current(), feedback: fb, description: $('desc').value, ...cons() });
    const e = S.schemes[S.active];
    e.versions.push(j.scheme); e.cur = e.versions.length - 1;
    $('feedback').value = ''; [...$('quick').children].forEach(c => c.className = '');
    renderDesign();
  } catch (e) { oops('修改失败了，请稍后再试一次', e.message); }
  btn.disabled = false; btn.textContent = '修改';
};

// ---------- 材质 + 结算：旋转展示 + 材质/杆色 + 预估价格 ----------
turntable = new Turntable($('turntable'));
$('choose').onclick = () => choose();
$('back-design').onclick = () => { show('s-design'); renderDesign(); };
$('show-shoes').onchange = e => viewer.setShoes(e.target.checked);
const estimate = () => Math.ceil((S.rows.reduce((t, r) => t + r.qty * r.price, 0) * MARKUP + LABOR) / 10) * 10;
const matDot = v => rgba(BOARD_MATERIALS[v].color, Math.max(.5, BOARD_MATERIALS[v].opacity)), finDot = v => rgba(ROD_FINISHES[v]);
// 选材质/杆色同时写回当前方案版本，回方案页再回来不丢
function setLook(k, v) { S.final[k] = v; current()[k] = v; fillLook(); renderPay(); }
function fillLook() {
  chips($('mats'), Object.keys(BOARD_MATERIALS), S.final.shelfMaterial, v => setLook('shelfMaterial', v), matDot);
  chips($('fins'), Object.keys(ROD_FINISHES), S.final.rodFinish, v => setLook('rodFinish', v), finDot);
  renderRec();
}
function renderRec() {
  const r = S.rec; $('rec').hidden = !r; if (!r) return;
  const same = r.shelfMaterial === S.final.shelfMaterial && r.rodFinish === S.final.rodFinish;
  $('rec-txt').textContent = r.ai ? `${r.style ? r.style + '，' : ''}配${r.shelfMaterial}隔板、${r.rodFinish}杆` : `常见搭配：${r.shelfMaterial}隔板、${r.rodFinish}杆`;
  $('rec-use').textContent = same ? '已采用' : '采用'; $('rec-use').disabled = same;
}
$('rec-use').onclick = () => { for (const o of [S.final, current()]) Object.assign(o, { shelfMaterial: S.rec.shelfMaterial, rodFinish: S.rec.rodFinish }); fillLook(); renderPay(); };
function choose() {
  S.final = { ...current() }; S.sizeOk = false;
  show('s-pay'); fillLook(); renderPay();
  turntable.reset();
}
// 尺寸只靠门高估算，所以写「约」并让用户点一下确认；厂家下单前还会人工复核
$('size-ok').onclick = () => { S.sizeOk = true; renderSize(); };
function renderSize() {
  const s = S.final, l = shoeLayout(s);
  $('pay-size').innerHTML = `约 <b>${s.width}×${s.depth}×${s.height} cm</b> · 可放约 ${l.male + l.female} 双`;
  $('size-ok').textContent = S.sizeOk ? '✓ 已确认' : '确认尺寸'; $('size-ok').disabled = S.sizeOk;
}
function renderPay() {
  const s = S.final, { rows } = computeBOM(s);
  for (const r of rows) if (r.name in S.priceEdits) r.price = S.priceEdits[r.name]; // 切材质/颜色时保留用户改过的单价
  S.rows = rows;
  renderSize(); turntable.setScheme(s);
  const tb = $('bom').tBodies[0]; tb.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.name}</td><td>${r.spec}</td><td class="n">${r.qty} ${r.unit}</td><td><input type="number" min="0" step="0.1" value="${r.price}"></td><td class="n sub"></td>`;
    tr.querySelector('input').oninput = e => { r.price = S.priceEdits[r.name] = +e.target.value || 0; updateTotal(); };
    tb.appendChild(tr);
  });
  updateTotal();
}
function updateTotal() {
  $('est-price').innerHTML = yuan(estimate());
  let t = 0;
  [...$('bom').tBodies[0].rows].forEach((tr, i) => {
    const sub = S.rows[i].qty * S.rows[i].price; t += sub;
    tr.querySelector('.sub').textContent = sub.toFixed(1);
  });
  $('total').textContent = t.toFixed(1);
}
$('csv').onclick = () => {
  const s = S.final;
  if (IN_FRAME) { // Artifacts 等嵌入页不能下载：复制成制表符分隔，粘贴进 Excel 自动分列
    const tsv = [['名称', '规格', '数量', '单位', '单价', '小计'], ...S.rows.map(r => [r.name, r.spec, r.qty, r.unit, r.price, r.qty * r.price])].map(l => l.join('\t')).join('\n');
    return navigator.clipboard.writeText(tsv).then(() => toast('零件表已复制，打开 Excel 直接粘贴即可'), () => toast('复制失败，请在本地运行版本里导出 CSV'));
  }
  const blob = new Blob([bomToCSV(S.rows, `${s.name} ${s.width}×${s.depth}×${s.height}cm ${s.shelfMaterial}隔板 Φ${s.rodDiameter}${s.rodFinish}`)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `鞋架零件表_${s.name}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
// 保存方案：暂存浏览器 + 效果图（有照片时叠在照片上）用系统分享；不支持分享就弹出图片，长按保存
$('order').onclick = async () => {
  if (!S.sizeOk) return toast('先点一下「确认尺寸」');
  try { localStorage.setItem('luojian.saved', JSON.stringify({ scheme: S.final, need: $('desc').value, at: Date.now() })); } catch {}
  let canvas = turntable.renderer.domElement;
  const ph = S.photos[S.best || 0];
  if (ph) { viewer.setScheme(S.final); canvas = viewer.composite(ph.img); } else turntable.render();
  const blob = await new Promise(d => canvas.toBlob(d, 'image/jpeg', 0.9)), file = new File([blob], '落间方案.jpg', { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '落间方案' }); return toast('方案已保存'); } catch (e) { if (e.name === 'AbortError') return toast('方案已保存'); }
  }
  URL.revokeObjectURL($('snap-img').src); $('snap-img').src = URL.createObjectURL(blob); $('snap-view').hidden = false;
};
$('snap-close').onclick = () => $('snap-view').hidden = true;

renderSteps();
window.__app = { S, viewer, turntable, computeBOM, goStep }; // 方便调试
