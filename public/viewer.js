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


// ---------- 写实材质：程序生成纹理 + 简易棚拍环境反射（不下载任何贴图）----------
const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return hash(xi, yi) * (1 - u) * (1 - v) + hash(xi + 1, yi) * u * (1 - v) + hash(xi, yi + 1) * (1 - u) * v + hash(xi + 1, yi + 1) * u * v;
};
// 画布纹理：fn(x, y) 返回 [r,g,b]（0~1）；u 沿鞋架宽度（纹理方向），v 沿进深
const texCache = {};
function canvasTex(key, w, h, fn, srgb = true) {
  if (texCache[key]) return texCache[key];
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d'), img = cx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y), i = (y * w + x) * 4;
    img.data[i] = Math.min(255, r * 255); img.data[i + 1] = Math.min(255, g * 255); img.data[i + 2] = Math.min(255, b * 255); img.data[i + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return texCache[key] = t;
}
const tint = (hex, k) => [((hex >> 16) & 255) / 255 * k, ((hex >> 8) & 255) / 255 * k, (hex & 255) / 255 * k];
// 木纹：年轮带 + 细纤维，纹理沿 x
const woodTex = hex => canvasTex('wood' + hex, 512, 256, (x, y) => {
  const warp = vnoise(x * 0.006, y * 0.05) * 7, ring = 0.5 + 0.5 * Math.sin(y * 0.16 + warp);
  const fibre = vnoise(x * 0.015, y * 1.6), k = 0.62 + 0.26 * (ring * 0.55 + fibre * 0.45) + (hash(x, y) - 0.5) * 0.04;
  return tint(hex, k);
});
// 拉丝纹（灰度）：沿 x 的细条，同时做粗糙度和凹凸
const brushTex = () => canvasTex('brush', 256, 256, (x, y) => { const v = 0.55 + 0.4 * (vnoise(x * 0.01, y * 1.3) - 0.5) + 0.2 * (hash(0, y) - 0.5); return [v, v, v]; }, false);

// 真实贴图（Poly Haven fine_grained_wood，CC0，已压到 512px 灰度）：加载前/失败都用上面的程序材质，加载完通知查看器重绘
const realTex = {};
function loadReal(file, srgb) {
  if (realTex[file] !== undefined) return realTex[file];
  realTex[file] = null;
  new THREE.TextureLoader().load(new URL('./vendor/tex/' + file, import.meta.url).href, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    realTex[file] = t; window.dispatchEvent(new Event('rack-tex'));
  }, undefined, () => {});
  return null;
}

const envCache = new WeakMap();
function studioEnv(renderer) {
  if (envCache.has(renderer)) return envCache.get(renderer);
  const sc = new THREE.Scene();
  sc.add(new THREE.Mesh(new THREE.BoxGeometry(10, 6, 10), new THREE.MeshBasicMaterial({ color: 0x8c8f96, side: THREE.BackSide })));
  const panel = (w, h, pos, rot, lum) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(lum, lum, lum), side: THREE.DoubleSide })); m.position.set(...pos); m.rotation.set(...rot); sc.add(m); };
  panel(5, 3, [-3, 2.5, 3], [0, Math.PI / 4 + Math.PI / 2, 0], 7); // 左前大柔光箱
  panel(4, 2, [3.5, 2, -2], [0, -Math.PI / 3, 0], 4);              // 右后补光
  panel(6, 4, [0, 2.9, 0], [Math.PI / 2, 0, 0], 3);                // 顶灯
  const rt = new THREE.PMREMGenerator(renderer).fromScene(sc, 0.04).texture;
  envCache.set(renderer, rt); return rt;
}
const ROD_LOOK = {
  '银色铝': { metalness: 1, roughness: 0.32, brush: true },
  '黑色': { metalness: 0.7, roughness: 0.42, color: 0x1c1c1e },
  '白色': { metalness: 0.15, roughness: 0.3, clearcoat: 0.6 },
  '金色': { metalness: 1, roughness: 0.3, color: 0xd6aa52, brush: true },
};
function rodMaterial(finish) {
  const l = ROD_LOOK[finish] || ROD_LOOK['银色铝'];
  return new THREE.MeshPhysicalMaterial({ color: l.color ?? ROD_FINISHES[finish], metalness: l.metalness, roughness: l.roughness, clearcoat: l.clearcoat || 0, roughnessMap: l.brush ? brushTex() : null });
}
function boardMaterial(name, bm) {
  const base = { color: bm.color, transparent: bm.opacity < 1, opacity: bm.opacity };
  if (name === '实木') {
    const col = loadReal('wood_col.jpg', true), rough = loadReal('wood_rough.jpg', false);
    if (col) return new THREE.MeshStandardMaterial({ ...base, map: col, bumpMap: col, bumpScale: 1.2, roughness: 1, roughnessMap: rough });
    const t = woodTex(bm.color); return new THREE.MeshStandardMaterial({ ...base, color: 0xffffff, map: t, bumpMap: t, bumpScale: 1.2, roughness: 0.62 });
  }
  if (name === '金属板') return new THREE.MeshStandardMaterial({ ...base, color: 0xb8bec6, metalness: 0.7, roughness: 0.38, roughnessMap: brushTex(), bumpMap: brushTex(), bumpScale: 0.6 });
  if (name === '玻璃') return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
  return new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2 }); // 亚克力
}

