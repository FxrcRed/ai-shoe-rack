// viewer.js — 把方案参数渲染成光轴鞋架，透明背景叠在照片上；拖动/缩放/旋转对位；避开门扇开启范围；结算页旋转展示
import * as THREE from './vendor/three.module.js';
import { buildSkeleton, analyzeSkeleton, BOARD_MATERIALS, ROD_FINISHES, UMBRELLA_OUT } from './rack.js';
import { SHOES, shoeLayout } from './shoes.js';

const MM = 0.001, FOOT = 15; // 底座高 mm

// ---------- 参照鞋几何（每种鞋只建一次）----------
const shoeGeo = {};
function shoeParts(kind) {
  if (shoeGeo[kind]) return shoeGeo[kind];
  const { L, W, H } = SHOES[kind];
  // 俯视轮廓：鞋跟略窄、前掌最宽、鞋头圆；shape 的 y = -沿长度，挤出后 rotateX(-90°) → 鞋头朝 +z、高度朝 +y
  const outline = k => {
    const sh = new THREE.Shape(), pts = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24, half = W / 2 * k * (u < 0.68 ? 0.78 + 0.22 * Math.sin(u / 0.68 * Math.PI / 2) : Math.sqrt(Math.max(0, 1 - ((u - 0.68) / 0.32) ** 2)));
      pts.push([half, -u * L * k - L * (1 - k) / 2]);
    }
    const r = pts[0][0];
    for (let i = 1; i < 8; i++) pts.unshift([r * Math.cos(i / 8 * Math.PI / 2), -L * (1 - k) / 2 + r * 0.6 * Math.sin(i / 8 * Math.PI / 2)]); // 鞋跟圆弧（右半）
    const right = pts, left = right.slice().reverse().map(([x, y]) => [-x, y]);
    [...right, ...left].forEach(([x, y], i) => i ? sh.lineTo(x, y) : sh.moveTo(x, y));
    return sh;
  };
  const ex = (sh, depth, bevel) => {
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: !!bevel, bevelSize: bevel, bevelThickness: bevel * 1.6, bevelSegments: 3, curveSegments: 6 });
    g.rotateX(-Math.PI / 2); g.scale(MM, MM, MM); return g;
  };
  const soleH = 22, up = outline(0.94);
  // 鞋头一段低（toe），鞋身后 2/3 高（body）
  const g = {
    sole: ex(outline(1), soleH, 0),
    toe: ex(up, (H - soleH) * 0.45, 10),
    body: ex(up, (H - soleH) * 0.7, 12),
  };
  g.toe.translate(0, soleH * MM, 0); g.body.translate(0, soleH * MM, 0);
  g.body.scale(1, 1, 0.66); // 鞋身只占后 2/3
  return shoeGeo[kind] = g;
}

