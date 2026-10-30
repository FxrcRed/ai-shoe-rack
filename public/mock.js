// mock.js — 模拟模式（无密钥 / 无后端 / AI 失败时用）：关键词规则出方案和改方案。server 与纯前端共用
import { normalizeScheme, evenShelves, ROD_DIAMETERS } from './rack.js';

const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function guessPairs(text = '') {
  const nums = [...text.matchAll(/(\d+)\s*双|([一两二三四五六七八九十]+)\s*双/g)]
    .map(m => m[1] ? +m[1] : Math.max(...[...m[2]].map(c => CN[c] || 0)));
  return nums.length ? Math.max(...nums) : 6;
}
const STYLE = {
  '木地板暖色': { mat: '实木', fin: '黑色' },
  '现代简约': { mat: '玻璃', fin: '银色铝' },
  '工业风': { mat: '金属板', fin: '黑色' },
  '奶油风': { mat: '实木', fin: '白色' },
  '日式原木': { mat: '竹', fin: '金色' },
};

export function mockGenerate(req) {
  const cons = { maxWidth: req.maxWidth, maxDepth: req.maxDepth, maxHeight: req.maxHeight };
  const st = STYLE[req.style] || STYLE['木地板暖色'];
  const text = req.description || '';
  const pairs = guessPairs(text), umb = /伞/.test(text), hooks = /钥匙|挂包|背包|包包|挂钩|钩子|帽子|挂衣|外套|围巾/.test(text) ? 3 : 0; // 只在用户提到要挂东西时加（"挂雨伞"不算）
  const W = Math.min(+req.maxWidth || 100, 100), D = Math.min(+req.maxDepth || 32, 32);
  const per = w => Math.max(1, Math.floor(w / 25));
  const a = { w: Math.min(W, 80) }; a.n = Math.min(5, Math.max(3,Math.ceil(pairs / per(a.w))));
  const b = { w: Math.min(W, 60) }; b.n = Math.min(6, Math.max(3, Math.ceil(pairs / per(b.w)) + 1));
  const raw = [
    { name: '紧凑两用', intro: `宽 ${a.w}cm 放 ${a.n} 层，约 ${a.n * per(a.w)} 双鞋${umb ? '，侧挂雨伞' : ''}，顶面放钥匙`, width: a.w, depth: D,
      height: 5 + (a.n - 1) * 18, shelves: evenShelves(a.n, 5 + (a.n - 1) * 18), hooks, umbrella: umb, shelfMaterial: st.mat, rodDiameter: 12, rodFinish: st.fin },
    { name: '高窄多层', intro: `占地窄，${b.n} 层竖向收纳，适合门后窄墙`, width: b.w, depth: Math.min(D, 30),
      height: 5 + (b.n - 1) * 17, shelves: evenShelves(b.n, 5 + (b.n - 1) * 17), hooks, umbrella: false, shelfMaterial: st.mat, rodDiameter: 12, rodFinish: st.fin },
    { name: '换鞋凳款', intro: '两层鞋 + 可坐的实木顶面，换鞋时能坐，杆径加粗承重', width: W, depth: D,
      height: 45, shelves: [5, 25, 45], hooks: 0, umbrella: umb, shelfMaterial: '实木', rodDiameter: 16, rodFinish: st.fin },
  ];
  return [normalizeScheme(raw[(req.variant || 0) % raw.length], cons)]; // 一次只出 1 个，「换一个」按 variant 轮换
}

export function mockRevise(req) {
  const s = { ...req.scheme }, f = req.feedback || '', notes = [];
  const n = /(\d+)/.exec(f), step = n ? +n[1] : 10;
  const not = /不要|去掉|取消|拿掉/.test(f);
  if (/窄/.test(f)) { s.width -= step; notes.push('变窄'); } else if (/宽/.test(f)) { s.width += step; notes.push('变宽'); }
  if (/浅/.test(f)) { s.depth -= 5; notes.push('变浅'); } else if (/进深|深一/.test(f)) { s.depth += 5; notes.push('加深'); }
  if (/(加|多)一?层/.test(f)) { s.shelves = evenShelves(s.shelves.length + 1, s.height + 17); s.height += 17; notes.push('加一层'); }
  else if (/(减|少)一?层/.test(f) && s.shelves.length > 1) { s.height = s.shelves[s.shelves.length - 2]; s.shelves = s.shelves.slice(0, -1); notes.push('减一层'); }
  else if (/矮|低/.test(f)) { const k = (s.height - step) / s.height; s.height -= step; s.shelves = s.shelves.map(h => h * k); notes.push('变矮'); }
  else if (/高/.test(f)) { const k = (s.height + step) / s.height; s.height += step; s.shelves = s.shelves.map(h => h * k); notes.push('变高'); }
  for (const m of ['玻璃', '实木', '竹', '金属板', '亚克力']) if (f.includes(m) || (m === '金属板' && /金属|铁板|钢板/.test(f))) { s.shelfMaterial = m; notes.push('换' + m); break; }
  for (const [k, v] of [['黑', '黑色'], ['白', '白色'], ['金', '金色'], ['银', '银色铝']]) if (new RegExp(k + '色?(杆|架|的)').test(f)) { s.rodFinish = v; notes.push('杆改' + v); }
  if (/伞/.test(f)) { s.umbrella = !not; notes.push(not ? '去掉挂伞杆' : '加挂伞杆'); }
  if (/挂钩|钩子/.test(f)) { s.hooks = not ? 0 : s.hooks + 2; notes.push(not ? '去掉挂钩' : '加挂钩'); }
  const i = ROD_DIAMETERS.indexOf(s.rodDiameter);
  if (/粗|结实|承重/.test(f)) { s.rodDiameter = ROD_DIAMETERS[Math.min(5, i + 1)]; notes.push('杆加粗'); }
  else if (/细/.test(f)) { s.rodDiameter = ROD_DIAMETERS[Math.max(0, i - 1)]; notes.push('杆变细'); }
  s.intro = notes.length ? `（模拟）已按意见：${notes.join('、')}` : '（模拟模式只认关键词：窄/宽/高/矮/加一层/玻璃/黑色杆/伞/挂钩/粗/细）';
  return normalizeScheme(s, { maxWidth: req.maxWidth, maxDepth: req.maxDepth, maxHeight: req.maxHeight });
}
