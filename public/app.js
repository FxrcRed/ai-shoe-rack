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
  page: 's-home', photo: '', scene: null, placed: false, mock: true, rec: null, variant: 0, nag: 0, 
  schemes: [],   // 只有 1 项：[{ versions: [scheme...], cur: 0 }]，「换一个」整个替换
  active: 0, final: null, rows: [], priceEdits: {}, offline: false,
};
const QUICK = ['再窄一点', '矮一点', '加一层', '加挂伞杆', '杆粗一点']; // 只改形状和配件；材质、杆色在结算页选
const ORDER = ['s-home', 's-photo', 's-design', 's-pay'];
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
  const hub = id === 's-home' || id === 's-saved';
  document.body.classList.toggle('hub', hub);
  if (id === 's-saved') renderSaved();
  document.body.classList.toggle('appmode', ['s-design', 's-pay'].includes(id));
  if (id === 's-pay') turntable.start(); else turntable?.stop();
  renderSteps();
  scrollTo(0, 0);
  viewer?.resize(); if (viewer) placeHandles();
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
  if (b.dataset.go === 's-photo' && S.saved) newDesign(); // 存过方案后再「开始设计」= 从头来，不带上次的照片和需求
  show(b.dataset.go);
});
function newDesign() {
  S.photos.forEach(p => URL.revokeObjectURL(p.url)); S.photos = []; S.schemes = []; S.final = null; S.saved = false; S.nag = 0;
  $('desc').value = ''; photosChanged();
}

// 顶部步骤条：走到过的步骤都能点回去（改了照片/需求后再往后走会按新的重新摆放）
function canGo(k) { return k <= 1 || S.schemes.length > 0; }
function renderSteps() {
  const k = ORDER.indexOf(S.page);
  $('stepbar').hidden = k < 1; // 首页、我的方案不显示
  [...$('stepbar').children].forEach((b, i) => {
    b.className = i <= k ? 'on' : '';
    b.disabled = i === k || !canGo(i);
  });
}
[...$('stepbar').children].forEach((b, i) => b.onclick = () => goStep(i));
function goStep(i) {
  if (i === 0) show('s-home');
  else if (i === 1) { show('s-photo'); renderPhotos(); }
  else if (i === 2) enterDesign();
  else if (i === 3) choose();
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));