// 按方案建整个鞋架（含可选参照鞋），返回 { group, sk }；group 原点 = 占地中心、地面
export function buildRack(s, { shoes = false } = {}) {
  const sk = buildSkeleton(s), { nodes } = analyzeSkeleton(sk), d = sk.d;
  const metal = new THREE.MeshStandardMaterial({ color: ROD_FINISHES[s.rodFinish], metalness: 0.5, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: s.rodFinish === '黑色' ? 0x111111 : 0x55585e, metalness: 0.4, roughness: 0.5 });
  const g = new THREE.Group();
  g.position.set(-sk.W / 2 * MM, FOOT * MM, -sk.D / 2 * MM);
  const mesh = (geo, mat, pos) => { const m = new THREE.Mesh(geo, mat); m.position.set(...pos.map(v => v * MM)); m.castShadow = true; g.add(m); return m; };
  for (const r of sk.rods) {
    const a = new THREE.Vector3(...r.a), b = new THREE.Vector3(...r.b);
    const m = mesh(new THREE.CylinderGeometry(d / 2 * MM, d / 2 * MM, a.distanceTo(b) * MM, 16), metal, a.clone().add(b).multiplyScalar(0.5).toArray());
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  }
  for (const n of nodes) {
    if (n.type === '底座') mesh(new THREE.CylinderGeometry(d * 1.4 * MM, d * 1.6 * MM, FOOT * MM, 20), dark, [n.p[0], -FOOT / 2, n.p[2]]);
    else if (n.type === '端帽') mesh(new THREE.SphereGeometry(d * 0.6 * MM, 12, 8), dark, n.p);
    else {
      mesh(new THREE.BoxGeometry(d * 2 * MM, d * 2 * MM, d * 2 * MM), dark, n.p);
      if (n.through) mesh(new THREE.TorusGeometry(d * 0.75 * MM, d * 0.25 * MM, 8, 20), dark, [n.p[0], n.p[1] - d * 1.5, n.p[2]]).rotation.x = Math.PI / 2;
    }
  }
  const bm = BOARD_MATERIALS[s.shelfMaterial];
  const board = new THREE.MeshStandardMaterial({ color: bm.color, roughness: s.shelfMaterial === '玻璃' ? 0.05 : 0.7, metalness: s.shelfMaterial === '金属板' ? 0.6 : 0, transparent: bm.opacity < 1, opacity: bm.opacity });
  for (const h of s.shelves) mesh(new THREE.BoxGeometry((sk.W + d) * MM, bm.thickness * MM, (sk.D + d) * MM), board, [sk.W / 2, h * 10 + d / 2 + bm.thickness / 2, sk.D / 2]).receiveShadow = true;
  for (const p of sk.hooks) mesh(new THREE.TorusGeometry(18 * MM, 2.5 * MM, 6, 16, Math.PI * 1.3), dark, [p[0], p[1] - 22, p[2] + d]).rotation.z = Math.PI * 0.85;
  if (sk.umbrella) {
    const u = sk.umbrella;
    for (let i = 1; i <= u.rings; i++) mesh(new THREE.TorusGeometry(d * 0.75 * MM, d * 0.25 * MM, 8, 20), dark, [u.x, u.y, sk.D * i / (u.rings + 1)]);
    mesh(new THREE.BoxGeometry(160 * MM, 20 * MM, sk.D * MM), dark, [u.x, -FOOT + 10, sk.D / 2]);
  }
  if (shoes) {
    const mats = {};
    for (const k in SHOES) mats[k] = { up: new THREE.MeshStandardMaterial({ color: SHOES[k].upper, roughness: 0.8 }), sole: new THREE.MeshStandardMaterial({ color: SHOES[k].sole, roughness: 0.9 }) };
    for (const sh of shoeLayout(s).shoes) {
      const parts = shoeParts(sh.kind), m = mats[sh.kind], o = new THREE.Group();
      for (const [geo, mat] of [[parts.sole, m.sole], [parts.toe, m.up], [parts.body, m.up]]) { const x = new THREE.Mesh(geo, mat); x.castShadow = true; o.add(x); }
      o.position.set(sh.x * MM, sh.y * MM, sh.z * MM);
      if (sh.side === 'L') o.scale.x = -1;
      g.add(o);
    }
  }
  const group = new THREE.Group(); group.add(g);
  return { group, sk };
}

function disposeTree(o) {
  o.traverse(x => { if (x.isMesh) { if (!Object.values(shoeGeo).some(p => Object.values(p).includes(x.geometry))) x.geometry.dispose(); x.material.dispose(); } });
}

