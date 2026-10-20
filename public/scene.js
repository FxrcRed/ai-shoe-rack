// scene.js — 照片透视：读 EXIF 等效焦距、压缩照片给 AI 识图、把 AI 结果整理成 viewer.placeScene 用的参数
// 横向视角由等效焦距算（EXIF 有就用 EXIF，没有按 AI 判断的镜头类型：超广角 13mm / 主摄 26mm / 长焦 70mm）

export const LENS_MM = { ultrawide: 13, main: 26, tele: 70 };
// 可随手挪走的小物件，不算摆放障碍
const MOVABLE = /鞋(?!柜|架|凳)|拖鞋|靴|包|伞|纸箱|快递|地垫|脚垫|玩具|垃圾|袋|球|篮/;

// 35mm 等效焦距 → 照片横向视角（度）。等效焦距按 43.27mm 对角线换算，aspect = 宽/高
export function hfovOf(f35, aspect) {
  const w = 43.27 * aspect / Math.hypot(1, aspect);
  return 2 * Math.atan(w / 2 / f35) * 180 / Math.PI;
}

// 读 JPEG EXIF 里的 FocalLengthIn35mmFilm（0xA405），没有返回 0
export async function readFocal35(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return 0;
    for (let p = 2; p + 4 < v.byteLength;) {
      const mark = v.getUint16(p), len = v.getUint16(p + 2);
      if (mark === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) { // "Exif"
        const t = p + 10, le = v.getUint16(t) === 0x4949;
        const u16 = o => v.getUint16(t + o, le), u32 = o => v.getUint32(t + o, le);
        const find = (ifd, tag) => { const n = u16(ifd); for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; } return 0; };
        const ptr = find(u32(4), 0x8769); if (!ptr) return 0;
        const e = find(u32(ptr + 8), 0xA405);
        return e ? u16(e + 8) : 0;
      }
      if ((mark & 0xFF00) !== 0xFF00) return 0;
      p += 2 + len;
    }
  } catch {}
  return 0;
}

// 照片缩到长边 1024，转成 jpeg dataURL（给 AI 用，约 100~200KB）
export function shrink(img, max = 1024) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height; // <img> 或 canvas
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  // 叠 0.1 间隔的坐标网格和刻度，视觉模型读坐标会准很多
  g.lineWidth = 1; g.font = `${Math.round(c.width / 40)}px sans-serif`;
  for (let i = 1; i < 10; i++) {
    const x = c.width * i / 10, y = c.height * i / 10;
    g.strokeStyle = 'rgba(255,0,255,0.45)';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke();
    g.fillStyle = '#f0f'; g.fillText((i / 10).toFixed(1), x + 2, 14); g.fillText((i / 10).toFixed(1), 2, y - 2);
  }
  return c.toDataURL('image/jpeg', 0.8);
}

// 参照物算相机高度：同一竖直物体（门边）的顶点 top、地面点 bottom（照片 0~1 坐标）+ 已知高 H（米）
// 按 viewer 的相机姿态（pitch 由地平线定、roll）把两点变成世界射线：底点射线打到地面 = h·b/(-b.y)，
// 顶点沿它的射线走到同一水平位置时高度 = H → h = H / (1 + k·t.y)。算不出返回 null
export function camHFromRef(top, bottom, { hfov, aspect, horizonY, roll = 0 }, H = 2.05) {
  if (!Array.isArray(top) || !Array.isArray(bottom) || ![...top, ...bottom].every(Number.isFinite)) return null;
  if (!(bottom[1] > horizonY + 0.02) || !(bottom[1] - top[1] > 0.03)) return null; // 底点要在地平线下，顶点在底点上方
  const th = Math.tan(hfov * Math.PI / 360), tv = th / aspect, p = Math.atan((0.5 - horizonY) * 2 * tv), r = roll * Math.PI / 180;
  const ray = ([u, v]) => {
    let x = (u * 2 - 1) * th, y = (1 - v * 2) * tv, z = -1;
    [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];   // Rz(roll)
    [y, z] = [y * Math.cos(p) + z * Math.sin(p), -y * Math.sin(p) + z * Math.cos(p)];  // Rx(-pitch)
    return [x, y, z];
  };
  const b = ray(bottom), t = ray(top);
  if (!(b[1] < 0)) return null;
  const k = (b[0] * t[0] + b[2] * t[2]) / (-b[1]) / (t[0] * t[0] + t[2] * t[2]), den = 1 + k * t[1];
  return den > 0.05 ? H / den : null;
}

