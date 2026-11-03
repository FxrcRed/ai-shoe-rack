// shoes.js — 隔板上摆的参照鞋（真实尺寸，方便估计鞋架大小）：布局纯计算，前端渲染和"能放几双"共用
import { BOARD_MATERIALS } from './rack.js';

// 成人鞋外形尺寸（mm）：男 42 码运动鞋、女 37 码平底鞋
export const SHOES = {
  male: { L: 290, W: 110, H: 105, label: '男鞋 42 码' },
  female: { L: 250, W: 92, H: 80, label: '女鞋 37 码' },
};
// 默认进深 cm：刚好放下男鞋，鞋长向上取 5 的倍数（normalizeScheme 只收 5 的倍数）；空间大或鞋多才加深
export const SNUG_DEPTH = Math.ceil(SHOES.male.L / 50) * 5;
const IN = 12, GAP = 20, EDGE = 15; // 一双内两只间距、双与双之间、离立柱
// 显示用的款式（shoe-models.js）：男鞋位、女鞋位各自轮换，只影响外观，不影响"能放几双"。H = 款式高 mm
const MODELS = {
  male: [['m_sneaker', 105], ['m_oxford', 95], ['m_sneaker', 105], ['m_boot', 170], ['slipper', 70], ['sandal', 60]],
  female: [['w_loafer', 72], ['w_pump', 120], ['k_sneaker', 72], ['w_boot', 155]],
};

// 返回 { shoes: [{ kind, model, x, y, z(鞋跟), side }], male, female }，坐标同 buildSkeleton（mm，x 0..W，z 0..D 后→前）
export function shoeLayout(s) {
  const W = s.width * 10, H = s.height * 10, d = s.rodDiameter, t = BOARD_MATERIALS[s.shelfMaterial].thickness;
  const out = [], cnt = { male: 0, female: 0 }, turn = { male: 0, female: 0 };
  s.shelves.forEach((h, i) => {
    const y0 = h * 10 + d / 2 + t;
    const next = s.shelves[i + 1], top = next !== undefined ? next * 10 : h * 10 < H - 1 ? H : Infinity;
    const clear = top - d / 2 - y0;
    const row = [];
    let used = 0;
    for (let k = 0; ; k++) {
      let kind = (k + i) % 2 ? 'female' : 'male';
      if (clear < SHOES[kind].H + 10) kind = 'female';
      if (clear < SHOES[kind].H + 10) break;
      const pw = SHOES[kind].W * 2 + IN;
      if (used + (row.length ? GAP : 0) + pw > W - EDGE * 2) break;
      used += (row.length ? GAP : 0) + pw; row.push(kind);
    }
    let x = (W - used) / 2;
    row.forEach(kind => {
      const w = SHOES[kind].W, fit = MODELS[kind].filter(([, h]) => h + 10 <= clear);
      const model = fit.length ? fit[turn[kind]++ % fit.length][0] : MODELS[kind][0][0];
      out.push({ kind, model, x: x + w / 2, y: y0, z: 10, side: 'L' }, { kind, model, x: x + w * 1.5 + IN, y: y0, z: 10, side: 'R' });
      x += w * 2 + IN + GAP; cnt[kind]++;
    });
  });
  return { shoes: out, ...cnt };
}