export class RackViewer {
  constructor(stage) {
    this.stage = stage;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    stage.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 50);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2 });
    this.scene.add(sun); this.sun = sun;
    this.root = new THREE.Group();   // 用户对位变换作用在 root 上
    sun.target = this.root;          // 阴影跟着鞋架走
    this.rack = new THREE.Group();
    this.root.add(this.rack);
    this.floorMat = new THREE.ShadowMaterial({ opacity: 0.28 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.floorMat);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    this.root.add(floor);
    this.scene.add(this.root);
    // 门扇开启范围示意（地面上的扇形虚线），有门时显示；鞋架压上去变红
    this.doorMark = new THREE.Group(); this.scene.add(this.doorMark);
    // 相机在 (0, camH, 0) 朝 -z 看；pitch 向下为正（度），hfov 为照片横向视角
    // 光：lightAz 光源方位（度，相机坐标：0 = 从相机这边照过去，-90 = 从画面左边，90 = 右边，180 = 从画面深处照向相机），lightEl 仰角
    this.t = { x: 0, z: -2.2, scale: 1, rot: 0, pitch: 18, roll: 0, hfov: 52, camH: 1.35, lightAz: -37, lightEl: 50 };
    this.showShoes = true;
    this.onChange = () => {};
    this.applyTransform();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
  }

  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false); // false：不改画布 CSS 尺寸（CSS 已铺满），否则 ResizeObserver 会循环
    this.applyTransform();
  }

  applyTransform() {
    const t = this.t, R = THREE.MathUtils.degToRad, c = this.camera, el = this.stage;
    const aspect = el.clientWidth && el.clientHeight ? el.clientWidth / el.clientHeight : 0.75;
    c.aspect = aspect;
    // 照片按 object-fit: cover 显示：舞台比照片宽时照片上下被裁，横向视角不变；反之按照片高度对齐
    c.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(R(t.hfov) / 2) / Math.max(aspect, this.photoAspect || aspect)));
    c.updateProjectionMatrix();
    c.position.set(0, t.camH, 0);
    c.rotation.set(-R(t.pitch), 0, R(t.roll), 'YXZ');
    this.root.position.set(t.x, 0, t.z);
    this.root.scale.setScalar(t.scale);
    this.root.rotation.y = R(t.rot);
    const a = R(t.lightAz), e = R(t.lightEl);
    this.sun.position.set(t.x + 3 * Math.cos(e) * Math.sin(a), 3 * Math.sin(e), t.z + 3 * Math.cos(e) * Math.cos(a));
    this.updateDoorMark();
    this.render();
    this.onFrame?.();
  }
  // 鞋架局部坐标（米，原点 = 底面中心，+x 右，+y 上，+z 正面）→ 舞台像素；给照片上的尺寸手柄用
  screenOf(x, y, z) {
    this.root.updateMatrixWorld();
    const v = this.root.localToWorld(new THREE.Vector3(x, y, z)).project(this.camera);
    return { x: (v.x + 1) / 2 * this.stage.clientWidth, y: (1 - v.y) / 2 * this.stage.clientHeight, front: v.z < 1 };
  }

  // 照片点 → 相机射线打到地面（按照片坐标，与舞台裁切无关）；打不到或太远返回 null
  floorAt([u, v]) {
    const R = THREE.MathUtils.degToRad, th = Math.tan(R(this.t.hfov) / 2), tv = th / (this.photoAspect || 0.75);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-R(this.t.pitch), 0, R(this.t.roll), 'YXZ'));
    const ray = new THREE.Ray(new THREE.Vector3(0, this.t.camH, 0), new THREE.Vector3((u * 2 - 1) * th, (1 - v * 2) * tv, -1).applyQuaternion(q).normalize()), hit = new THREE.Vector3();
    return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) && Math.hypot(hit.x, hit.z) < 8 ? hit : null;
  }
  // 按照片分析结果放相机和鞋架：
  // scene = { hfov, camH, horizonY(0=顶 1=底，可超出), roll, spot:[x,y], base:[x,y] 墙脚点, yaw, door:{hinge,latch,swing} }
  placeScene(scene) {
    this.scene0 = scene; this.dragged = false; this.pad = 0; // pad：AI 复查说碰到家具/挡门时禁区外扩的余量（米）
    const s = scene, R = THREE.MathUtils.degToRad;
    this.photoAspect = s.aspect || 0.75;
    const th = Math.tan(R(s.hfov) / 2), tv = th / this.photoAspect;
    const pitch = THREE.MathUtils.radToDeg(Math.atan((0.5 - s.horizonY) * 2 * tv));
    Object.assign(this.t, { hfov: s.hfov, camH: s.camH, pitch, roll: s.roll || 0, rot: s.yaw || 0, scale: 1 });
    this.setLight(s.light);
    this.door = this.doorFrom(s.door);
    // 有墙脚点：鞋架背面贴墙，中心 = 墙脚点 + 正面方向 × (进深/2 + 1cm)，换方案时按新进深重算
    let wallP = s.base && this.floorAt(s.base);
    this.roomFrom(s, wallP);
    const side = this.walls.find(w => w.side === s.wall);
    if (side) wallP = side.p.clone().addScaledVector(side.t, wallP ? wallP.clone().sub(side.p).dot(side.t) : 0.7); // 投到这面墙推算出的墙脚线上（AI 墙脚点只用来定沿墙的位置）
    this.anchor = wallP ? { p: wallP, p0: wallP.clone(), front: new THREE.Vector3(Math.sin(R(this.t.rot)), 0, Math.cos(R(this.t.rot))) } : null;
    if (this.anchor) return this.fitAnchor();
    const hit = this.floorAt(s.spot);
    this.set(hit ? { x: hit.x, z: hit.z } : { x: 0, z: -2.2 });
  }

  // ---------- 门：门洞底边两端打到地面 → 门宽、朝屋内的法向 ----------
  doorFrom(d) {
    if (!d) return null;
    const H = this.floorAt(d.hinge), L = this.floorAt(d.latch);
    if (!H || !L) return null;
    const w = H.distanceTo(L);
    if (w < 0.5 || w > 1.6) return null; // 不像一扇门（点错了）
    const u = L.clone().sub(H).divideScalar(w), n = new THREE.Vector3(-u.z, 0, u.x);
    const mid = H.clone().add(L).multiplyScalar(0.5);
    if (n.dot(new THREE.Vector3(0, 0, 0).sub(mid)) < 0) n.negate(); // 法向指向相机一侧 = 屋内
    return { H, L, w: Math.min(w, 1.0), u, n, swing: d.swing };
  }
  // ---------- 墙和家具：都变成地面上的禁区 ----------
  // 墙 = 半平面 {p 墙脚线上一点, n 朝屋内, t 沿墙}；墙角点 + 房间朝向（几何检测的墙面方向）→ 后墙和侧墙墙脚线
  // 家具 = AI 给的最近落地边打到地面，往远离相机方向补上长度、靠墙的补到墙 → 凸包
  roomFrom(s, wallP) {
    const R = THREE.MathUtils.degToRad(s.roomAz ?? (s.yaw || 0)), F = new THREE.Vector3(Math.sin(R), 0, Math.cos(R)), T = new THREE.Vector3(Math.cos(R), 0, -Math.sin(R));
    this.walls = []; this.obstacles = [];
    // 每面墙的墙脚线取最可靠的来源：门洞底边（门就开在墙上，AI 点门最准）> 墙角点 > AI 给的墙脚点（常点在家具前沿）
    const line = { left: null, right: null, back: null }, D = this.door;
    if (D) {
      const mid = D.H.clone().add(D.L).multiplyScalar(0.5);
      if (Math.abs(D.u.dot(T)) > 0.94) line.back = mid;
      else if (Math.abs(D.u.dot(F)) > 0.94) line[mid.dot(T) < 0 ? 'left' : 'right'] = mid;
    }
    for (const k of ['left', 'right']) {
      const c = s.corner?.[k] && this.floorAt(s.corner[k]); if (!c) continue;
      // 侧墙：墙角点常被家具挡住点偏；和 AI 墙脚点（要求点在墙前地面上）比，取更靠屋内的——偏屋内只是离墙一点，偏外会嵌进墙
      const n = T.clone().multiplyScalar(k === 'left' ? 1 : -1);
      line[k] = line[k] || (s.wall === k && wallP && wallP.clone().sub(c).dot(n) > 0 ? wallP.clone() : c);
      line.back = line.back || c;
    }
    if (wallP && s.wall in line) line[s.wall] = line[s.wall] || wallP.clone();
    if (line.back) this.walls.push({ side: 'back', p: line.back, n: F.clone(), t: T.clone() });
    if (line.left) this.walls.push({ side: 'left', p: line.left, n: T.clone(), t: F.clone().negate() });
    if (line.right) this.walls.push({ side: 'right', p: line.right, n: T.clone().negate(), t: F.clone().negate() });
    const axes = [F, T, F.clone().negate(), T.clone().negate()];
    for (const o of s.obstacles || []) {
      const P = o.pts.map(q => this.floorAt(q)).filter(Boolean); if (!P.length) continue;
      // 太小的（落地边 <25cm 且进深 <25cm，多半是地上的鞋/包）不算障碍，随手就能挪走
      if (o.depth < 0.25 && (P.length < 2 || P[0].distanceTo(P[P.length - 1]) < 0.25)) continue;
      // AI 给的是离相机最近的那条落地边（最准）→ 往远离相机方向（最接近的房间轴向）补上它说的长度；离墙 0.5m 以内再补到最近那面墙
      const away = P.reduce((a, q) => a.add(q), new THREE.Vector3()).setY(0).normalize();
      const d = axes.reduce((b, a) => a.dot(away) > b.dot(away) ? a : b).clone().multiplyScalar(o.depth);
      let pts = [...P, ...P.map(q => q.clone().add(d))];
      const near = this.walls.map(w => [w, Math.min(...P.map(q => q.clone().sub(w.p).dot(w.n)))]).filter(x => x[1] < 0.5).sort((x, y) => x[1] - y[1])[0]?.[0];
      if (near) pts = pts.concat(pts.map(q => q.clone().addScaledVector(near.n, -q.clone().sub(near.p).dot(near.n))));
      if (P.length === 1) pts.push(...[[1, 0], [0, 1], [1, 1]].map(([i, j]) => P[0].clone().addScaledVector(T, (i - 0.5) * 0.4).addScaledVector(d, j)));
      this.obstacles.push({ name: o.name, poly: hull(pts) });
    }
  }
  // 地面点是否在禁区：墙后、家具里（各留 3cm），门扇扫过的扇形（向内开，两侧都算）+ 门洞前 0.9m 的通道
  blocked(p) {
    for (const w of this.walls || []) if (p.clone().sub(w.p).dot(w.n) < -0.005) return true;
    for (const o of this.obstacles || []) if (inPoly(p, o.poly, 0.03 + (this.pad || 0))) return true;
    const D = this.door; if (!D) return false;
    const r = p.clone().sub(D.H), along = r.dot(D.u), into = r.dot(D.n), pad = this.pad || 0;
    if (into > -0.05 && into < 0.9 + pad && along > -0.1 - pad && along < D.w + 0.1 + pad) return true;
    // AI 认铰链常认反（实测把锁侧当铰链），所以锁侧也留 0.6 门宽的余量
    return D.swing !== 'out' && into > -0.05 && (r.length() < D.w + 0.12 + pad || p.distanceTo(D.L) < D.w * 0.6 + 0.1 + pad);
  }
  // 鞋架占地矩形（含挂伞杆伸出）在 (x,z) 时是否压到禁区
  hasZones() { return !!(this.door || this.walls?.length || this.obstacles?.length); }
  footprintBlocked(x, z, W = this.widthM, Dp = this.depthM) {
    if (!this.hasZones()) return false;
    const R = THREE.MathUtils.degToRad(this.t.rot), c = Math.cos(R), s = Math.sin(R), k = this.t.scale;
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 3; j++) {
      const lx = (-W / 2 + i / 6 * (W + (this.umbM || 0))) * k, lz = (j / 3 - 0.5) * Dp * k;
      if (this.blocked(new THREE.Vector3(x + lx * c + lz * s, 0, z - lx * s + lz * c))) return true;
    }
    return false;
  }

  // 贴墙放：压到门的开启范围、家具、墙角就沿墙滑开（取最近、仍在画面里的位置）；这面墙放不下就换其他已知的墙；都不行算这面墙最多放多宽
  fitAnchor() {
    const off = (this.depthM || 0.3) / 2 + 0.01, A = this.anchor, rot0 = this.t.rot;
    const inView = q => { const v = q.clone().project(this.camera); return v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 1; };
    const geo = (p0, front) => { const tan = new THREE.Vector3(front.z, 0, -front.x); return { p0, front, tan, at: sh => p0.clone().addScaledVector(tan, sh).addScaledVector(front, off) }; };
    const fits = ({ tan, at }, sh, W = this.widthM) => { const q = at(sh); return !this.footprintBlocked(q.x, q.z, W) && inView(q.clone().addScaledVector(tan, W / 2)) && inView(q.clone().addScaledVector(tan, -W / 2)); };
    const search = (g, W) => { for (let k = 0; k <= 300; k++) { const sh = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.02; if (fits(g, sh, W)) return sh; } return null; };
    this.fitNote = ''; this.suggestW = null;
    let g = geo(A.p0, A.front), best = this.hasZones() ? search(g) : 0;
    // 这面墙放不下：试其他推算出的墙（AI 选的墙常常没空地）；都放不下就在所有墙里找能放下的最大宽度
    const cands = [{ g, rot: rot0, side: '' }];
    for (const w of this.walls || []) if (w.n.dot(A.front) < 0.9)
      cands.push({ g: geo(w.p.clone().addScaledVector(w.t, A.p0.clone().sub(w.p).dot(w.t)), w.n.clone()), rot: THREE.MathUtils.radToDeg(Math.atan2(w.n.x, w.n.z)), side: w.side });
    const use = (c, sh) => { this.t.rot = c.rot; g = c.g; best = sh; Object.assign(A, { p0: c.g.p0, front: c.g.front }); if (c.side) this.fitNote = `原来那面墙放不下，改靠${{ left: '左', right: '右', back: '正对' }[c.side]}墙`; };
    if (best === null) for (const c of cands.slice(1)) { this.t.rot = c.rot; const sh = search(c.g); if (sh !== null) { use(c, sh); break; } }
    if (best === null) {
      let top = null;
      for (const c of cands) { this.t.rot = c.rot; for (let W = this.widthM - 0.05; W >= 0.3 && !(top && W <= top.W); W -= 0.05) { const sh = search(c.g, W); if (sh !== null) { top = { c, sh, W }; break; } } }
      this.t.rot = rot0; best = 0;
      if (top) { use(top.c, top.sh); this.suggestW = Math.floor(Math.round(top.W * 100) / 5) * 5; }
      this.fitNote = this.suggestW ? `${this.fitNote ? this.fitNote + '；' : ''}这里太宽会挡门或碰到家具，建议宽度 ≤ ${this.suggestW}cm` : '空地不够，放哪都会挡门或碰到家具，建议拖到别处';
    } else if (best && !this.fitNote) this.fitNote = `已沿墙挪开 ${Math.round(Math.abs(best) * 100)}cm，避开${this.door ? '门的开启范围、' : ''}家具和墙角`;
    // AI 估的家具位置/大小常差 10~30cm：空档富余不到 80cm 就居中，否则两端各至少留 25cm
    if (this.hasZones() && !this.suggestW && fits(g, best)) {
      let lo = best, hi = best;
      while (lo - best > -3 && fits(g, lo - 0.02)) lo -= 0.02;
      while (hi - best < 3 && fits(g, hi + 0.02)) hi += 0.02;
      const m = hi - lo < 0.8 ? (hi - lo) / 2 : 0.25, b2 = Math.max(lo + m, Math.min(hi - m, best));
      if (Math.abs(b2 - best) > 0.01 && !this.fitNote) this.fitNote = `已沿墙挪开 ${Math.round(Math.abs(b2) * 100)}cm，和家具、门留出余量`;
      best = b2;
    }
    A.p = g.p0.clone().addScaledVector(g.tan, best);
    const q = g.at(best);
    this.set({ x: q.x, z: q.z });
  }

  updateDoorMark() {
    const m = this.doorMark; m.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); }); m.clear();
    this.conflict = this.footprintBlocked(this.t.x, this.t.z);
    const col = this.conflict ? 0xff3b30 : 0xffffff, pts = [];
    const dashed = P => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P), new THREE.LineDashedMaterial({ color: col, dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: 0.85 })); l.computeLineDistances(); m.add(l); };
    for (const o of this.obstacles || []) dashed([...o.poly, o.poly[0]].map(q => q.clone().setY(0.003)));
    const D = this.door; if (!D) return;
    const a0 = Math.atan2(D.u.z, D.u.x), dir = Math.sign(D.u.x * D.n.z - D.u.z * D.n.x) || 1;
    if (D.swing !== 'out') {
      for (let i = 0; i <= 24; i++) { const a = a0 + dir * i / 24 * Math.PI / 2; pts.push(new THREE.Vector3(D.H.x + Math.cos(a) * D.w, 0.003, D.H.z + Math.sin(a) * D.w)); }
      pts.push(D.H.clone().setY(0.003), D.L.clone().setY(0.003));
    } else pts.push(D.H.clone().setY(0.003), D.L.clone().setY(0.003));
    dashed(pts);
  }

  // 按照片光影：方向（影子朝向）、影子深浅（硬光/散射光）、整体亮度跟照片曝光走
  setLight(L) {
    L = L || {};
    const k = L.exposure || 1;
    this.t.lightAz = L.az ?? -37; this.t.lightEl = L.el ?? 50;
    this.floorMat.opacity = L.opacity ?? 0.28;
    this.hemi.intensity = 1.6 * k; this.sun.intensity = 2.2 * k * (L.opacity ? 0.6 + L.opacity * 1.6 : 1);
    this.applyTransform();
  }

  set(patch) { Object.assign(this.t, patch); this.applyTransform(); this.onChange(this.t); }
  render() { this.renderer.render(this.scene, this.camera); }

  // live：拖动尺寸时的实时预览，只重画不重新避让（松手提交时再 fitAnchor）
  setScheme(s, live) {
    disposeTree(this.rack); this.rack.clear();
    const { group, sk } = buildRack(s, { shoes: this.showShoes });
    this.depthM = sk.D * MM; this.widthM = sk.W * MM; this.umbM = sk.umbrella ? UMBRELLA_OUT / 100 : 0;
    this.rack.add(group);
    this.cur = s;
    if (this.anchor && !this.dragged && !live) this.fitAnchor(); else this.applyTransform();
  }
  setShoes(on) { this.showShoes = on; if (this.cur) this.setScheme(this.cur); }

  // 单指拖动：沿地面移动；双指：缩放 + 旋转；滚轮：缩放（按住 Shift 旋转）
  bindPointer() {
    const el = this.renderer.domElement, pts = new Map();
    el.style.touchAction = 'none';
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), v = new THREE.Vector2();
    const floorHit = e => {
      const r = el.getBoundingClientRect();
      v.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
      ray.setFromCamera(v, this.camera);
      return ray.ray.intersectPlane(plane, new THREE.Vector3());
    };
    let last = null, pinch = null;
    const pinchState = () => { const [a, b] = [...pts.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) }; };
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) last = floorHit(e); else if (pts.size === 2) pinch = { ...pinchState(), scale: this.t.scale, rot: this.t.rot };
    });
    el.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1 && !last) last = floorHit(e);
      else if (pts.size === 1) {
        const p = floorHit(e); if (!p) return;
        this.anchor = null; this.dragged = true; // 用户拖过就不再自动贴墙，AI 复查也不再挪它
        this.set({ x: this.t.x + p.x - last.x, z: this.t.z + p.z - last.z }); last = p;
      } else if (pts.size === 2 && pinch) {
        const c = pinchState(); this.dragged = true;
        this.set({ scale: THREE.MathUtils.clamp(pinch.scale * c.dist / pinch.dist, 0.5, 2), rot: pinch.rot - THREE.MathUtils.radToDeg(c.ang - pinch.ang) });
      }
    });
    const up = e => { pts.delete(e.pointerId); pinch = null; last = null; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.shiftKey) this.set({ rot: this.t.rot + Math.sign(e.deltaY) * 5 });
      else this.set({ scale: THREE.MathUtils.clamp(this.t.scale * (e.deltaY > 0 ? 0.95 : 1.05), 0.5, 2) });
    }, { passive: false });
  }

  // 按照片原始比例合成（不受舞台裁切影响），坐标与照片 0~1 坐标一致：给 AI 复查摆放用
  composite(img, max = 1024) {
    const a = this.photoAspect || img.naturalWidth / img.naturalHeight, c = this.camera, r = this.renderer;
    const W = a >= 1 ? max : Math.round(max * a), H = Math.round(W / a);
    r.setPixelRatio(1); r.setSize(W, H, false);
    c.aspect = a; c.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.t.hfov) / 2) / a));
    c.updateProjectionMatrix(); r.render(this.scene, c);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d'); g.drawImage(img, 0, 0, W, H); g.drawImage(r.domElement, 0, 0);
    r.setPixelRatio(Math.min(2, devicePixelRatio)); this.resize();
    return out;
  }

  // 照片 + 3D 合成一张效果图（照片按 object-fit: cover 绘制，与页面显示一致）
  snapshot(img) {
    const c = document.createElement('canvas'), src = this.renderer.domElement;
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    if (img && img.naturalWidth) {
      const k = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    } else { ctx.fillStyle = '#e9e3da'; ctx.fillRect(0, 0, c.width, c.height); }
    this.render(); ctx.drawImage(src, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  }
}

