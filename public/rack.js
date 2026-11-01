// rack.js — 光轴鞋架核心逻辑（纯函数，无依赖，前端和 server.js 共用）
//
// 流程：方案参数(JSON, cm) → normalizeScheme 校验/夹紧 → buildSkeleton 生成直线骨架(mm)
//       → analyzeSkeleton 求交点、给每个节点定连接件类型、算杆件下料长度 → computeBOM 零件表
//
// 连接件规则（只看节点上"伸出去的杆臂"方向，与杆是贯穿还是到头无关）：
//   臂数 = 2×贯穿杆数 + 1×到头杆数；轴向数 = 臂所在的不同直线方向数
//   1 臂：杆端悬空 → 在地面的竖杆 = 底座，其余 = 端帽
//   2 臂：1 个轴向 = 直通接头；2 个轴向 = 直角件(L)
//   3 臂：2 个轴向 = T 型件；3 个轴向 = 三通角件（框架顶角）
//   4 臂：2 个轴向 = 十字件；3 个轴向 = 四通角件（立柱贯穿 + 两向横杆，中间层角部）
//   5/6 臂 = 五通/六通件；任一对臂不正交也不共线 = 旋转夹（可调角度）
//   限位环：竖杆上每个"贯穿型"连接件下方加 1 个防下滑；挂伞杆上按进深每 10cm 一个分隔伞
// 下料：杆每一端插进连接件扣 d/2（d = 杆径）；悬空端（底座/端帽）不扣。下单前请厂家按实际连接件复核。

export const ROD_DIAMETERS = [6, 8, 10, 12, 16, 20];
export const BOARD_MATERIALS = {
  '实木': { thickness: 18, color: 0xb07a4a, opacity: 1, pricePerM2: 300 },
  '玻璃': { thickness: 8, color: 0xa8d8dc, opacity: 0.35, pricePerM2: 250 },
  '金属板': { thickness: 2, color: 0x5d6168, opacity: 1, pricePerM2: 180 },
  '亚克力': { thickness: 6, color: 0xf4f4f4, opacity: 0.6, pricePerM2: 220 },
};
export const ROD_FINISHES = { '银色铝': 0xc9ccd1, '黑色': 0x2b2b2b };
export const MIN_GAP = 12;          // 相邻隔板最小间距 cm
export const UMBRELLA_OUT = 12;     // 挂伞杆向侧面伸出 cm
export const MID_SUPPORT_OVER = 90; // 宽度超过此值(cm)，每层隔板下加中间托杆
const FOOT_DEDUCT = 0;

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function evenShelves(n, height) {
  if (n <= 1) return [5];
  return Array.from({ length: n }, (_, i) => Math.round(5 + i * (height - 5) / (n - 1)));
}

// 把 AI / 模拟 / 用户给的参数夹到可制造范围内，并满足用户的可用尺寸
export function normalizeScheme(raw = {}, cons = {}) {
  const s = {};
  s.name = String(raw.name || '方案').slice(0, 20);
  s.intro = String(raw.intro || '').slice(0, 120);
  s.umbrella = raw.umbrella === true || raw.umbrella === 'true';
  const maxW = num(cons.maxWidth, 200) || 200, maxD = num(cons.maxDepth, 60) || 60, maxH = num(cons.maxHeight, 200) || 200;
  if (s.umbrella && maxW - UMBRELLA_OUT - 2 < 30) s.umbrella = false; // 可用宽度连最窄架子 + 伞杆都放不下：去掉伞杆，不让总宽悄悄超限
  const umbW = s.umbrella ? UMBRELLA_OUT + 2 : 0;
  s.width = Math.round(clamp(num(raw.width, 80), 30, Math.max(30, Math.min(200, maxW - umbW))));
  s.depth = Math.round(clamp(num(raw.depth, 30), 15, Math.max(15, Math.min(60, maxD))));
  // 带挂伞杆时：伞尖立在接水盘里，伞杆在顶下 5cm 挡住伞身，所以总高至少 55cm
  const minH = Math.min(s.umbrella ? 55 : 25, Math.max(25, maxH));
  s.height = Math.round(clamp(num(raw.height, 60), minH, Math.max(25, Math.min(200, maxH))));
  let sh = Array.isArray(raw.shelves) ? raw.shelves.map(x => num(x, NaN)).filter(Number.isFinite) : [];
  if (!sh.length) sh = evenShelves(clamp(Math.round(num(raw.levels, 3)), 1, 8), s.height);
  sh = sh.map(h => Math.round(clamp(h, 3, s.height))).sort((a, b) => a - b);
  const out = [];
  for (const h of sh) if (!out.length || h - out[out.length - 1] >= MIN_GAP) out.push(h);
  s.shelves = out.slice(0, 8);
  const last = s.shelves[s.shelves.length - 1];
  if (s.height - last > 0 && s.height - last < MIN_GAP) { // 顶框太贴近最高层：并成一层，或（会矮于下限时）去掉这层
    if (last >= minH) s.height = last;
    else if (s.shelves.length > 1) s.shelves.pop();
  }
  s.levels = s.shelves.length;
  s.hooks = Math.round(clamp(num(raw.hooks, 0), 0, Math.min(10, Math.floor(s.width / 6)))); // 挂钩间距至少约 6cm
  s.shelfMaterial = Object.hasOwn(BOARD_MATERIALS, raw.shelfMaterial) ? raw.shelfMaterial : '实木';
  const d = num(raw.rodDiameter, 12);
  s.rodDiameter = ROD_DIAMETERS.reduce((p, c) => Math.abs(c - d) < Math.abs(p - d) ? c : p);
  s.rodFinish = Object.hasOwn(ROD_FINISHES, raw.rodFinish) ? raw.rodFinish : '银色铝';
  return s;
}

