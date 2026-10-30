// test-scene.js — 测试用：three 渲染已知相机参数的合成玄关（后墙门 + 柜子 + 侧墙长凳），返回 { canvas, truth, check(viewer) }
// 用法（浏览器控制台）：const T = await import('./test-scene.js'); const r = T.render({ camH: 1.4, pitch: 28 });
import * as THREE from './vendor/three.module.js';

export function render({ camH = 1.4, pitch = 28, roll = 1.5, yaw = -8, camX = 0.1, camZ = 0.8, W = 768, H = 1024 } = {}) {
  const aspect = W / H, w35 = 43.27 * aspect / Math.hypot(1, aspect), hfov = 2 * Math.atan(w35 / 2 / 26) * 180 / Math.PI;
  const R = THREE.MathUtils.degToRad, scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdddddd);
  const room = new THREE.Group(); room.rotation.y = R(yaw); room.position.set(-camX, 0, -camZ); scene.add(room);
  const mat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
  const box = (x0, x1, y0, y1, z0, z1, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat(c)); m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); room.add(m); return m; };
  // 房间：后墙 z=-3，左墙 x=-1.3，右墙 x=1.9
  const BZ = -3, LX = -1.3, RX = 1.9;
  box(-4, 4, -0.02, 0, -6, 4, 0xb8946c);                                 // 地板
  for (let i = -6; i <= 6; i++) { box(i * 0.6 - 0.006, i * 0.6 + 0.006, 0, 0.002, -6, 4, 0x7a6048); box(-4, 4, 0, 0.002, i * 0.6 - 0.006 + BZ, i * 0.6 + 0.006 + BZ, 0x7a6048); }
  box(-4, 4, 0, 3, BZ - 0.1, BZ, 0xebe6de);                               // 后墙
  box(LX - 0.1, LX, 0, 3, BZ, 4, 0xe2ddd4);                               // 左墙
  box(RX, RX + 0.1, 0, 3, BZ, 4, 0xe2ddd4);                               // 右墙
  box(LX, RX, 0, 0.08, BZ, BZ + 0.015, 0x4a3c30); box(LX, LX + 0.015, 0, 0.08, BZ, 4, 0x4a3c30); // 踢脚线
  // 门（后墙，铰链 x=0.5，锁 x=1.4，向内开，关着）
  const door = { hinge: [0.5, BZ], latch: [1.4, BZ] };
  box(0.42, 0.5, 0, 2.13, BZ, BZ + 0.03, 0xf4f4f4); box(1.4, 1.48, 0, 2.13, BZ, BZ + 0.03, 0xf4f4f4); box(0.42, 1.48, 2.05, 2.13, BZ, BZ + 0.03, 0xf4f4f4);
  box(0.5, 1.4, 0, 2.05, BZ, BZ + 0.04, 0x7a5230);
  box(1.25, 1.33, 1.0, 1.03, BZ + 0.04, BZ + 0.09, 0xcccccc);              // 把手
  for (const y of [0.3, 1.0, 1.75]) box(0.5, 0.53, y, y + 0.1, BZ + 0.04, BZ + 0.06, 0x999999); // 合页
  // 柜子（靠后墙左段）、长凳（靠左墙）
  const cab = [LX, -0.5, BZ, BZ + 0.4];
  box(cab[0], cab[1], 0, 0.06, cab[2], cab[3] - 0.03, 0x333333); box(cab[0], cab[1], 0.06, 0.9, cab[2], cab[3], 0xd8d2c8);
  box(cab[0] + 0.4 - 0.005, cab[0] + 0.4 + 0.005, 0.1, 0.86, cab[3], cab[3] + 0.003, 0x888888);
  const bench = [LX, LX + 0.4, -1.5, -0.9];
  box(bench[0], bench[1], 0.42, 0.47, bench[2], bench[3], 0x9b6b43);
  for (const [x, z] of [[bench[0] + 0.04, bench[2] + 0.04], [bench[1] - 0.04, bench[2] + 0.04], [bench[0] + 0.04, bench[3] - 0.04], [bench[1] - 0.04, bench[3] - 0.04]]) box(x - 0.02, x + 0.02, 0, 0.42, z - 0.02, z + 0.02, 0x5a3d26);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x887766, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-2, 4, 3); scene.add(sun);
  const th = Math.tan(R(hfov) / 2), cam = new THREE.PerspectiveCamera(2 * Math.atan(th / aspect) * 180 / Math.PI, aspect, 0.05, 50);
  cam.position.set(0, camH, 0); cam.rotation.set(-R(pitch), 0, R(roll), 'YXZ');
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); r.setSize(W, H, false); r.render(scene, cam);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; canvas.getContext('2d').drawImage(r.domElement, 0, 0); r.dispose();
  room.updateMatrixWorld(true);
  const toLocal = (x, z) => { const v = room.worldToLocal(new THREE.Vector3(x, 0, z)); return [v.x, v.z]; };
  // 真值地平线 y（0~1）
  const horizonY = 0.5 - Math.tan(R(pitch)) / (2 * th / aspect);
  // 检查 viewer 最终摆放：4 角 + 边中点（房间坐标）是否在柜子/长凳/门扇扇形/墙外，背面离最近墙多远
  function check(v) {
    const t = v.t, a = R(t.rot), c = Math.cos(a), s = Math.sin(a), k = t.scale, Wm = v.widthM * k, Dm = v.depthM * k, pts = [];
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) { const lx = (-0.5 + i / 4) * Wm, lz = (-0.5 + j / 2) * Dm; pts.push(toLocal(t.x + lx * c + lz * s, t.z - lx * s + lz * c)); }
    const inBox = ([x, z], b) => x > b[0] && x < b[1] && z > b[2] && z < b[3];
    const hits = [];
    if (pts.some(p => inBox(p, cab))) hits.push('柜子');
    if (pts.some(p => inBox(p, bench))) hits.push('长凳');
    if (pts.some(p => p[1] > BZ && Math.hypot(p[0] - 0.5, p[1] - BZ) < 0.9)) hits.push('门扇');
    if (pts.some(p => p[0] < LX - 0.01 || p[0] > RX + 0.01 || p[1] < BZ - 0.01)) hits.push('穿墙');
    const back = [0, 1, 2, 3, 4].map(i => pts[i * 3]); // lz = -D/2 那条边
    const gap = Math.min(...back.map(([x, z]) => Math.min(z - BZ, x - LX, RX - x)));
    return { hits, gap: +gap.toFixed(3), center: toLocal(t.x, t.z).map(n => +n.toFixed(2)), rot: Math.round(t.rot - yaw) };
  }
  return { canvas, hfov, truth: { camH, pitch, roll, yaw, horizonY, door }, check, toLocal };
}