// 结算页：产品在纯色"影棚"里展示。单指拖动 = 水平 360° 转 + 上下俯仰；双指 / 滚轮缩放；双击复位；松手后惯性转，慢慢回到自动旋转
export class Turntable {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 30);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b0b8, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-1.5, 3, 2.5); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5 }); key.shadow.radius = 4;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8); fill.position.set(2, 1.5, -1); this.scene.add(fill);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.18 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground);
    this.spin = new THREE.Group(); this.scene.add(this.spin);
    this.running = false; this.reset();
    const pts = new Map(); let pinch = null, lastTap = 0;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => {
      try { el.setPointerCapture(e.pointerId); } catch {} pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.vel = 0; this.hold = true;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom }; }
      if (pts.size === 1) { if (e.timeStamp - lastTap < 300) this.reset(); lastTap = e.timeStamp; }
    });
    el.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 1) {
        this.spin.rotation.y += dx * 0.012; this.v2 = dx * 0.0012;
        this.tilt = THREE.MathUtils.clamp(this.tilt + dy * 0.008, -0.35, 1.45);
      } else if (pinch) {
        const [a, b] = [...pts.values()];
        this.zoom = THREE.MathUtils.clamp(pinch.zoom * pinch.d / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 0.35, 2.5);
      }
      this.frame(); this.render();
    });
    const up = e => { pts.delete(e.pointerId); pinch = null; if (!pts.size) { this.hold = false; this.vel = Math.abs(this.v2 || 0) > 0.002 ? this.v2 : 0; this.v2 = 0; } };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { e.preventDefault(); this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY > 0 ? 1.08 : 0.93), 0.35, 2.5); this.frame(); this.render(); }, { passive: false });
    new ResizeObserver(() => this.resize()).observe(el);
  }
  reset() { this.tilt = 0.32; this.zoom = 1; this.vel = 0.006; this.spin.rotation.y = 0.5; this.frame(); }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); // false：不改画布 CSS 尺寸（CSS 已铺满），否则 ResizeObserver 会循环 this.camera.aspect = w / h; this.frame(); this.render();
  }
  setScheme(s) {
    disposeTree(this.spin); this.spin.clear();
    const { group, sk } = buildRack(s);
    this.size = { W: sk.W * MM + (sk.umbrella ? 0.24 : 0), D: sk.D * MM, H: sk.H * MM + FOOT * MM };
    this.spin.add(group); this.frame(); this.render();
  }
  // 相机绕产品中心做球面轨道：tilt 俯仰（弧度，负 = 从下往上看），zoom 距离倍数；距离按尺寸自动取景
  frame() {
    if (!this.size) return;
    const { W, D, H } = this.size, r = Math.hypot(W, D, H) / 2 + 0.03, c = this.camera;
    const dist = r / Math.sin(THREE.MathUtils.degToRad(Math.min(c.fov, c.fov * c.aspect) / 2)) * this.zoom;
    const ty = H * 0.48;
    c.position.set(0, ty + dist * Math.sin(this.tilt), dist * Math.cos(this.tilt)); c.lookAt(0, ty, 0); c.updateProjectionMatrix();
  }
  render() { this.renderer.render(this.scene, this.camera); }
  start() {
    if (this.running) return; this.running = true;
    const tick = () => {
      if (!this.running) return;
      if (!this.hold) { this.vel += ((Math.sign(this.vel) || 1) * 0.004 - this.vel) * 0.02; this.spin.rotation.y += this.vel; } // 惯性慢慢回到匀速自转
      this.render(); requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() { this.running = false; }
}

// 地面（xz）凸包，返回逆/顺时针点列
function hull(P) {
  const p = P.map(q => new THREE.Vector3(q.x, 0, q.z)).sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x), lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// 点在凸多边形内，或离边不到 m 米
function inPoly(q, poly, m) {
  let inside = poly.length > 2, sg = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1e-9;
    const c = ex * (q.z - a.z) - ez * (q.x - a.x);
    if (poly.length > 2) { if (sg && Math.sign(c) && Math.sign(c) !== sg) inside = false; sg = sg || Math.sign(c); }
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.z - a.z) * ez) / l2));
    if (Math.hypot(a.x + t * ex - q.x, a.z + t * ez - q.z) < m) return true;
  }
  return inside;
}