// 我的方案：存在浏览器里，最多 12 个，每个带一张效果图
const LIST_KEY = 'luojian.list';
function loadList() { // 存的数据坏了（不是数组、缺字段）就跳过坏的，不让页面卡死
  try { const v = JSON.parse(localStorage.getItem(LIST_KEY)); return Array.isArray(v) ? v.filter(it => it && typeof it.scheme === 'object' && it.scheme && typeof it.img === 'string') : []; } catch { return []; }
}
function storeList(list) { // 存不下（存储满、隐私模式）返回 false，不悄悄删旧方案
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
function renderSaved() {
  const box = $('saved-list'); box.innerHTML = '';
  loadList().forEach(it => {
    const s = it.scheme, d = document.createElement('div'); d.className = 'saved-item';
    d.innerHTML = `<img alt=""><div><b></b><p class="meta"></p><span class="amt"></span></div><button class="x" aria-label="删除">×</button><button class="view">查看</button>`;
    d.querySelector('img').src = it.img;
    d.querySelector('b').textContent = s.name;
    d.querySelector('.meta').textContent = `约 ${s.width}×${s.depth}×${s.height}cm · ${s.shelfMaterial}`;
    d.querySelector('.amt').innerHTML = yuan(it.price);
    d.onclick = () => { S.schemes = [{ versions: [normalizeScheme(it.scheme)], cur: 0 }]; S.active = 0; choose(); };
    const x = d.querySelector('.x'); // 第一次点变成「删除」，再点才删
    x.onclick = e => {
      e.stopPropagation();
      if (!x.classList.contains('arm')) { x.classList.add('arm'); x.textContent = '删除'; return setTimeout(() => { x.classList.remove('arm'); x.textContent = '×'; }, 2500); }
      storeList(loadList().filter(y => y.id !== it.id)); renderSaved();
    };
    box.appendChild(d);
  });
}

const rgba = (n, a = 1) => `rgba(${n >> 16}, ${n >> 8 & 255}, ${n & 255}, ${a})`;
// dot(v) 给出颜色时每个选项前加色点（材质/杆色），这一行改成横向滑动不换行
function chips(el, list, cur, onPick, dot) {
  el.innerHTML = ''; el.classList.toggle('swatch', !!dot);
  for (const v of list) {
    const b = document.createElement('button');
    if ('cards' in el.dataset) b.innerHTML = `<i class="sw" style="background:${dot(v)}"></i><span>${v}</span>`;
    else if (dot) b.innerHTML = `<i class="dot" style="background:${dot(v)}"></i>${'dots' in el.dataset ? '' : v}`; else b.textContent = v;
    b.title = v; b.setAttribute('aria-label', v);
    b.className = v === cur ? 'on' : '';
    b.onclick = () => { [...el.children].forEach(c => c.className = ''); b.className = 'on'; onPick(v); };
    el.appendChild(b);
  }
}

// 没有后端时（Artifacts / GitHub Pages 等静态托管）直接在浏览器里跑模拟模式
async function post(url, body) {
  if (S.offline && url.endsWith('scene')) return { scene: null, mock: true };
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
    const msg = ok ? (S.analyzing ? '分析中…' : p.q.msg + (p.noDoor ? '，门没拍全，尺寸约估' : '') + best) : p.q.msg + (p.q.forced ? '，按默认角度继续，尺寸标「约」' : p.accepted ? '（仍然使用）' : '');
    const ai = p.ai && !S.analyzing ? `<span class="q wait">AI 建议：${p.ai.replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`)}</span>` : '';
    d.innerHTML = `<img src="${p.url}" alt=""><button class="x" aria-label="删除">✕</button>
      <div class="tags"><span class="q ${open ? 'bad' : ok && !S.analyzing ? 'ok' : 'wait'}">${msg}</span>${ai}</div>`;
    if (open) {
      const r = document.createElement('button'); r.className = 'redo'; r.textContent = '重拍这张'; r.onclick = () => retake(i); d.querySelector('.tags').appendChild(r);
      if (p.q.level === 'warn') { const k = document.createElement('button'); k.className = 'redo'; k.textContent = '仍然使用'; k.onclick = () => { p.accepted = true; renderPhotos(); }; d.querySelector('.tags').appendChild(k); }
    }
    d.querySelector('.x').onclick = () => removePhoto(i);
    box.appendChild(d);
  });
  $('gen').disabled = !S.photos.some(usable);
  $('after').hidden = !S.photos.length;
  $('gen').textContent = S.schemes.length ? '重新生成方案' : '生成方案';
}

function photosChanged() {
  S.placed = false; S.best = undefined; S.rec = null;
  clearTimeout(S.analyzeTimer); viewer?.clearEdits(); // 换照片：用户拖过的门框、家具框作废
  const seq = S.seq = (S.seq || 0) + 1;
  S.analyzing = !!S.photos.length;
  renderPhotos();
  if (!S.photos.length) { S.scene = null; return; }
  S.scene = new Promise(done => { S.analyzeTimer = setTimeout(() => analyze(seq).then(done), 600); }); // 连拍时等一下再一起分析
}

// 本地语义分割（server 转发到 seg/seg.py）：原图缩到 640 宽发过去，回来每像素一字节的分组图 { w, h, data }；没有服务或出错就是 null
async function segOf(img) {
  if (S.offline) return null;
  try {
    const k = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const j = await post('api/seg', { image: c.toDataURL('image/jpeg', 0.85) }); if (!j.data) { if (j.warning) console.warn(j.warning); return null; }
    return { w: j.w, h: j.h, data: Uint8Array.from(atob(j.data), ch => ch.charCodeAt(0)) };
  } catch (e) { console.warn('分割失败', e); return null; }
}

async function analyze(seq) {
  const ph = S.photos;
  const segs = ph.map(p => segOf(p.img)); // 和识图并行
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
  scene.weak = !p.q.ok || !!scene.issue; // 本地检查不过，或 AI 三次识图都建议重拍
  p.noDoor = !!ai && !/door/.test(scene.camHSrc); if (p.noDoor) renderPhotos(); // 没有完整的门：尺度只能靠 AI 估
  scene.seg = await Promise.race([segs[best], new Promise(r => setTimeout(r, 6000, null))]); // 分割服务刚启动在加载模型时不等它
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
  viewer.segMap = scene.seg || null; viewer.placeScene(scene); S.placed = true; showFit(); // 放好后才定下提示和建议宽度，再刷新一次
  if (scene.weak) toast(`${scene.issue || '照片里地面/墙脚线条不清楚'}，摆放可能不准：可以手动拖动，或点顶部第 2 格回去重拍`, 6000);
  else if (scene.note) toast('AI：' + scene.note);
}

// 材质 / 风格 / 色卡推荐：只认能生产的 4 种隔板、2 种杆色；没有 AI 结果时给常见搭配
const DEFAULT_REC = { style: '常见搭配', shelfMaterial: '实木', rodFinish: '黑色', ai: false };
const validRec = r => r && Object.hasOwn(BOARD_MATERIALS, r.shelfMaterial) && Object.hasOwn(ROD_FINISHES, r.rodFinish)
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
  const btn = $('gen'); btn.disabled = true; btn.textContent = '生成中…';  const photo = !S.placed && !!S.scene; // 有照片且还没摆过：要等照片分析
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
  p.close(); renderPhotos();
}
$('gen').onclick = generate;
// 换一个：整个替换成另一个思路的方案（点了才再生成）
$('another').onclick = async () => {
  const btn = $('another'); btn.disabled = true; btn.textContent = '生成中…';
  const e = S.schemes[S.active], old = current();
  try {
    const j = await post('api/generate', { description: $('desc').value, variant: ++S.variant, avoid: S.seen, ...cons() });
    if (S.schemes[S.active] !== e || S.page !== 's-design') throw 0; // 等结果时跳走了：丢掉，不写进别的方案
    // 用户要过的伞杆、挂钩带过去；新方案作为新版本，想回上一个点 v1/v2
    const ns = normalizeScheme({ ...j.schemes[0], umbrella: j.schemes[0].umbrella || old.umbrella, hooks: Math.max(j.schemes[0].hooks || 0, old.hooks) });
    e.versions.push(ns); e.cur = e.versions.length - 1; S.seen.push(ns.name); S.final = null;
    renderDesign();
  } catch (e) { if (e !== 0) oops('换方案失败了，请稍后再试一次', e.message); }
  btn.disabled = false; btn.textContent = '换一个';
};

// ---------- 方案 / 修改 ----------
viewer = new RackViewer($('stage'));
const syncSliders = t => {
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
// 旋转 90°（俯视看：顺时针 = rot 减小）；转了就不再自动贴原来那面墙
const turn = deg => { viewer.anchor = null; viewer.dragged = true; viewer.set({ rot: ((viewer.t.rot + deg + 540) % 360) - 180 }); };
$('rot-cw').onclick = () => turn(-90);
$('rot-ccw').onclick = () => turn(90);
$('t-reset').onclick = () => viewer.scene0 && viewer.placeScene(viewer.scene0);
// 分段切换控件面板；尺寸手柄只在「尺寸」面板显示
S.pane = 'tips';
const setPane = name => {
  S.pane = name;
  $('seg').hidden = name === 'tips';
  $('adjust').hidden = name === 'tips'; $('adjust').classList.toggle('primary', name !== 'tips'); $('s-design').classList.toggle('editing', name !== 'tips');
  $('seg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.pane === name));
  document.querySelectorAll('#s-design .pane').forEach(p => p.hidden = p.dataset.pane !== name);
  placeHandles();
};
$('tune').onclick = () => setPane('size');
$('adjust').onclick = () => setPane('tips');
$('seg').querySelectorAll('button').forEach(b => b.onclick = () => setPane(b.dataset.pane));
const current = () => { const e = S.schemes[S.active]; return e.versions[e.cur]; };
const pairs = s => { const l = shoeLayout(s); return `${l.male + l.female} 双（男 ${l.male} / 女 ${l.female}）`; }; // 按真实鞋子尺寸摆出来的双数
const dimsShort = s => { const l = shoeLayout(s); return `约 <b>${s.width}×${s.depth}×${s.height}cm</b><br>${s.shelves.length} 层 · 可放约 ${l.male + l.female} 双`; };
const dims = s => `${s.width}×${s.depth}×${s.height} cm · ${s.shelves.length} 层（离地 ${s.shelves.join('/')} cm）· 可放 ${pairs(s)} · Φ${s.rodDiameter} ${s.rodFinish} · ${s.shelfMaterial}隔板`
  + (s.hooks ? ` · 挂钩×${s.hooks}` : '') + (s.umbrella ? ' · 挂伞杆' : '');

// 改完说一句改了什么（尺寸行在「修改」分页里看不到）
function changeNote(a, b) {
  const n = [], la = shoeLayout(a), lb = shoeLayout(b);
  if (a.width !== b.width || a.depth !== b.depth || a.height !== b.height) n.push(`约 ${b.width}×${b.depth}×${b.height}cm`);
  if (a.shelves.length !== b.shelves.length || la.male + la.female !== lb.male + lb.female) n.push(`${b.shelves.length} 层 · 约 ${lb.male + lb.female} 双`);
  if (a.umbrella !== b.umbrella) n.push(b.umbrella ? '加了挂伞杆' : '去掉挂伞杆');
  if (a.hooks !== b.hooks) n.push(b.hooks ? `挂钩 ${b.hooks} 个` : '去掉挂钩');
  if (a.rodDiameter !== b.rodDiameter) n.push(`杆径 Φ${b.rodDiameter}`);
  if (a.shelfMaterial !== b.shelfMaterial) n.push(b.shelfMaterial + '隔板');
  if (a.rodFinish !== b.rodFinish) n.push(b.rodFinish.replace('色铝', '') + '杆');
  return n.length ? '已改：' + n.join(' · ') : '没听懂要改哪里，换个说法试试';
}

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
  fillDims(s); renderQuick(s);
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
const SHOW_HANDLES = false; // 照片上拖手柄先不做
function placeHandles() {
  const box = $('handles');
  const on = S.page === 's-design' && SHOW_HANDLES && S.pane === 'size' && S.schemes.length > 0 && !!viewer.cur;
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

const renderQuick = s => chips($('quick'), QUICK.filter(q => !(q === '加挂伞杆' && s.umbrella)), null, v => { $('feedback').value = v; $('revise').click(); });
$('feedback').onkeydown = e => { if (e.key === 'Enter') $('revise').click(); };
$('revise').onclick = async () => {
  const fb = $('feedback').value.trim();
  if (!fb) return toast('先写一句想怎么改');
  const btn = $('revise'); btn.disabled = true; btn.textContent = '修改中…';
  const e = S.schemes[S.active];
  try {
    const j = await post('api/revise', { scheme: current(), feedback: fb, description: $('desc').value, ...cons() });
    if (S.schemes[S.active] !== e || S.page !== 's-design') throw 0; // 等结果时跳走了：丢掉，不贴到别的方案
    const was = current();
    e.versions.push(j.scheme); e.cur = e.versions.length - 1;
    toast(changeNote(was, j.scheme));
    $('feedback').value = ''; [...$('quick').children].forEach(c => c.className = '');
    renderDesign();
  } catch (err) { if (err !== 0) oops('修改失败了，请稍后再试一次', err.message); }
  btn.disabled = false; btn.textContent = '修改';
};

// ---------- 材质 + 结算：旋转展示 + 材质/杆色 + 预估价格 ----------
turntable = new Turntable($('turntable'));
$('choose').onclick = () => {
  choose();
};
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
  const r = S.rec; $('rec-use').hidden = !r; if (!r) return;
  const same = r.shelfMaterial === S.final.shelfMaterial && r.rodFinish === S.final.rodFinish;
  const word = r.ai ? '推荐' : '常见搭配'; // 没 AI 时是写死的搭配，不叫「推荐」
  $('rec-use').textContent = same ? '已采用' + word : `采用${word}：${r.shelfMaterial} + ${r.rodFinish.replace('色铝', '')}`; $('rec-use').disabled = same;
}
$('rec-use').onclick = () => { for (const o of [S.final, current()]) Object.assign(o, { shelfMaterial: S.rec.shelfMaterial, rodFinish: S.rec.rodFinish }); fillLook(); renderPay(); };
// 尺寸靠门高估，可能不准：让用户点一下确认，保存前没确认就抖一下这一行
function renderDimsOk() {
  const s = S.final, b = $('dims-ok');
  b.textContent = (S.dimsOk ? '✓ ' : '') + `约 ${s.width}×${s.depth}×${s.height} cm` + (S.dimsOk ? '' : ' · 确认');
  b.className = S.dimsOk ? '' : 'todo';
}
$('dims-ok').onclick = () => { S.dimsOk = !S.dimsOk; renderDimsOk(); };
function choose() {
  const s = { ...current() };
  if (!S.final || ['width', 'depth', 'height'].some(k => S.final[k] !== s[k])) S.dimsOk = false; // 尺寸变了要重新确认
  S.final = s; renderDimsOk();
  show('s-pay'); fillLook(); renderPay();
  turntable.reset();
}
function renderPay() {
  const s = S.final, { rows } = computeBOM(s);
  for (const r of rows) if (r.name in S.priceEdits) r.price = S.priceEdits[r.name]; // 切材质/颜色时保留用户改过的单价
  S.rows = rows;
  turntable.setScheme(s);
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
  if (!S.dimsOk) { const r = $('dims-row'); r.style.animation = 'none'; r.offsetWidth; r.style.animation = 'nudge .3s'; return; }
  let canvas = turntable.renderer.domElement;
  const ph = S.photos[S.best || 0];
  if (ph) { viewer.setScheme(S.final); canvas = viewer.composite(ph.img); } else turntable.render();
  const small = document.createElement('canvas'); small.width = 640; small.height = Math.round(640 * canvas.height / canvas.width);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const key = JSON.stringify(S.final); // 同一方案再保存只留最新一条
  const ok = storeList([{ id: Date.now(), scheme: S.final, need: $('desc').value, price: estimate(), img: small.toDataURL('image/jpeg', 0.75) }, ...loadList().filter(y => JSON.stringify(y.scheme) !== key)].slice(0, 12));
  if (!ok) return oops('手机存储满了，方案没存上。请到「我的方案」删掉几个旧的再试', 'localStorage setItem failed');
  S.saved = true;
  const blob = await new Promise(d => canvas.toBlob(d, 'image/jpeg', 0.9)), file = new File([blob], '落间方案.jpg', { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '落间方案' }); return toast('方案已保存'); } catch (e) { if (e.name === 'AbortError') return toast('方案已保存'); }
  }
  URL.revokeObjectURL($('snap-img').src); $('snap-img').src = URL.createObjectURL(blob); $('snap-view').hidden = false;
};
$('snap-close').onclick = () => $('snap-view').hidden = true;
$('snap-saved').onclick = () => { $('snap-view').hidden = true; show('s-saved'); };

renderSteps();
window.__app = { S, viewer, turntable, computeBOM, goStep }; // 方便调试