// AI 结果（或 null）+ 几何检测结果 geo（或 null）+ 照片信息 → placeScene 参数
// 地平线/倾斜用几何检测；墙面方向用几何检测的角度，AI 只决定靠哪面墙（取最接近 AI yaw 的那个 90° 倍数）
export function toScene(ai, { f35, aspect, geo, hfov, light }) {
  const num = (x, lo, hi, d) => Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : d;
  const a = ai || {};
  const wall = ['left', 'back', 'right'].includes(a.wall) ? a.wall : 'back';
  const turn = { left: 90, back: 0, right: -90 }[wall];        // 鞋架正面朝向：靠左墙朝右，靠右墙朝左
  const yaw = geo?.wallAz?.length ? geo.wallAz[0] + turn : turn * 0.8;
  const horizonY = geo ? geo.horizonY : 0.3;
  // AI 指的墙脚点吸附到最近的检测线段上（3% 画面高度以内）
  let base = Array.isArray(a.wallBase) && a.wallBase.length === 2 ? a.wallBase.map(Number) : null;
  if (base && geo?.hlines?.length) {
    const best = snapTo(base, geo.hlines.filter(l => l[4] === (wall === 'back')), aspect, 0.03); // 只吸附与这面墙平行的线
    if (best) base = best;
    else { // 附近没有线：AI 常把点点在墙面上（偏高）→ 竖直往下落到正下方第一条与这面墙平行的线（墙脚线），让鞋架落地
      let drop = null, dy = 0.15;
      for (const [x1, y1, x2, y2, across] of geo.hlines) {
        if (across !== (wall === 'back') || base[0] < Math.min(x1, x2) - 0.01 || base[0] > Math.max(x1, x2) + 0.01 || x1 === x2) continue;
        const yl = y1 + (y2 - y1) * (base[0] - x1) / (x2 - x1);
        if (yl > base[1] && yl - base[1] < dy) { dy = yl - base[1]; drop = [base[0], yl]; }
      }
      if (drop) base = drop;
    }
  }
  if (base && !(base[1] > horizonY + 0.02)) base = null;          // 墙脚必须在地平线以下
  // 墙角点（后墙与侧墙墙脚线交点）：吸附到附近的后墙墙脚线上；侧墙墙脚线由它 + 墙面方向在 viewer 里推出来（侧墙陡线常检测不到）
  const corner = {};
  for (const k of ['left', 'right']) {
    let c = pt(a.corner?.[k]);
    if (c && (c[0] < 0.02 || c[0] > 0.98)) c = null; // AI 不确定时常把墙角点在画面边缘
    if (!c || !(c[1] > horizonY + 0.02)) continue;
    if (geo?.hlines?.length) c = snapTo(c, geo.hlines.filter(l => l[4]), aspect, 0.03) || c;
    corner[k] = c;
  }
  // 家具/障碍物的落地点（AI 偶尔仍会把地上的鞋/包列进来：按名字再过滤一次，太小的在 viewer 里按面积过滤）
  const obstacles = (Array.isArray(a.obstacles) ? a.obstacles : []).slice(0, 8).map(o => ({
    name: String(o?.name || '').slice(0, 12), depth: num(o?.depth, 0.05, 1.5, 0.4),
    pts: (Array.isArray(o?.pts) ? o.pts : []).map(pt).filter(q => q && q[1] > horizonY + 0.01).slice(0, 6),
  })).filter(o => o.pts.length && !MOVABLE.test(o.name));
  const spot = [];
  hfov = hfov || hfovOf(f35 || LENS_MM[a.lens] || LENS_MM.main, aspect);
  // 相机高度：照片里有门就按门高 2.05m 几何推算（AI 直接估常差 15%），算出离谱值才退回 AI 估值
  const roll = geo ? num(geo.roll, -15, 15, 0) : 0;
  const hDoor = geo ? camHFromRef(a.doorTop, a.doorBottom, { hfov, aspect, horizonY, roll }) : null;
  const camHSrc = hDoor && hDoor > 0.3 && hDoor < 2.2 ? 'door' : 'ai';
  return {
    hfov, camHSrc, camHAi: a.cameraHeight,
    camH: camHSrc === 'door' ? hDoor : num(a.cameraHeight, 0.3, 2.2, 1.35),
    horizonY, roll,
    spot: [num(spot[0], 0.05, 0.95, 0.5), num(spot[1], Math.max(0.05, horizonY + 0.08), 0.98, Math.max(0.72, horizonY + 0.2))],
    base, wall, yaw, roomAz: yaw - turn, corner, obstacles, aspect, note: a.note || '', ai: !!ai, geo: geo ? geo.src : '',
    light: mergeLight(a.light, light),
    door: doorOf(a.door),
  };
}

