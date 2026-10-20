// vp.js — 从照片里检测直线 → 消失点 → 地平线、左右倾斜、墙面方向（纯几何，不靠 AI）
// 步骤：缩到长边 640 → Sobel 梯度 → 按梯度方向区域生长出线段（简化版 LSD）
//      → RANSAC 依次找最多 3 个消失点 → 判出竖直方向 → 地平线 = 与竖直方向垂直的平面的消失线
// 坐标约定：图像 y 向下；相机坐标 (x 右, y 下, z 朝前)，焦距 f 像素

const DEG = Math.PI / 180;

function segments(gray, W, H) {
  const n = W * H, gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, g = k => gray[i + k];
    gx[i] = g(-W + 1) + 2 * g(1) + g(W + 1) - g(-W - 1) - 2 * g(-1) - g(W - 1);
    gy[i] = g(W - 1) + 2 * g(W) + g(W + 1) - g(-W - 1) - 2 * g(-W) - g(-W + 1);
    mag[i] = Math.hypot(gx[i], gy[i]);
  }
  const cand = [];
  for (let i = 0; i < n; i++) if (mag[i] > 60) cand.push(i);
  cand.sort((a, b) => mag[b] - mag[a]);
  const used = new Uint8Array(n), out = [], tol = Math.cos(22.5 * DEG), q = new Int32Array(8000);
  for (const s of cand) {
    if (used[s]) continue;
    let cx = gx[s] / mag[s], cy = gy[s] / mag[s], sx = cx, sy = cy, head = 0, tail = 0;
    q[tail++] = s; used[s] = 1;
    while (head < tail && tail < 7990) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) continue;
        const j = yy * W + xx; if (used[j] || mag[j] < 30) continue;
        if ((gx[j] * cx + gy[j] * cy) / mag[j] < tol) continue;
        used[j] = 1; q[tail++] = j; sx += gx[j] / mag[j]; sy += gy[j] / mag[j];
        const l = Math.hypot(sx, sy); cx = sx / l; cy = sy / l;
      }
    }
    if (tail < 15) continue;
    let mx = 0, my = 0;
    for (let k = 0; k < tail; k++) { mx += q[k] % W; my += (q[k] / W) | 0; }
    mx /= tail; my /= tail;
    let a = 0, b = 0, c = 0;
    for (let k = 0; k < tail; k++) { const x = q[k] % W - mx, y = ((q[k] / W) | 0) - my; a += x * x; b += x * y; c += y * y; }
    const th = 0.5 * Math.atan2(2 * b, a - c), ex = Math.cos(th), ey = Math.sin(th);
    let lo = 1e9, hi = -1e9, wlo = 1e9, whi = -1e9;
    for (let k = 0; k < tail; k++) {
      const x = q[k] % W - mx, y = ((q[k] / W) | 0) - my, p = x * ex + y * ey, w = -x * ey + y * ex;
      lo = Math.min(lo, p); hi = Math.max(hi, p); wlo = Math.min(wlo, w); whi = Math.max(whi, w);
    }
    const len = hi - lo;
    if (len < 20 || len / Math.max(1, whi - wlo) < 4) continue;
    out.push({ x1: mx + ex * lo, y1: my + ey * lo, x2: mx + ex * hi, y2: my + ey * hi, mx, my, dx: ex, dy: ey, len,
      a: -ey, b: ex, c: ey * mx - ex * my }); // 直线 a x + b y + c = 0，(a,b) 为单位法向
  }
  return out;
}

// 线段是否指向消失点 v（齐次 [x,y,w]）：夹角 < tolDeg
function agrees(s, v, tolDeg) {
  let dx = v[0] - s.mx * v[2], dy = v[1] - s.my * v[2];
  const l = Math.hypot(dx, dy); if (l < 1e-9) return true;
  return Math.abs(dx * s.dy - dy * s.dx) / l < Math.sin(tolDeg * DEG);
}