// 骨架：x 沿宽度、y 向上、z 沿进深（z = D 是正面），单位 mm
export function buildSkeleton(s) {
  const W = s.width * 10, D = s.depth * 10, H = s.height * 10;
  const rods = [];
  const add = (a, b, role) => rods.push({ a, b, role });
  for (const x of [0, W]) for (const z of [0, D]) add([x, 0, z], [x, H, z], '立柱');
  const levels = [...new Set([...s.shelves.map(h => h * 10), H])].sort((a, b) => a - b);
  for (const y of levels) {
    add([0, y, 0], [W, y, 0], '后横杆'); add([0, y, D], [W, y, D], '前横杆');
    add([0, y, 0], [0, y, D], '侧横杆'); add([W, y, 0], [W, y, D], '侧横杆');
  }
  if (s.width > MID_SUPPORT_OVER) for (const h of s.shelves) add([W / 2, h * 10, 0], [W / 2, h * 10, D], '中间托杆');
  let umbrella = null;
  if (s.umbrella) {
    const y = H - 50, X = W + UMBRELLA_OUT * 10;
    add([W, y, 0], [X, y, 0], '挂伞支臂'); add([W, y, D], [X, y, D], '挂伞支臂');
    add([X, y, 0], [X, y, D], '挂伞杆');
    umbrella = { x: X, y, rings: Math.max(2, Math.floor(D / 100)) };
  }
  const hooks = Array.from({ length: s.hooks }, (_, i) => [W * (i + 1) / (s.hooks + 1), H, D]);
  return { W, D, H, d: s.rodDiameter, rods, levels, umbrella, hooks };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.sqrt(dot(a, a));
const norm = a => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
const key = p => p.map(v => Math.round(v)).join(',');

function segIntersect(a1, a2, b1, b2) {
  const d1 = sub(a2, a1), d2 = sub(b2, b1), r = sub(a1, b1);
  const a = dot(d1, d1), e = dot(d2, d2), b = dot(d1, d2), c = dot(d1, r), f = dot(d2, r);
  const den = a * e - b * b;
  if (den < 1e-9) return null; // 平行/共线不算交点
  let s = clamp((b * f - c * e) / den, 0, 1);
  const t = clamp((b * s + f) / e, 0, 1);
  s = clamp((b * t - c) / a, 0, 1);
  const p = [a1[0] + d1[0] * s, a1[1] + d1[1] * s, a1[2] + d1[2] * s];
  const q = [b1[0] + d2[0] * t, b1[1] + d2[1] * t, b1[2] + d2[2] * t];
  return len(sub(p, q)) < 0.5 ? p : null;
}

function classify(arms, p, isVerticalEnd) {
  if (arms.length === 1) return isVerticalEnd && Math.abs(p[1]) < 0.5 ? '底座' : '端帽';
  const axes = [];
  for (const v of arms) {
    for (const u of arms) {
      const c = Math.abs(dot(u, v));
      if (c > 1e-3 && c < 0.999) return '旋转夹';
    }
    if (!axes.some(u => Math.abs(dot(u, v)) > 0.999)) axes.push(v);
  }
  const n = arms.length, k = axes.length;
  if (n === 2) return k === 1 ? '直通接头' : '直角件';
  if (n === 3) return k === 2 ? 'T型件' : '三通角件';
  if (n === 4) return k === 2 ? '十字件' : '四通角件';
  return n === 5 ? '五通件' : '六通件';
}

// 求所有节点、连接件类型、每根杆的下料长度
export function analyzeSkeleton(sk) {
  const nodes = new Map();
  const touch = (p, ri) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { p, rods: new Set() });
    nodes.get(k).rods.add(ri);
  };
  sk.rods.forEach((r, i) => { touch(r.a, i); touch(r.b, i); });
  for (let i = 0; i < sk.rods.length; i++)
    for (let j = i + 1; j < sk.rods.length; j++) {
      const p = segIntersect(sk.rods[i].a, sk.rods[i].b, sk.rods[j].a, sk.rods[j].b);
      if (p) { touch(p, i); touch(p, j); }
    }
  const out = [];
  const endConnected = sk.rods.map(() => [false, false]);
  for (const { p, rods } of nodes.values()) {
    const arms = [];
    let throughVertical = false, verticalEnd = false;
    for (const ri of rods) {
      const r = sk.rods[ri];
      const atA = len(sub(p, r.a)) < 0.5, atB = len(sub(p, r.b)) < 0.5;
      const dir = norm(sub(r.b, r.a));
      const vertical = Math.abs(dir[1]) > 0.999;
      if (atA || atB) {
        arms.push(atA ? dir : dir.map(v => -v));
        if (vertical) verticalEnd = true;
        if (rods.size > 1) endConnected[ri][atA ? 0 : 1] = true;
      } else {
        arms.push(dir, dir.map(v => -v));
        if (vertical) throughVertical = true;
      }
    }
    out.push({ p, type: classify(arms, p, verticalEnd), through: throughVertical });
  }
  const d = sk.d;
  const cuts = sk.rods.map((r, i) => {
    const L = len(sub(r.b, r.a));
    const deduct = endConnected[i].reduce((s, c) => s + (c ? d / 2 : FOOT_DEDUCT), 0);
    return { role: r.role, length: Math.round(L - deduct) };
  });
  return { nodes: out, cuts };
}

