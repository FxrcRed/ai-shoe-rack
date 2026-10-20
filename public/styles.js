// styles.js — ② 装修风格的示意图（内联 SVG，自己画的，不依赖外部图片）
// 每种风格：墙/地面配色 + 该风格默认的杆色和隔板（与 mock.js 的 STYLE 一致）+ 一件代表性摆设
export const STYLE_INFO = {
  '木地板暖色': { desc: '暖色木地板，黑杆配实木板，温馨耐看', wall: '#efe2cf', floor: '#a86f3e', floorLine: '#8d5a30', rod: '#2b2b2b', board: '#b07a4a', boardOp: 1, deco: 'lamp' },
  '现代简约': { desc: '白墙浅砖，银色杆配玻璃板，干净通透', wall: '#f3f3f1', floor: '#d6d7d4', floorLine: '#c2c3bf', rod: '#b9bcc1', board: '#a8d8dc', boardOp: 0.55, deco: 'frame' },
  '工业风': { desc: '水泥灰墙，黑杆配金属板，硬朗耐脏', wall: '#8f8a84', floor: '#55514c', floorLine: '#46423d', rod: '#1e1e1e', board: '#5d6168', boardOp: 1, deco: 'brick' },
  '奶油风': { desc: '奶白暖调，白杆配浅木板，柔和圆润', wall: '#f7ece0', floor: '#e6d3bc', floorLine: '#d8c2a7', rod: '#fafafa', board: '#dcb98e', boardOp: 1, deco: 'arch' },
  '日式原木': { desc: '原木与竹，金色杆配竹板，自然清爽', wall: '#ece4d4', floor: '#c9a876', floorLine: '#b39260', rod: '#c8a25a', board: '#d9b46a', boardOp: 1, deco: 'plant' },
};

const SHOES = ['#c0392b', '#2c3e50', '#e0e0e0', '#7f5539', '#3d6b8c', '#d4a373'];

export function styleArt(name) {
  const s = STYLE_INFO[name];
  const deco = {
    lamp: `<line x1="100" y1="0" x2="100" y2="14" stroke="#333"/><path d="M92 22 L108 22 L104 14 L96 14 Z" fill="#2b2b2b"/><ellipse cx="100" cy="26" rx="12" ry="5" fill="#ffd27a" opacity=".45"/>`,
    frame: `<rect x="88" y="10" width="22" height="16" fill="#fff" stroke="#999" stroke-width="1"/><path d="M90 24 L97 16 L102 21 L105 18 L108 24 Z" fill="#c9d6df"/>`,
    brick: [0, 1, 2, 3].map(r => `<line x1="0" y1="${12 + r * 10}" x2="120" y2="${12 + r * 10}" stroke="#7a756f" stroke-width=".6"/>`).join('')
      + [0, 1, 2, 3].flatMap(r => [0, 1, 2, 3, 4, 5].map(c => `<line x1="${c * 22 + (r % 2) * 11}" y1="${2 + r * 10}" x2="${c * 22 + (r % 2) * 11}" y2="${12 + r * 10}" stroke="#7a756f" stroke-width=".6"/>`)).join(''),
    arch: `<path d="M90 50 L90 20 A10 10 0 0 1 110 20 L110 50 Z" fill="#fffaf3" stroke="#d9c4a8" stroke-width="1.5"/>`,
    plant: `<rect x="99" y="58" width="12" height="12" rx="2" fill="#b38b5d"/><path d="M105 58 C98 46 96 40 100 34 M105 58 C106 44 110 38 114 36 M105 58 C104 48 106 42 105 30" stroke="#5c8a3a" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
  }[s.deco];
  // 正视示意：两根前立柱 + 顶框 + 3 层隔板，隔板上放几双鞋
  const shelves = [64, 49, 34], x0 = 22, x1 = 78;
  let shoes = '', k = 0;
  for (const y of shelves) for (let x = x0 + 4; x < x1 - 10; x += 13) shoes += `<rect x="${x}" y="${y - 6}" width="10" height="6" rx="3" fill="${SHOES[k++ % SHOES.length]}"/>`;
  return `<svg viewBox="0 0 120 80" aria-hidden="true">
    <rect width="120" height="56" fill="${s.wall}"/>${s.deco === 'brick' ? deco : ''}
    <rect y="56" width="120" height="24" fill="${s.floor}"/>
    ${[62, 69, 76].map(y => `<line x1="0" y1="${y}" x2="120" y2="${y}" stroke="${s.floorLine}" stroke-width=".7"/>`).join('')}
    ${s.deco !== 'brick' ? deco : ''}
    <ellipse cx="50" cy="73" rx="34" ry="3" fill="#000" opacity=".15"/>
    ${shoes}
    ${shelves.map(y => `<rect x="${x0 - 2}" y="${y}" width="${x1 - x0 + 4}" height="2.5" fill="${s.board}" opacity="${s.boardOp}" stroke="${s.rod}" stroke-width=".4"/>`).join('')}
    <line x1="${x0}" y1="20" x2="${x1}" y2="20" stroke="${s.rod}" stroke-width="2"/>
    ${[x0, x1].map(x => `<line x1="${x}" y1="20" x2="${x}" y2="71" stroke="${s.rod}" stroke-width="2.4"/><rect x="${x - 2.5}" y="70" width="5" height="2.5" fill="#444"/>`).join('')}
  </svg>`;
}