// 整个流程：渲染 → 塞进 #pick → 生成方案 → 等摆放和 AI 复查。先调 start()，再反复调 result() 直到 done
// 测试时方案用本地模拟（省时间、省额度）；reuse = true 时识图结果用上次缓存的（只测几何）
export async function start(opts = {}, { desc = '放 8 双鞋，宽 80cm 以内', reuse = false } = {}) {
  if (!window.__fetch0) {
    window.__fetch0 = window.fetch;
    const { mockGenerate } = await import('./mock.js');
    window.fetch = async (url, init) => {
      const u = String(url), body = init?.body ? JSON.parse(init.body) : {}, json = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('api/generate')) return json({ schemes: mockGenerate(body), mock: true });
      if (u.endsWith('api/scene') && window.__reuse && localStorage.sceneCache) return json({ scene: JSON.parse(localStorage.sceneCache) });
      const res = await window.__fetch0(url, init);
      if (u.endsWith('api/scene')) res.clone().json().then(j => j.scene && (localStorage.sceneCache = JSON.stringify(j.scene)));
      if (u.endsWith('api/check')) res.clone().json().then(j => (window.__checks = window.__checks || []).push(j.check));
      return res;
    };
  }
  window.__reuse = reuse; window.__checks = [];
  const r = window.__T = render(opts), blob = await new Promise(d => r.canvas.toBlob(d, 'image/jpeg', 0.9));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'hall.jpg', { type: 'image/jpeg' }));
  const pick = document.getElementById('pick'); pick.files = dt.files; pick.dispatchEvent(new Event('change'));
  document.getElementById('desc').value = desc;
  window.__T0 = Date.now();
  setTimeout(() => document.getElementById('gen').click(), 300);
  return 'started';
}
export function result() {
  const A = window.__app, v = A.viewer, s = v.scene0, r = window.__T, p = A.S.photos[A.S.best || 0];
  if (!A.S.placed || A.S.checking) return { done: false, sec: Math.round((Date.now() - window.__T0) / 1000) };
  const ai = A.S.sceneCtx?.ai || {};
  return {
    done: true, sec: Math.round((Date.now() - window.__T0) / 1000),
    hfov: [+s.hfov.toFixed(1), +r.hfov.toFixed(1)], horizonY: [+s.horizonY.toFixed(3), +r.truth.horizonY.toFixed(3)], roll: [+s.roll.toFixed(1), r.truth.roll],
    camH: [+s.camH.toFixed(2), r.truth.camH, s.camHSrc], wall: s.wall, corner: s.corner, obs: v.obstacles.map(o => o.name), door: !!v.door,
    aiPts: { wallBase: ai.wallBase, corner: ai.corner, obstacles: ai.obstacles, door: ai.door, doorTop: ai.doorTop, doorBottom: ai.doorBottom },
    obsLocal: v.obstacles.map(o => [o.name, o.poly.map(q => r.toLocal(q.x, q.z).map(n => +n.toFixed(2)))]),
    fit: v.fitNote, check: document.getElementById('check-msg').textContent, res: r.check(v), W: v.widthM, geoSrc: p?.geo?.src,
  };
}