// 按方案建整个鞋架（含可选参照鞋），返回 { group, sk }；group 原点 = 占地中心、地面
export function buildRack(s, { shoes = false } = {}) {
  const sk = buildSkeleton(s), { nodes } = analyzeSkeleton(sk), d = sk.d;
  const metal = rodMaterial(s.rodFinish);
  const dark = new THREE.MeshStandardMaterial({ color: s.rodFinish === '黑色' ? 0x111111 : 0x55585e, metalness: 0.7, roughness: 0.45 });
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
  const board = boardMaterial(s.shelfMaterial, bm);
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
    window.addEventListener('rack-tex', () => { if (this.cur) { this.setScheme(this.cur, true); this.render(); } });
    this.scene = new THREE.Scene();
    this.scene.environment = studioEnv(this.renderer); this.scene.environmentIntensity = 0.55; // 叠在照片上，反射收着点
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
    this.edits = { door: null, obs: {} }; // 用户拖过的门框、家具框（地面坐标），重新摆放时不被 AI 结果覆盖；换照片时 clearEdits()
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
    this.door = this.edits.door ? this.doorAt(this.edits.door.H.clone(), this.edits.door.L.clone(), this.edits.door.swing) : this.doorFrom(s.door);
    // 有墙脚点：鞋架背面贴墙，中心 = 墙脚点 + 正面方向 × (进深/2 + 1cm)，换方案时按新进深重算
    let wallP = s.base && this.floorAt(s.base);
    this.wallSide = this.roomFrom(s, wallP);
    for (const i in this.edits.obs) if (this.obstacles[i]) this.obstacles[i].poly = this.edits.obs[i].map(q => q.clone());
    if (this.wallSide !== s.wall) this.t.rot = (s.roomAz ?? 0) + { left: 90, back: 0, right: -90 }[this.wallSide];
    const side = this.walls.find(w => w.side === this.wallSide);
    if (side) wallP = side.p.clone().addScaledVector(side.t, wallP ? wallP.clone().sub(side.p).dot(side.t) : 0.7); // 投到这面墙推算出的墙脚线上（AI 墙脚点只用来定沿墙的位置）
    this.anchor = wallP ? { p: wallP, p0: wallP.clone(), front: new THREE.Vector3(Math.sin(R(this.t.rot)), 0, Math.cos(R(this.t.rot))) } : null;
    this.pick = null; this.spots3 = [];
    // 先按规则贴墙避让，再出 3 个候选：放到第一个，另外两个在地上画成脚印给用户点
    if (this.anchor) {
      this.fitAnchor(); this.spots3 = this.topSpots(3);
      // 分割图说 3 个候选都压家具/挡门：按窄一点的鞋架重找，找到就放那里并建议改宽（app 显示「改成 N cm 宽」按钮）
      let narrow = null;
      if (this.segMap && this.spots3.every(s => s.seg)) {
        const W0 = this.widthM;
        for (const W of [0.7, 0.6, 0.5].filter(w => w < W0 - 0.01)) { this.widthM = W; const S = this.topSpots(3); if (S[0] && !S[0].seg) { narrow = { S, W }; break; } }
        this.widthM = W0;
        if (narrow) this.spots3 = narrow.S;
      }
      const S0 = this.spots3[0], note = [this.fitNote, this.suggestW];
      if (narrow) { this.placeAt(S0); this.suggestW = Math.round(narrow.W * 100); this.fitNote = `门边放不下 ${Math.round(this.widthM * 100)}cm 宽，建议宽度 ≤ ${this.suggestW}cm`; return; }
      if (S0) { this.placeAt(S0); if (S0.bad) [this.fitNote, this.suggestW] = note; } // 都压门或家具：保留「放不下 / 建议宽度」的提示
      return;
    }
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
    return this.doorAt(H, L, d.swing, 1.0);
  }
  // 门洞底边两端 → 门；AI 给的门宽最多按 1m 算，用户拖出来的按实际
  doorAt(H, L, swing, maxW = 1.6) {
    const w = Math.max(0.3, H.distanceTo(L)), u = L.clone().sub(H).divideScalar(w), n = new THREE.Vector3(-u.z, 0, u.x);
    const mid = H.clone().add(L).multiplyScalar(0.5);
    if (n.dot(new THREE.Vector3(0, 0, 0).sub(mid)) < 0) n.negate(); // 法向指向相机一侧 = 屋内
    return { H, L, w: Math.min(w, maxW), u, n, swing };
  }
  clearEdits() { this.edits = { door: null, obs: {} }; }

  // ---------- 拖门框、家具框（AI 认错时用户自己改）----------
  // 地面点 → 舞台像素
  px(p) { const v = p.clone().project(this.camera); return [(v.x + 1) / 2 * this.stage.clientWidth, (1 - v.y) / 2 * this.stage.clientHeight]; }
  // 舞台像素 (x, y) 处按到了哪个框：门的两端 > 门槛线和开门弧 > 家具框的边 > 家具框里面；框线两侧各 22px 都算（点击区 44px）
  zoneAt(x, y, R = 22) {
    const d2 = ([ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(ax + t * dx - x, ay + t * dy - y); };
    const D = this.door;
    if (D) {
      for (const part of ['H', 'L']) { const [px, py] = this.px(D[part]); if (Math.hypot(px - x, py - y) < R) return { kind: 'door', part }; }
      const P = this.doorOutline().map(q => this.px(q));
      for (let i = 1; i < P.length; i++) if (d2(P[i - 1], P[i]) < R) return { kind: 'door', part: 'all' };
    }
    const obs = this.obstacles || [];
    for (let i = 0; i < obs.length; i++) { const P = obs[i].poly.map(q => this.px(q)); for (let j = 0; j < P.length; j++) if (d2(P[j], P[(j + 1) % P.length]) < R) return { kind: 'obs', i, edge: j }; }
    for (let i = 0; i < obs.length; i++) {
      const P = obs[i].poly.map(q => this.px(q)); let c = false;
      for (let a = 0, b = P.length - 1; a < P.length; b = a++) if ((P[a][1] > y) !== (P[b][1] > y) && x < (P[b][0] - P[a][0]) * (y - P[a][1]) / (P[b][1] - P[a][1]) + P[a][0]) c = !c;
      if (c) return { kind: 'obs', i, edge: -1 };
    }
    return null;
  }
  // 按住框后拖：d = 地面上的位移（相对按下时）
  moveZone(z, d) {
    if (z.kind === 'door') {
      const H = z.H0.clone().add(z.part === 'L' ? new THREE.Vector3() : d), L = z.L0.clone().add(z.part === 'H' ? new THREE.Vector3() : d);
      if (H.distanceTo(L) > 0.3) this.door = this.doorAt(H, L, this.door.swing);
    } else {
      const P0 = z.P0, o = this.obstacles[z.i];
      if (z.edge < 0) o.poly = P0.map(q => q.clone().add(d));
      else { // 拖一条边：这条边两端沿边的法向移动，其余点不动
        const a = z.edge, b = (a + 1) % P0.length, e = P0[b].clone().sub(P0[a]), nrm = new THREE.Vector3(-e.z, 0, e.x).normalize(), k = d.dot(nrm);
        o.poly = P0.map((q, i) => i === a || i === b ? q.clone().addScaledVector(nrm, k) : q.clone());
      }
    }
    this.updateDoorMark(); this.render();
  }
  // 松手：记成用户修改，重新避让摆放（用户自己拖过鞋架就只重画）
  endZone(z) {
    if (z.kind === 'door') this.edits.door = { H: this.door.H.clone(), L: this.door.L.clone(), swing: this.door.swing };
    else this.edits.obs[z.i] = this.obstacles[z.i].poly.map(q => q.clone());
    this.editing = null;
    if (this.anchor && !this.dragged) this.fitAnchor(); else this.applyTransform();
  }
  // 门在地面上画的线：开门弧 + 门槛（向外开只画门槛）
  doorOutline() {
    const D = this.door, pts = [];
    if (D.swing !== 'out') {
      const a0 = Math.atan2(D.u.z, D.u.x), dir = Math.sign(D.u.x * D.n.z - D.u.z * D.n.x) || 1;
      for (let i = 0; i <= 24; i++) { const a = a0 + dir * i / 24 * Math.PI / 2; pts.push(new THREE.Vector3(D.H.x + Math.cos(a) * D.w, 0, D.H.z + Math.sin(a) * D.w)); }
    }
    return [...pts, D.H.clone(), D.L.clone()];
  }
  // ---------- 墙和家具：都变成地面上的禁区 ----------
  // 墙 = 半平面 {p 墙脚线上一点, n 朝屋内, t 沿墙}；墙角点 + 房间朝向（几何检测的墙面方向）→ 后墙和侧墙墙脚线
  // 家具 = AI 给的最近落地边打到地面，往远离相机方向补上长度、靠墙的补到墙 → 凸包
  // 返回鞋架靠的墙：AI 的 wall 标签常和它给的点对不上（实测说「左墙」点却在后墙门前），按点离哪面已知墙近来定
  roomFrom(s, wallP) {
    const R = THREE.MathUtils.degToRad(s.roomAz ?? (s.yaw || 0)), F = new THREE.Vector3(Math.sin(R), 0, Math.cos(R)), T = new THREE.Vector3(Math.cos(R), 0, -Math.sin(R));
    this.walls = []; this.obstacles = [];
    const N = { back: F, left: T, right: T.clone().negate() }, TAN = { back: T, left: F.clone().negate(), right: F.clone().negate() };
    // 每面墙的墙脚线取最可靠的来源：门洞底边（门就开在墙上，AI 点门最准）> 墙角点 > AI 给的墙脚点（常点在家具前沿）
    const line = { left: null, right: null, back: null }, D = this.door, src = {};
    if (D) {
      const mid = D.H.clone().add(D.L).multiplyScalar(0.5);
      // 门槛按最接近的房间轴归墙（差 <35°）：AI 的门槛两点在 3m 外偏 1% 画面方向就差 10° 以上
      const ct = Math.abs(D.u.dot(T)), cf = Math.abs(D.u.dot(F)), k = Math.max(ct, cf) < 0.82 ? null : ct > cf ? 'back' : mid.dot(T) < 0 ? 'left' : 'right';
      if (k) { line[k] = mid; src[k] = 'door'; }
    }
    // AI 给的墙脚线两点：连线和房间朝向（几何检测）差 >30° 说明点错了（实测会把门槛标成侧墙），不用；
    // 墙的位置按离相机近的那点算（同样偏 1% 画面，远处在地面上差得多）。试过两点不一致时取更靠墙外的点：合成图上更差
    for (const k of ['back', 'left', 'right']) {
      const P = (s.wallLines?.[k] || []).map(q => this.floorAt(q)).filter(Boolean);
      if (src[k] === 'line' || P.length < 2) continue;
      if (Math.abs(P[1].clone().sub(P[0]).normalize().dot(TAN[k])) < Math.cos(THREE.MathUtils.degToRad(30))) continue;
      const q = P[0].length() < P[1].length() ? P[0] : P[1];
      // 门推出的墙和墙脚线差 0.4m 以上时取离相机远的那个：挡在墙前的只会是开着的门扇（d3 门扇底边被当门槛）或家具（d5 墙脚点落在柜子前沿），偏差总朝相机
      if (line[k] && src[k] === 'door' && q.clone().sub(line[k]).dot(N[k]) > -0.4) continue;
      line[k] = q; src[k] = 'line';
    }
    // 拍照的人站在屋里：每面墙都得在相机对面（相机在墙前 0.1m 以上）。AI 的假墙角点会推出跑到相机右边的「左墙」，整个房间左右颠倒
    const facing = (k, p) => p && -p.dot(N[k]) > 0.1;
    for (const k in line) if (line[k] && !facing(k, line[k])) { line[k] = null; delete src[k]; }
    const corners = {};
    for (const k of ['left', 'right']) {
      const c = s.corner?.[k] && this.floorAt(s.corner[k]); if (!facing(k, c)) continue;
      corners[k] = c;
      if (!line.back && facing('back', c)) { line.back = c; src.back = 'corner'; }
    }
    // AI 点属于哪面墙：已知墙里点在墙前 0~0.6m（或略在墙后 0.3m 内）且最近的那面；都不沾就信 AI 的标签
    let side = ['left', 'back', 'right'].includes(s.wall) ? s.wall : 'back';
    if (wallP) {
      const known = Object.entries({ ...line, ...Object.fromEntries(Object.entries(corners).map(([k, c]) => [k, line[k] || c])) }).filter(([, p]) => p);
      const near = known.map(([k, p]) => [k, wallP.clone().sub(p).dot(N[k])]).filter(([, d]) => d > -0.3 && d < 0.6).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0];
      if (near) side = near[0];
    }
    for (const k of ['left', 'right']) {
      const c = corners[k]; if (!c || line[k]) continue;
      // 侧墙：墙角点常被家具挡住点偏；和 AI 墙脚点（要求点在墙前地面上）比，取更靠屋内的——偏屋内只是离墙一点，偏外会嵌进墙
      line[k] = side === k && wallP && wallP.clone().sub(c).dot(N[k]) > 0 ? wallP.clone() : c; src[k] = 'corner';
    }
    if (wallP && !line[side] && facing(side, wallP)) { line[side] = wallP.clone(); src[side] = 'base'; }
    const P0 = (s.obstacles || []).map(o => o.pts.map(q => this.floorAt(q)).filter(Boolean));
    for (const k of ['back', 'left', 'right']) {
      if (!line[k]) continue;
      // 墙不能切进家具：家具最近落地边（AI 给得最准）必须在墙前，否则把墙往外推（门定的墙不动）
      if (src[k] !== 'door') {
        const inside = Math.min(0.05, ...P0.flat().map(q => q.clone().sub(line[k]).dot(N[k])));
        if (inside < 0.05) line[k] = line[k].clone().addScaledVector(N[k], inside - 0.05);
      }
      this.walls.push({ side: k, p: line[k], n: N[k].clone(), t: TAN[k].clone(), src: src[k] });
    }
    const axes = [F, T, F.clone().negate(), T.clone().negate()];
    (s.obstacles || []).forEach((o, i) => {
      const P = P0[i]; if (!P.length) return;
      // 太小的（落地边 <25cm 且进深 <25cm，多半是地上的鞋/包）不算障碍，随手就能挪走
      if (o.depth < 0.25 && (P.length < 2 || P[0].distanceTo(P[P.length - 1]) < 0.25)) return;
      // AI 给的是离相机最近的那条落地边（最准）→ 往远离相机方向（最接近的房间轴向）补上它说的长度；离墙 0.5m 以内再补到最近那面墙
      const away = P.reduce((a, q) => a.add(q), new THREE.Vector3()).setY(0).normalize();
      const d = axes.reduce((b, a) => a.dot(away) > b.dot(away) ? a : b).clone().multiplyScalar(o.depth);
      let pts = [...P, ...P.map(q => q.clone().add(d))];
      const near = this.walls.map(w => [w, Math.min(...P.map(q => q.clone().sub(w.p).dot(w.n)))]).filter(x => x[1] < 0.5).sort((x, y) => x[1] - y[1])[0]?.[0];
      if (near) pts = pts.concat(pts.map(q => q.clone().addScaledVector(near.n, -q.clone().sub(near.p).dot(near.n))));
      if (P.length === 1) pts.push(...[[1, 0], [0, 1], [1, 1]].map(([i, j]) => P[0].clone().addScaledVector(T, (i - 0.5) * 0.4).addScaledVector(d, j)));
      this.obstacles.push({ name: o.name, shoe: o.shoe, poly: hull(pts) });
    });
    return side;
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
    // 离相机远的那一端两角要在画面里；靠近相机的一端被画面边缘裁掉一点没关系（横拍的房产照，门边空地常就在底边；贴侧墙时裁在左右边），
    // 只要不超出画面 30%；正面中点要在画面内。四角全在画面里试过：和这类照片冲突，大半变成放不下
    // 鞋架中心离相机水平 ≥1.2m：更近就是贴着镜头、比例巨大（set2 里 10 张），那里通常也是拍照的人站的地方
    const cam = this.camera.position, inView = (q, m = 0.95) => { const v = q.clone().project(this.camera); return v.z < 1 && Math.abs(v.x) < m && v.y < 1 && v.y > -m - 0.05; };
    const geo = (p0, front) => { const tan = new THREE.Vector3(front.z, 0, -front.x); return { p0, front, tan, at: sh => p0.clone().addScaledVector(tan, sh).addScaledVector(front, off) }; };
    const fits = ({ tan, front, at }, sh, W = this.widthM) => {
      const q = at(sh); if (Math.hypot(q.x - cam.x, q.z - cam.z) < 1.2 || this.footprintBlocked(q.x, q.z, W)) return false;
      const C = [-1, 1].flatMap(i => [-1, 1].map(j => q.clone().addScaledVector(tan, i * W / 2).addScaledVector(front, j * off))).sort((a, b) => a.distanceTo(cam) - b.distanceTo(cam));
      return C.every((c, i) => inView(c, i < 2 ? 1.3 : 0.95)) && inView(q.clone().addScaledVector(front, off));
    };
    // 鞋架放在入户门边：认出门时按离门槛线的距离挑（换墙不加价），没有门才按沿 AI 墙脚点挪得最少挑（换墙记 0.4m）
    const D = this.door, toDoor = q => { const r = q.clone().sub(D.H), a = Math.max(0, Math.min(D.w, r.dot(D.u))); return q.distanceTo(D.H.clone().addScaledVector(D.u, a)); };
    // 用户点过候选或地面：只在那面墙上、离点的位置最近处找（改尺寸后重新避让也不跳走）
    const cost = (c, sh, W) => D && !this.pick ? toDoor(c.g.at(sh)) - W / 2 : Math.abs(sh) + (c.side ? 0.4 : 0);
    const search = (c, W = this.widthM) => {
      let top = null;
      for (let k = 0; k <= 300; k++) { const sh = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.02; if (fits(c.g, sh, W)) { const v = cost(c, sh, W); if (!top || v < top.cost) top = { c, sh, cost: v }; if (!D) break; } }
      return top;
    };
    this.fitNote = ''; this.suggestW = null;
    let g = geo(A.p0, A.front), best = 0;
    const cands = [{ g, rot: rot0, side: '' }];
    for (const w of this.walls || []) if (w.n.dot(A.front) < 0.9)
      cands.push({ g: geo(w.p.clone().addScaledVector(w.t, A.p0.clone().sub(w.p).dot(w.t)), w.n.clone()), rot: THREE.MathUtils.radToDeg(Math.atan2(w.n.x, w.n.z)), side: w.side });
    const use = (c, sh) => { this.t.rot = c.rot; g = c.g; best = sh; Object.assign(A, { p0: c.g.p0, front: c.g.front }); if (c.side) this.fitNote = `原来那面墙放不下，改靠${{ left: '左', right: '右', back: '正对' }[c.side]}墙`; };
    if (this.hasZones()) {
      let top = null;
      for (const c of this.pick ? cands.slice(0, 1) : cands) { this.t.rot = c.rot; const r = search(c); if (r && (!top || r.cost < top.cost)) top = r; }
      this.t.rot = rot0; best = null;
      if (top) { if (top.c === cands[0]) best = top.sh; else use(top.c, top.sh); }
    }
    if (best === null) {
      let top = null;
      for (const c of cands) { this.t.rot = c.rot; for (let W = this.widthM - 0.05; W >= 0.3 && !(top && W <= top.W); W -= 0.05) { const r = search(c, W); if (r) { top = { c, sh: r.sh, W }; break; } } }
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

  // 候选摆放位置：每面推算出的墙（含 AI 墙脚点所在的墙）每隔 step 米一个，只查墙后、画面和离相机距离，
  // 门和家具不查（由 topSpots 排序）；同一面墙上相邻候选至少隔 gap 米
  spots(step = 0.1, gap = 0.6) {
    const off = (this.depthM || 0.3) / 2 + 0.01, W = this.widthM, A = this.anchor, cam = this.camera.position; if (!A) return [];
    // 远端两角左右可出画面一点（门边空地常在画面边上，鞋架被边缘切掉一截也看得懂），上下不行；近端两角可出画面 30%
    const inView = (q, mx, my = mx) => { const v = q.clone().project(this.camera); return v.z < 1 && Math.abs(v.x) < mx && v.y < 1 && v.y > -my - 0.05; };
    const behind = p => (this.walls || []).some(w => p.clone().sub(w.p).dot(w.n) < -0.005);
    const lines = [{ p0: A.p0, front: A.front }];
    for (const w of this.walls || []) if (w.n.dot(A.front) < 0.9) lines.push({ p0: w.p.clone().addScaledVector(w.t, A.p0.clone().sub(w.p).dot(w.t)), front: w.n.clone() });
    const out = [];
    for (const { p0, front } of lines) {
      const tan = new THREE.Vector3(front.z, 0, -front.x), rot = THREE.MathUtils.radToDeg(Math.atan2(front.x, front.z)); let last = -Infinity;
      for (let sh = -4; sh <= 4; sh += step) {
        const q = p0.clone().addScaledVector(tan, sh).addScaledVector(front, off);
        if (Math.hypot(q.x - cam.x, q.z - cam.z) < 1.2 || sh - last < gap) continue;
        const C = [-1, 1].flatMap(i => [-1, 1].map(j => q.clone().addScaledVector(tan, i * W / 2).addScaledVector(front, j * off))).sort((a, b) => a.distanceTo(cam) - b.distanceTo(cam));
        if (C.some(behind) || !C.every((c, i) => i < 2 ? inView(c, 1.3) : inView(c, this.edgeX ?? 1.15, 0.95)) || !inView(q.clone().addScaledVector(front, off), 0.95)) continue;
        if (out.some(o => o.q.distanceTo(q) < gap * 0.8)) continue;
        out.push({ q, p0: p0.clone().addScaledVector(tan, sh), front: front.clone(), rot }); last = sh;
      }
    }
    return out;
  }
  // 地面点 → 照片坐标 [u, v]（0~1，和舞台裁切无关，floorAt 的反算）
  photoUV(p) {
    const R = THREE.MathUtils.degToRad, th = Math.tan(R(this.t.hfov) / 2), tv = th / (this.photoAspect || 0.75);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-R(this.t.pitch), 0, R(this.t.roll), 'YXZ')).invert();
    const d = p.clone().sub(new THREE.Vector3(0, this.t.camH, 0)).applyQuaternion(q);
    return d.z < -0.01 ? [(d.x / -d.z / th + 1) / 2, (1 - d.y / -d.z / tv) / 2] : null;
  }
  // 照片分割图（seg.py：0 其他 1 地面 2 墙 3 门 4 固定家具/楼梯 5 小东西）在地面点处的组号，出画面 -1
  segAt(p) {
    const M = this.segMap, uv = M && this.photoUV(p); if (!uv || uv[0] < 0 || uv[0] >= 1 || uv[1] < 0 || uv[1] >= 1) return -1;
    return M.data[Math.floor(uv[1] * M.h) * M.w + Math.floor(uv[0] * M.w)];
  }
  // 按分割图判断候选：脚印（内缩 5cm）下面要是地面，压到家具/门不行；背面往后 10cm 要是墙/门/家具（还是地面说明墙线推错、鞋架悬在屋中间）
  segBad(s) {
    if (!this.segMap) return false;
    const W = this.widthM, off = (this.depthM || 0.3) / 2, tan = new THREE.Vector3(s.front.z, 0, -s.front.x), cnt = [0, 0, 0, 0, 0, 0];
    let back = 0, backFloor = 0;
    for (let i = 0; i <= 6; i++) {
      const x = (i / 6 - 0.5) * (W - 0.1);
      for (let j = 0; j <= 2; j++) { const g = this.segAt(s.q.clone().addScaledVector(tan, x).addScaledVector(s.front, (j - 1) * (off - 0.05))); if (g >= 0) cnt[g]++; }
      const g = this.segAt(s.q.clone().addScaledVector(tan, x).addScaledVector(s.front, -off - 0.1)); if (g >= 0) { back++; if (g === 1) backFloor++; }
    }
    // 鞋架立体范围（正面、背面，离地 0.2/0.45/0.7m）：桌子、长凳底下能看到地面，只查脚印拦不住；这些点落在家具或门上就是压到家具、挡门。
    // 没有深度，视线穿过鞋架落到更远处的门上也会算进来（g10 贴侧墙被误判、建议改窄）；只查背面或再要求 AI 禁区同意都试过，更差
    let vol = 0, hit = 0;
    for (let i = 0; i <= 6; i++) for (const y of [0.2, 0.45, 0.7]) for (const j of [-1, 1]) {
      const g = this.segAt(s.q.clone().addScaledVector(tan, (i / 6 - 0.5) * (W - 0.1)).addScaledVector(s.front, j * (off - 0.03)).setY(y)); if (g >= 0) { vol++; if (g === 3 || g === 4) hit++; }
    }
    if (vol >= 10 && hit / vol > 0.2) return true;
    const n = cnt.reduce((a, b) => a + b, 0);
    return n < 6 || (cnt[3] + cnt[4]) / n > 0.15 || (cnt[1] + cnt[5]) / n < 0.6 || back >= 3 && backFloor / back > 0.5;
  }
  // 给用户点的 k 个候选：不压门和家具的排前面（AI 给的门、家具点常偏，压到的也留着补位），再按离门近（没门按离 AI 墙脚点近）排，互不重叠
  topSpots(k = 3) {
    const A = this.anchor; if (!A) return [];
    const D = this.door, rot0 = this.t.rot, W = this.widthM;
    const toDoor = q => { const r = q.clone().sub(D.H), a = Math.max(0, Math.min(D.w, r.dot(D.u))); return q.distanceTo(D.H.clone().addScaledVector(D.u, a)); };
    // 挡在门洞正前方的不给（脚印 15% 以上落在门洞前 0.9m 内；门点 AI 给得准，那是最不该放的地方）；只压到门扇扫过的范围或家具的排后面补位（这两样 AI 常给偏）
    const off0 = (this.depthM || 0.3) / 2;
    const front = s => { const tan = new THREE.Vector3(s.front.z, 0, -s.front.x); let k = 0;
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 2; j++) { const r = s.q.clone().addScaledVector(tan, (i / 6 - 0.5) * W).addScaledVector(s.front, (j - 1) * off0).sub(D.H), al = r.dot(D.u), into = r.dot(D.n); if (into > -0.05 && into < 0.9 && al > 0 && al < D.w) k++; }
      return k / 21 > 0.15; };
    const S = this.spots(0.1, 0.1).filter(s => !D || !front(s)).map(s => { this.t.rot = s.rot; return { ...s, seg: this.segBad(s), bad: this.footprintBlocked(s.q.x, s.q.z), cost: D ? toDoor(s.q) : s.p0.distanceTo(A.p0) }; });
    this.t.rot = rot0;
    S.sort((a, b) => a.seg - b.seg || a.bad - b.bad || a.cost - b.cost);
    // 照片里已有鞋架/鞋柜（AI 起的名字里带）：旧鞋架的位置排第一（换掉它）；鞋柜常是固定的，排第二让用户点。投到离它最近的墙上，没认出墙就沿 AI 墙脚线的方向
    const off = (this.depthM || 0.3) / 2 + 0.01;
    for (const o of this.obstacles || []) if (o.shoe || /鞋[架柜]/.test(o.name)) {
      const c = o.poly.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(o.poly.length);
      // 贴哪面墙：旧鞋架最长那条边和墙平行（只按远近会投到旁边的侧墙上）
      const P = o.poly, e = P.map((p, i) => P[(i + 1) % P.length].clone().sub(p)).reduce((a, b) => b.length() > a.length() ? b : a).normalize();
      const w = (this.walls || []).filter(w => { const d = c.clone().sub(w.p).dot(w.n); return d > -0.3 && d < 1.2 && Math.abs(w.t.dot(e)) > 0.8; }).sort((a, b) => Math.abs(b.t.dot(e)) - Math.abs(a.t.dot(e)))[0];
      // 没有对得上的墙（旧鞋架贴着一段没认出的墙）：就按它自己的朝向原地放，正面朝相机
      const front = w ? w.n.clone() : new THREE.Vector3(-e.z, 0, e.x), q = w ? c.clone().addScaledVector(front, off - c.clone().sub(w.p).dot(front)) : c.clone();
      if (!w && front.dot(c) > 0) front.negate();
      const p0 = q.clone().addScaledVector(front, -off);
      S.splice(/[架凳]/.test(o.name) ? 0 : Math.min(1, S.length), 0, { q, p0, front, rot: THREE.MathUtils.radToDeg(Math.atan2(front.x, front.z)), bad: false, cost: -1, replace: o.name });
    }
    const out = [];
    for (const s of S) if (out.length < k && out.every(o => o.q.distanceTo(s.q) > W * 0.9)) out.push(s);
    return out;
  }
  // 按候选摆放
  // anim：从当前位置飞过去（用户点候选、点地面时）
  placeAt(c, anim) {
    this.anchor = { p: c.p0.clone(), p0: c.p0.clone(), front: c.front.clone() };
    this.pick = c; this.dragged = false; this.fitNote = ''; this.suggestW = null;
    if (!anim) return this.set({ x: c.q.x, z: c.q.z, rot: c.rot });
    const a = { x: this.t.x, z: this.t.z, rot: this.t.rot }, dr = ((c.rot - a.rot) % 360 + 540) % 360 - 180, t0 = performance.now(), T = 280;
    const step = now => {
      const k = Math.min(1, (now - t0) / T), e = 1 - (1 - k) ** 3;
      this.set({ x: a.x + (c.q.x - a.x) * e, z: a.z + (c.q.z - a.z) * e, rot: a.rot + dr * e });
      if (k < 1 && this.pick === c) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => { if (this.pick === c && !this.dragged) this.set({ x: c.q.x, z: c.q.z, rot: c.rot }); }, T + 60); // 后台标签页 rAF 不跑，兜底落到终点
  }
  // 点地面上一点放鞋架：背面贴到身后最近的墙（点在墙前 1.5m 内），没有墙就原地放、正面朝相机
  spotAt(p) {
    const off = (this.depthM || 0.3) / 2 + 0.01;
    const w = (this.walls || []).map(w => [w, p.clone().sub(w.p).dot(w.n)]).filter(([, d]) => d > -0.1 && d < 1.5).sort((a, b) => a[1] - b[1])[0]?.[0];
    let front;
    if (w) front = w.n.clone(); else { front = p.clone().setY(0).negate().normalize(); if (this.anchor) front = this.anchor.front.clone(); }
    const q = w ? p.clone().addScaledVector(front, off - p.clone().sub(w.p).dot(front)) : p.clone().setY(0);
    return { q, p0: q.clone().addScaledVector(front, -off), front, rot: THREE.MathUtils.radToDeg(Math.atan2(front.x, front.z)) };
  }
  // 候选脚印（除当前那个）在地面上的四角
  ghosts() {
    const off = (this.depthM || 0.3) / 2, W = this.widthM;
    return (this.spots3 || []).filter(s => !(this.pick === s || Math.hypot(s.q.x - this.t.x, s.q.z - this.t.z) < 0.05)).map(s => {
      const tan = new THREE.Vector3(s.front.z, 0, -s.front.x);
      return { s, poly: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => s.q.clone().addScaledVector(tan, i * W / 2).addScaledVector(s.front, j * off)) };
    });
  }
  // 候选框画到照片上（评测看图用）：每个是鞋架外框（底面 + 四根立柱 + 顶面）的投影，框顶写编号；返回 canvas
  drawSpots(img, spots, w = 768) {
    const h = Math.round(w * img.naturalHeight / img.naturalWidth), cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    // 舞台和照片同比例时投影坐标直接对应照片
    const P = v => { const p = v.clone().project(this.camera); return [(p.x + 1) / 2 * w, (1 - p.y) / 2 * h]; };
    const H = this.size?.H || 0.8, off = (this.depthM || 0.3) / 2, W = this.widthM, COL = ['#ff2d55', '#00c7be', '#ffcc00', '#5856d6', '#ff9500', '#34c759', '#af52de', '#007aff', '#ff3b30', '#a2845e'];
    spots.forEach((s, k) => {
      const tan = new THREE.Vector3(s.front.z, 0, -s.front.x), c = (i, j, y) => P(s.q.clone().addScaledVector(tan, i * W / 2).addScaledVector(s.front, j * off).setY(y));
      const B = [c(-1, -1, 0), c(1, -1, 0), c(1, 1, 0), c(-1, 1, 0)], T = [c(-1, -1, H), c(1, -1, H), c(1, 1, H), c(-1, 1, H)];
      g.strokeStyle = COL[k % COL.length]; g.lineWidth = 3; g.fillStyle = COL[k % COL.length] + '55';
      g.beginPath(); B.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); T.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke();
      for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(...B[i]); g.lineTo(...T[i]); g.stroke(); }
      const [x, y] = c(0, 0, H); g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = '#000'; g.strokeText(k + 1, x, y - 6); g.fillStyle = '#fff'; g.fillText(k + 1, x, y - 6);
    });
    return cv;
  }

  updateDoorMark() {
    const m = this.doorMark; m.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); }); m.clear();
    // 有分割图时以它为准：AI 给的门、家具点常偏，分割说没压到就不报
    const R = THREE.MathUtils.degToRad(this.t.rot);
    this.conflict = this.footprintBlocked(this.t.x, this.t.z) && (!this.segMap || this.segBad({ q: new THREE.Vector3(this.t.x, 0, this.t.z), front: new THREE.Vector3(Math.sin(R), 0, Math.cos(R)) }));
    // 平时淡虚线（不抢眼），按住正在拖的那个框加深
    const col = this.conflict ? 0xff3b30 : 0xffffff, E = this.editing;
    const dashed = (P, on) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P.map(q => q.clone().setY(0.003))), new THREE.LineDashedMaterial({ color: col, dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: on ? 1 : 0.5 })); l.computeLineDistances(); m.add(l); };
    (this.obstacles || []).forEach((o, i) => dashed([...o.poly, o.poly[0]], E?.kind === 'obs' && E.i === i));
    if (this.door) dashed(this.doorOutline(), E?.kind === 'door');
    // 候选脚印：白色半透明实心块，和 AI 认出的门/家具（虚线）区分开
    for (const { poly } of this.ghosts()) {
      const sh = new THREE.Shape(poly.map(q => new THREE.Vector2(q.x, -q.z))), g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2); g.translate(0, 0.004, 0);
      m.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false })));
      m.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(poly.map(q => q.clone().setY(0.005))), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })));
    }
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
    let last = null, pinch = null, hold = null, zone = null, down = null;
    const pinchState = () => { const [a, b] = [...pts.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) }; };
    // 按在门框/家具框上、8px 内不动 350ms 才进入拖框（快速拖仍是拖鞋架，不误触）
    el.addEventListener('pointerdown', e => {
      try { el.setPointerCapture(e.pointerId); } catch {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      clearTimeout(hold); hold = null;
      if (pts.size === 1) {
        last = floorHit(e); down = { x: e.clientX, y: e.clientY, t: performance.now(), p: last?.clone() };
        const r = el.getBoundingClientRect(), z = this.zoneAt(e.clientX - r.left, e.clientY - r.top);
        if (z && last) hold = setTimeout(() => {
          hold = null; zone = { ...z, start: last.clone() };
          if (z.kind === 'door') Object.assign(zone, { H0: this.door.H.clone(), L0: this.door.L.clone() }); else zone.P0 = this.obstacles[z.i].poly.map(q => q.clone());
          this.editing = z; this.updateDoorMark(); this.render();
        }, 350);
      } else if (pts.size === 2) { zone = null; this.editing = null; pinch = { ...pinchState(), scale: this.t.scale, rot: this.t.rot }; }
    });
    el.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (hold) { if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) return; clearTimeout(hold); hold = null; }
      if (zone) { const p = floorHit(e); if (p) this.moveZone(zone, p.sub(zone.start).setY(0)); return; }
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
    // 轻点（没拖动、350ms 内松手）：点在候选脚印上 → 飞过去；点在空地上 → 贴最近的墙放过去；点在鞋架上不动
    const tap = e => {
      const p = down?.p; if (!p || pts.size || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 350) return;
      const r = el.getBoundingClientRect(); v.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(v, this.camera);
      if (ray.intersectObject(this.rack, true).length) return;
      const g = this.ghosts().find(({ poly }) => inPoly(p, poly, 0.1));
      this.placeAt(g ? g.s : this.spotAt(p), true);
    };
    const up = e => { pts.delete(e.pointerId); pinch = null; last = null; const wasHold = !!zone; clearTimeout(hold); hold = null; if (zone) { this.endZone(zone); zone = null; } if (!wasHold && e.type === 'pointerup') tap(e); down = null; };
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
    window.addEventListener('rack-tex', () => { if (this.cur) this.setScheme(this.cur); });
    this.scene = new THREE.Scene();
    this.scene.environment = studioEnv(this.renderer); this.scene.environmentIntensity = 0.4;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 30);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b0b8, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(-1.5, 3, 2.5); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5 }); key.shadow.radius = 4;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(2, 1.5, -1); this.scene.add(fill);
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
  reset() { this.tilt = 0.32; this.zoom = 0.78; this.vel = 0.0022; this.spin.rotation.y = 0.5; this.frame(); }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); // false：不改画布 CSS 尺寸（CSS 已铺满），否则 ResizeObserver 会循环
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.frame(); this.render();
  }
  setScheme(s) {
    this.cur = s;
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
    let last = performance.now();
    const tick = () => {
      if (!this.running) return;
      const now = performance.now(), k = Math.min(3, (now - last) / 16.7); last = now; // 按时间走，高刷屏不会转得更快
      if (!this.hold) { this.vel += ((Math.sign(this.vel) || 1) * 0.0022 - this.vel) * 0.02 * k; this.spin.rotation.y += this.vel * k; } // 惯性慢慢回到匀速自转
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