// 零件表：只由参数确定性计算。price 为参考单价（元），用户可改
export function computeBOM(s) {
  const sk = buildSkeleton(s);
  const { nodes, cuts } = analyzeSkeleton(sk);
  const d = s.rodDiameter, rows = [];
  const perMeter = { 6: 6, 8: 8, 10: 10, 12: 12, 16: 18, 20: 25 }[d];
  const rodGroups = new Map();
  for (const c of cuts) {
    const g = rodGroups.get(c.length) || { qty: 0, roles: new Set() };
    g.qty++; g.roles.add(c.role); rodGroups.set(c.length, g);
  }
  [...rodGroups.entries()].sort((a, b) => b[0] - a[0]).forEach(([L, g]) => rows.push({
    cat: '光轴', name: `光轴 Φ${d}（${s.rodFinish}）`, spec: `${L} mm（${[...g.roles].join('/')}）`,
    qty: g.qty, unit: '根', price: Math.round(perMeter * L / 100) / 10,
  }));
  const conPrice = { 'T型件': 8, '十字件': 10, '直角件': 6, '三通角件': 12, '四通角件': 14, '直通接头': 5, '旋转夹': 15, '五通件': 16, '六通件': 18, '底座': 5, '端帽': 1 };
  const counts = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  for (const [t, q] of Object.entries(counts).sort()) rows.push({
    cat: t === '底座' || t === '端帽' ? '配件' : '连接件', name: t, spec: `适配 Φ${d}`, qty: q, unit: '个', price: conPrice[t] ?? 10,
  });
  const throughOnPosts = nodes.filter(n => n.through).length;
  const umbRings = sk.umbrella ? sk.umbrella.rings : 0;
  if (throughOnPosts + umbRings) rows.push({
    cat: '配件', name: '限位环', spec: `Φ${d}，立柱贯穿处防滑 ${throughOnPosts}${umbRings ? ` + 伞杆分隔 ${umbRings}` : ''}`,
    qty: throughOnPosts + umbRings, unit: '个', price: 2,
  });
  const m = BOARD_MATERIALS[s.shelfMaterial];
  const bw = s.width * 10 + d, bd = s.depth * 10 + d;
  rows.push({
    cat: '隔板', name: `${s.shelfMaterial}隔板`, spec: `${bw}×${bd}×${m.thickness} mm，四角开 Φ${d + 2} 缺口`,
    qty: s.shelves.length, unit: '块', price: Math.round(m.pricePerM2 * bw * bd / 1e6),
  });
  if (s.hooks) rows.push({ cat: '配件', name: '挂钩（夹扣式）', spec: `卡 Φ${d} 顶部前横杆`, qty: s.hooks, unit: '个', price: 5 });
  if (s.umbrella) rows.push({ cat: '配件', name: '接水盘', spec: `160×${s.depth * 10}×20 mm`, qty: 1, unit: '个', price: 30 });
  const totalRod = cuts.reduce((a, c) => a + c.length, 0);
  return { rows, totalRodMM: totalRod, skeleton: sk, nodes };
}

export function bomToCSV(rows, title = '') {
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['类别', '名称', '规格', '数量', '单位', '单价(元)', '小计(元)']];
  let total = 0;
  for (const r of rows) {
    const sub = Math.round(r.qty * (Number(r.price) || 0) * 100) / 100;
    total += sub;
    lines.push([r.cat, r.name, r.spec, r.qty, r.unit, r.price, sub]);
  }
  lines.push(['', '', '', '', '', '合计', Math.round(total * 100) / 100]);
  return '﻿' + (title ? esc(title) + '\r\n' : '') + lines.map(l => l.map(esc).join(',')).join('\r\n');
}