function findVP(segs, rand) {
  let best = null, bestScore = 0;
  const total = segs.reduce((t, s) => t + s.len, 0), pick = () => { let r = rand() * total; for (const s of segs) if ((r -= s.len) <= 0) return s; return segs[segs.length - 1]; };
  for (let it = 0; it < 800; it++) {
    const p = pick(), q = pick(); if (p === q) continue;
    const v = [p.b * q.c - p.c * q.b, p.c * q.a - p.a * q.c, p.a * q.b - p.b * q.a];
    const nv = Math.hypot(...v); if (nv < 1e-12) continue;
    v[0] /= nv; v[1] /= nv; v[2] /= nv;
    let score = 0; for (const s of segs) if (agrees(s, v, 1.5)) score += s.len;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  if (!best) return null;
  const inl = segs.filter(s => agrees(s, best, 2));
  // 加权最小二乘细化（消失点离得太远时矩阵病态，保留 RANSAC 结果）
  let A = 0, B = 0, C = 0, D = 0, E = 0;
  for (const s of inl) { const w = s.len; A += w * s.a * s.a; B += w * s.a * s.b; C += w * s.b * s.b; D += w * s.a * s.c; E += w * s.b * s.c; }
  const det = A * C - B * B;
  if (Math.abs(best[2]) > 1e-3 && det > 1e-6 * (A + C) * (A + C)) {
    const x = (-D * C + B * E) / det, y = (-A * E + B * D) / det, l = Math.hypot(x, y, 1);
    best = [x / l, y / l, 1 / l];
  }
  return { v: best, inl, score: bestScore };
}

// img: <img> 或 canvas；hfov: 横向视角（度）。返回 { horizonY, roll, wallAz:[...], segs, vps } 或 null
export function detectHorizon(img, hfov) {
  const k = Math.min(1, 640 / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const W = Math.round((img.naturalWidth || img.width) * k), H = Math.round((img.naturalHeight || img.height) * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  let segs = segments(gray, W, H);
  const nSeg = segs.length;
  if (nSeg < 4) return null;
  const f = W / 2 / Math.tan(hfov / 2 * DEG), cx = W / 2, cy = H / 2;
  let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const totalLen = segs.reduce((t, s) => t + s.len, 0), vps = [];
  for (let n = 0; n < 3 && segs.length >= 2; n++) {
    const r = findVP(segs, rand);
    if (!r || r.score < Math.max(60, 0.06 * totalLen)) break;
    const v = r.v, d = [v[0] - cx * v[2], v[1] - cy * v[2], f * v[2]], l = Math.hypot(...d);
    const dir = d.map(t => t / l);
    if (dir[1] < 0) dir.forEach((t, i) => dir[i] = -t);           // 统一朝图像下方
    const steep = r.inl.reduce((t, s) => t + s.len * Math.abs(s.dy), 0) / r.score; // 内点平均"竖直程度"
    vps.push({ v, dir, inl: r.inl, score: r.score, steep, below: Math.abs(v[2]) < 1e-6 ? true : v[1] / v[2] > cy });
    const set = new Set(r.inl); segs = segs.filter(s => !set.has(s));
  }
  if (!vps.length) return null;
  // 估焦距（没 EXIF 时用）：两两正交的消失点满足 (v1-c)·(v2-c) = -f²。竖直 + 水平一定正交；两个水平的按房间两条轴算
  const est = [];
  for (let i = 0; i < vps.length; i++) for (let j = i + 1; j < vps.length; j++) {
    const a = vps[i].v, b = vps[j].v; if (Math.abs(a[2]) < 1e-6 || Math.abs(b[2]) < 1e-6) continue;
    const ax = a[0] / a[2] - cx, ay = a[1] / a[2] - cy, bx = b[0] / b[2] - cx, by = b[1] / b[2] - cy;
    if (Math.hypot(ax, ay) > 20 * W || Math.hypot(bx, by) > 20 * W) continue;
    const f2 = -(ax * bx + ay * by); if (f2 <= 0) continue;
    const h = 2 * Math.atan(W / 2 / Math.sqrt(f2)) / DEG;
    if (h > 30 && h < 110) est.push({ h, w: Math.min(vps[i].score, vps[j].score) });
  }
  est.sort((p, q) => p.h - q.h);
  let hfovEst = null, acc = 0, tot = est.reduce((t, e) => t + e.w, 0);
  for (const e of est) if ((acc += e.w) >= tot / 2) { hfovEst = +e.h.toFixed(1); break; } // 加权中位数
  // 竖直消失点：内点大多接近竖直，且在画面中心下方（俯拍）或无穷远
  const vert = vps.filter(p => p.steep > 0.9 && p.below && p.dir[1] > 0.6).sort((a, b) => b.score - a.score)[0];
  const hor = vps.filter(p => p !== vert);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a); return a.map(t => t / l); };
  let u = null, src = '';
  if (vert) { u = vert.dir; src = 'vertical'; }
  const pair = hor.length >= 2 && Math.abs(dot(hor[0].dir, hor[1].dir)) < 0.17 ? norm(cross(hor[0].dir, hor[1].dir)) : null;
  if (pair) {
    if (pair[1] < 0) pair.forEach((t, i) => pair[i] = -t);
    if (!u) { u = pair; src = 'two-horizontal'; }
    else if (dot(u, pair) > 0.98) { u = norm(u.map((t, i) => t * vert.score + pair[i] * (hor[0].score + hor[1].score) / 2)); src = 'vertical+horizontal'; }
  }
  if (!u && hor.length) { const d = hor[0].dir; u = norm([0, d[2], -d[1]]); if (u[1] < 0) u = u.map(t => -t); src = 'one-horizontal'; } // 假设不歪
  if (!u) return null;
  // 地平线：图像点 p 满足 u · (p - c, f) = 0
  const horizonY = (cy - u[2] * f / u[1]) / H;
  const roll = -Math.atan2(u[0], u[1]) / DEG; // 与 viewer 相机 rotation.z 同号
  // 墙面方向：水平消失点在水平面内相对相机右方向的角度（右端更远为正）
  const right = norm([1 - u[0] * u[0], -u[0] * u[1], -u[0] * u[2]]), fwd = norm(cross(right, u)); // 右 × 下 = 前
  const flat = hor.filter(p => Math.abs(dot(p.dir, u)) < 0.2);
  const rawAz = flat.map(p => {
    const d = norm(p.dir.map((t, i) => t - dot(p.dir, u) * u[i]));
    return Math.atan2(dot(d, fwd), dot(d, right)) / DEG;
  });
  const wallAz = rawAz.map(a => ((a % 90) + 135) % 90 - 45); // 折到 (-45, 45]
  const across = rawAz.map(a => Math.abs(((a % 180) + 270) % 180 - 90) < 45); // 横向（与正面墙平行）还是纵深方向
  // 水平方向（地面/墙脚）的线段，给 AI 指的墙脚点做吸附；坐标 0~1
  const hlines = flat.flatMap((p, i) => p.inl.map(s => [s.x1 / W, s.y1 / H, s.x2 / W, s.y2 / H, across[i]]));
  const strength = vps.reduce((t, p) => t + p.score, 0) / W; // 消失点支撑线段总长（以画面宽为单位），越大透视越可靠
  return { horizonY, roll, wallAz, hlines, strength, src, nSeg, hfovEst, nEst: est.length, vps: vps.map(p => ({ score: Math.round(p.score), steep: +p.steep.toFixed(2), below: p.below })) };
}