const pt = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(+v)) ? p.map(Number) : null;
// 点吸附到最近的线段上（tol 以画面高度为单位），没有返回 null
function snapTo(p, lines, aspect, tol) {
  let best = null, bd = tol;
  for (const [x1, y1, x2, y2] of lines) {
    const ax = x1 * aspect, bx = x2 * aspect, px = p[0] * aspect, dx = bx - ax, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (p[1] - y1) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(ax + t * dx - px, y1 + t * dy - p[1]);
    if (d < bd) { bd = d; best = [x1 + t * (x2 - x1), y1 + t * dy]; }
  }
  return best;
}

// 照片好不好用（本地几何检查，选完立刻出结果）：{ ok, msg, score }
export function photoQuality(img, geo) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data; let luma = 0;
  for (let i = 0; i < d.length; i += 4) luma += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  luma /= 1024;
  if (luma < 45) return { ok: false, msg: '太暗了，开灯再拍', score: 0 };
  if (!geo) return { ok: false, msg: '没找到地面和墙脚的直线，对着墙角、带上地面重拍', score: 0 };
  if (geo.horizonY > 0.8) return { ok: false, msg: '地面拍得太少，手机再往下倾一点', score: 0 };
  if (geo.nSeg < 12 || geo.strength < 1.5) return { ok: false, msg: '线条太少或太模糊，换个角度重拍', score: geo.strength };
  if (geo.src === 'one-horizontal') return { ok: true, msg: '可以用，透视线条偏少', score: geo.strength * 0.7 };
  return { ok: true, msg: '透视清楚', score: geo.strength };
}

// AI 给的门：门洞底边两端（铰链侧、锁侧，照片 0~1 坐标）+ 开向
function doorOf(d) {
  const hinge = pt(d?.hinge), latch = pt(d?.latch);
  return hinge && latch ? { hinge, latch, swing: d.swing === 'out' ? 'out' : 'in' } : null;
}

// ---------- 光影 ----------
// 方位约定同 viewer：0 = 光从相机这边照过去，-90 = 从画面左边，90 = 右边，180 = 从画面深处照向相机
const LIGHT_AZ = { front: 0, 'front-right': 45, right: 90, 'back-right': 135, back: 180, 'back-left': -135, left: -90, 'front-left': -45, top: -20 };

// AI 判断的方向（看已有物体的影子、窗户、灯）优先；照片本地估计补曝光和影子深浅
function mergeLight(ai, local) {
  const L = { ...(local || {}) };
  if (ai && LIGHT_AZ[ai.dir] !== undefined) {
    L.az = LIGHT_AZ[ai.dir]; L.el = ai.dir === 'top' ? 75 : 45; L.src = 'ai';
    if (typeof ai.hard === 'boolean') L.opacity = ai.hard ? 0.38 : 0.18;
  }
  return Object.keys(L).length ? L : null;
}

// 本地估计：画面里有明显的亮光源（窗、灯）→ 光从那边来；没有 → 比较地面左右亮度；对比度决定影子深浅
export function photoLight(img, horizonY = 0.4, hfov = 60) {
  const W = 48, H = Math.max(16, Math.round(W * img.naturalHeight / img.naturalWidth));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, L = new Float32Array(W * H);
  let m = 0;
  for (let i = 0; i < W * H; i++) m += L[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  m /= W * H;
  let v2 = 0; for (const x of L) v2 += (x - m) ** 2;
  const contrast = Math.sqrt(v2 / L.length) / Math.max(0.05, m);
  const out = { exposure: Math.min(1.25, Math.max(0.6, m / 0.5)), opacity: Math.min(0.4, Math.max(0.15, 0.1 + contrast * 0.4)), src: 'photo' };
  // 亮光源：比平均亮很多的像素，集中在地平线以上
  const thr = Math.max(0.9, m + 0.35); let n = 0, su = 0, sv = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (L[y * W + x] > thr && y / H < horizonY + 0.1) { n++; su += x / W; sv += y / H; }
  if (n > W * H * 0.003 && n < W * H * 0.25) {
    const u = su / n, v = sv / n, th = Math.atan((2 * u - 1) * Math.tan(hfov * Math.PI / 360)) * 180 / Math.PI;
    return { ...out, az: 180 - th, el: v < 0.15 ? 70 : 50 };
  }
  // 地面左右亮度差
  let l = 0, r = 0, nl = 0, nr = 0;
  for (let y = Math.max(0, Math.floor(horizonY * H)); y < H; y++) for (let x = 0; x < W; x++) {
    if (x < W / 2) { l += L[y * W + x]; nl++; } else { r += L[y * W + x]; nr++; }
  }
  const diff = nl && nr ? (l / nl - r / nr) / Math.max(0.05, m) : 0;
  return { ...out, az: Math.abs(diff) > 0.08 ? (diff > 0 ? -70 : 70) : -25, el: 55 };
}
