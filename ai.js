// ai.js — 提示词、Semantix 调用、模拟模式（无密钥/调用失败时用）
export { mockGenerate, mockRevise } from './public/mock.js';

const FIELDS = `每个方案的字段（单位：尺寸 cm，杆径 mm）：
- name: 方案名，≤8 个字
- intro: 一句话介绍，≤40 字，说明适合什么、为什么这样设计
- width: 总宽 cm，不得超过可用宽度；umbrella 为 true 时还要再给侧面挂伞杆留 14cm
- depth: 进深 cm，不超过可用深度（放鞋一般 28~35）
- height: 总高 cm，不超过可用高度
- shelves: 每层隔板离地高度 cm 的数组，从低到高，如 [5, 22, 39]；相邻间距 ≥14（运动鞋约 16~18，高帮/靴子 25+）；最高一层可等于 height（顶面可放钥匙）
- hooks: 顶部前横杆上的挂钩个数 0~10（挂钥匙、包）；用户没提到要挂钥匙/包/帽子/衣物就必须填 0（挂雨伞用 umbrella，不算挂钩）
- umbrella: 是否在侧面加挂伞杆 true/false（伞尖立在地上的接水盘里，伞杆在顶下 5cm 挡住伞身，所以 height 需 ≥55）
- shelfMaterial: 只能是 实木/玻璃/金属板/亚克力 之一
- rodDiameter: 光轴杆径 mm，只能是 6/8/10/12/16/20 之一（常用 12~16，坐人的换鞋凳用 16~20）
- rodFinish: 杆件颜色，只能是 银色铝/黑色 之一
估算容量：每层每 25cm 宽放 1 双鞋。`;

const SYSTEM = `你是"光轴鞋架"参数设计助手。光轴鞋架由圆杆（光轴）+ 连接件 + 隔板组成，零件表由程序计算，你只负责把用户需求翻译成结构参数。
只输出一个 JSON 对象，不要解释，不要 markdown 代码块。
${FIELDS}`;

export function buildGenerateMessages(req) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `用户需求：${req.description || '（未描述）'}
可用宽度：${req.maxWidth || '不限'} cm；可用深度：${req.maxDepth || '不限'} cm；可用高度：${req.maxHeight || '不限'} cm
${req.avoid?.length ? `不要和这些已给过的方案雷同（换一个思路：不同的层数/宽度/布局）：${req.avoid.join('、')}
` : ''}只给 1 个最合适的方案，输出 {"schemes":[{...}]}` },
  ];
}

export function buildReviseMessages(req) {
  return [
    { role: 'system', content: SYSTEM + '\n现在是修改轮：根据修改意见调整当前方案，只改相关字段，其余保持不变，intro 写明改了什么。输出 {"scheme":{...}}' },
    { role: 'user', content: `当前方案：${JSON.stringify(req.scheme)}
可用宽度：${req.maxWidth || '不限'} cm；可用深度：${req.maxDepth || '不限'} cm；可用高度：${req.maxHeight || '不限'} cm
原始需求：${req.description || ''}
修改意见：${req.feedback}` },
  ];
}

// 识图：估计拍照相机姿态 + 鞋架该放哪。坐标都是相对照片的 0~1（左上角为 0,0）
// 透视（地平线、倾斜、墙的方向）由 public/vp.js 几何检测，AI 只管语义：放哪、相机多高、靠哪面墙
const SCENE = `你是室内摆放助手。看用户拍的同一个角落（玄关/门口）的 1~3 张照片（编号 0、1、2，角度略有不同），挑出最适合展示的一张，在那张上选出放鞋架的位置，并估计拍摄高度。
照片上叠了洋红色坐标网格（每格 0.1，左上角为 0,0，刻度标在上边和左边），读坐标时以网格为准。
只输出一个 JSON 对象，不要解释，不要 markdown 代码块：
- best: 最适合展示摆放效果的照片编号（墙脚线清楚、地面拍得多、不模糊不过暗）。下面的 cameraHeight / lens / wall / wallBase / doorTop / doorBottom / door 都针对这一张
- issues: 字符串数组，每张照片一项：照片有问题时写一句给用户的重拍建议（≤20 字，如「地面拍得太少，手机再往下倾一点」「太暗」「太模糊」「看不到墙脚」），没问题写 ""
- cameraHeight: 相机离地高度（米）。站着手持一般 1.2~1.6，蹲着 0.5~0.9。多张照片可对照着判断。参考门（约 2.0~2.1m 高）、开关（约 1.3m）、地砖（常见 60 或 80cm）等的透视大小
- doorTop / doorBottom: 照片里一扇门（入户门、房门，取最清楚、最完整的那扇）同一条竖直门边上的两个点 [x, y]：doorTop = 门扇顶边（门洞上沿，不含门头装饰）与门边的交点，doorBottom = 这条门边落到地面的点（门扇底边/地面交界）。两点都要在画面内清楚看得见；看不到完整的门（顶或底被裁掉、被挡住）就都写 null。程序会用标准门高 2.05m 按透视算相机高度，点要尽量准
- door: 画面里离放鞋架的地方最近的那扇门（入户门/房门/柜门以外的门），{"hinge": [x, y], "latch": [x, y], "swing": "in" 或 "out"}。hinge = 门铰链（合页）那一侧门框落到地面的点，latch = 门锁/把手那一侧门框落到地面的点——两点就是门洞底边（门槛）的两端，都在地面上。看合页、把手位置判断哪边是铰链；门开着时铰链在门扇连着门框的那一边。swing：门朝拍照这一侧（屋内）开 = in，朝门外开 = out，看不出就 in。程序会按门宽算出门扇扫过的扇形，鞋架会自动避开。没有门或门底看不到写 null
- corner: {"left": [x, y] 或 null, "right": [x, y] 或 null}：地面上的墙角点——正对相机的墙（后墙）的墙脚线与左侧墙 / 右侧墙的墙脚线相交处（三面交汇的那个角落落在地面上的点）。被家具挡住时按两条墙脚线的延长线推出交点；看不到侧墙或角落不在画面内写 null。程序用它和透视算出侧墙墙脚线，点要尽量准
- obstacles: 数组，只列地面上固定/笨重、不会随手挪走的家具和建筑构件（柜子、鞋柜、桌子、长凳、柱子、暖气、大花盆、墙角凸出的墙垛等）。**不要列**随手能拿走的小物件：鞋子、拖鞋、靴子、包、伞、纸箱、快递、地垫、玩具、垃圾桶、小凳以外的零碎东西——它们会被收走，鞋架正是用来放鞋的，地上的鞋不算障碍。也不含门。每个 {"name": "鞋柜", "pts": [[x, y], [x, y]], "depth": 米}。pts = 它离相机最近的那条落地边的两端：物体贴着地板、在照片里最靠下的两个落地点——柜子取正面底边（踢脚）贴地的左右两端，桌子/凳子/椅子取靠近相机的两条腿的最下端。一定是贴着地板的点，绝不是台面、凳面、柜顶的角；depth = 从这条边往远离相机方向物体还有多长（米，例如鞋柜约 0.35，长凳 0.4~1.2）。没有写 []
- lens: 镜头类型 ultrawide / main / tele 之一（明显桶形畸变、视野很广 = ultrawide）
- wall: 鞋架背靠哪面墙：left（左侧墙）/ back（正对相机的墙）/ right（右侧墙）。只能选照片里墙脚线清楚可见、旁边地面空地也在画面内（能完整看到鞋架）的墙。鞋架要考虑人的活动：不能放在门扇开关时扫过的扇形地面上（门铰链一侧为圆心、门宽约 0.8~0.9m 为半径），不能挡门洞正前方，要给进门、换鞋留出至少约 0.8m 的过道
- wallBase: [x, y] 鞋架背面中点贴墙的位置——取这面墙的墙脚线（墙面与地面的交界线、踢脚线最底边）前方紧贴的地面上一点（离墙脚约 5cm 的地面）：点必须落在地面区域内，宁可略偏向地面也不要偏到墙上——点在墙面、门、柜子上会让鞋架嵌进墙里。鞋架宽约 0.6~1m，这个点两侧各 0.5m 的墙脚都要是空地，且远离门的开启范围，不能和 obstacles 里的家具重叠；x 在 0.15~0.85 之间，不要贴画面边缘。靠侧墙时也要给出（程序会把它投到侧墙墙脚线上）
- light: 主光源方向，用来给鞋架画一致的影子：{"dir": 方向, "hard": 布尔}。dir 是光从哪边照过来（相对拍照的人）：front（从相机身后照向墙）/ back（从画面深处照向相机，如对面窗户）/ left / right / front-left / front-right / back-left / back-right / top（头顶吸顶灯、看不出方向）。先看照片里已有物体（鞋、柜子、门框、人）落在地面/墙上的影子：影子朝向的反方向就是光源；没影子再看窗户和灯的位置。hard = 影子边缘清楚（阳光、射灯），false = 影子模糊或几乎没有（阴天、散射光）
- note: 一句话说明放在哪、为什么，≤25 字
- rec: 看照片里地面、墙面、家具的颜色和风格，推荐一套能生产的搭配，{"style": 房间风格≤8字（如「浅色木地板」「白墙现代」）, "shelfMaterial": 只能是 实木/玻璃/金属板/亚克力 之一, "rodFinish": 只能是 银色铝/黑色 之一}`;

// 摆放复查：把虚拟鞋架合成到照片上，让 AI 看效果判断是否落地、挡门、挡过道，不行就给新的墙脚点
const CHECK = `你是室内摆放审核员。图 A 是用户拍的玄关/门口原照片，图 B 是程序把一个虚拟光轴鞋架（金属杆 + 隔板，地上带阴影）按计算的位置合成上去的效果。两张图坐标一致，都叠了洋红色 0.1 坐标网格（左上角 0,0）。
判断这个摆放是否合理，只输出一个 JSON 对象，不要解释，不要 markdown：
- onFloor: 布尔。逐个看鞋架的 4 个底座（杆子最下端的小圆柱）：是否都落在地面区域内，背面底部是否在墙脚线前方。只要有底座落在墙脚线以上的墙面区域、门上、柜子上，或者鞋架看起来比周围同距离的物体小很多（说明被放到了墙后面），就是 false
- clearOfDoor: 布尔。是否避开了门扇开关时扫过的扇形地面（铰链一侧为圆心、门宽约 0.8~0.9m 为半径）和门洞正前方
- clearOfPath: 布尔。是否给进门、换鞋留出了至少约 0.8m 宽的过道，没堵住走动路线
- clearOfFurniture: 布尔。鞋架是否和柜子、桌子、凳子、墙等不能移动的物体重叠或穿插（鞋架任何部分插进家具里、穿进墙里都是 false）
- ok: 以上四项都为 true 时为 true
- problem: ok 为 false 时用一句话说明问题（≤25 字），否则 ""
- wall: ok 为 false 时新的靠墙面 left / back / right（相对拍照的人），否则 null
- wallBase: ok 为 false 时新的鞋架背面中点位置 [x, y]：图 A 里该墙墙脚线（墙面与地面交界、踢脚线最底边）前方紧贴的地面上一点（离墙脚约 5cm），必须在地面区域内，宁可偏地面也不要偏到墙上；两侧各 0.5m 墙脚是空地、不碰家具、远离门的开启范围和过道；x 在 0.15~0.85。照片里实在没有合适位置就写 null`;

export function buildCheckMessages(req) {
  return [{ role: 'system', content: CHECK }, { role: 'user', content: [
    { type: 'text', text: `图 A（原照片）。现在鞋架靠 ${req.wall || '未知'} 墙。${req.need ? '用户需求：' + req.need : ''}` },
    { type: 'image_url', image_url: { url: req.photo } },
    { type: 'text', text: '图 B（合成效果）：' },
    { type: 'image_url', image_url: { url: req.image } },
  ] }];
}

// req.photos = [{ image, aspect, horizonY }]（旧格式 req.image 也认）
export function buildSceneMessages(req) {
  const photos = (req.photos || [{ image: req.image, aspect: req.aspect, horizonY: req.horizonY }]).slice(0, 3);
  const content = [{ type: 'text', text: `共 ${photos.length} 张照片。${req.need ? '用户需求：' + req.need : ''}` }];
  photos.forEach((p, i) => {
    content.push({ type: 'text', text: `照片 ${i}：宽高比 ${p.aspect ? (+p.aspect).toFixed(3) : '未知'}（宽/高）。${Number.isFinite(p.horizonY) ? `程序测得地平线在纵坐标 ${(+p.horizonY).toFixed(2)}。` : '程序没测出透视线条。'}` });
    content.push({ type: 'image_url', image_url: { url: p.image } });
  });
  return [{ role: 'system', content: SCENE }, { role: 'user', content }];
}

export async function chat(env, messages, temperature, extra = {}) {
  const res = await fetch(env.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.key}` },
    body: JSON.stringify({ model: env.model, messages, temperature, max_tokens: 4000, ...extra }), // 推理模型会先用掉一部分 token，给足余量免得 JSON 被截断
    signal: AbortSignal.timeout(env.timeout || 90000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Semantix ${res.status}: ${text.slice(0, 200)}`);
  const content = JSON.parse(text).choices?.[0]?.message?.content || '';
  const i = content.indexOf('{'), j = content.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('模型没有返回 JSON：' + content.slice(0, 100));
  return JSON.parse(content.slice(i, j + 1));
}


// 多次识图取共识：最佳照片、墙别、镜头取众数；点取中位数；墙角/门/家具要有一半以上的结果给出才算
export function mergeScenes(runs) {
  if (runs.length === 1) return runs[0];
  const mode = a => { const c = new Map(); let b = null; for (const x of a) if (x != null) { c.set(x, (c.get(x) || 0) + 1); if (b === null || c.get(x) > c.get(b)) b = x; } return b; };
  const ok = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(+v));
  const med = a => { a = a.map(Number).filter(Number.isFinite).sort((x, y) => x - y); const n = a.length; return n ? (a[(n - 1) >> 1] + a[n >> 1]) / 2 : null; };
  const best = mode(runs.map(r => r.best)), S = runs.filter(r => r.best === best), need = Math.ceil(S.length / 2);
  const medPt = ps => (ps = ps.filter(ok)).length >= need ? [med(ps.map(p => p[0])), med(ps.map(p => p[1]))] : null;
  const wall = mode(S.map(r => r.wall)), W = S.filter(r => r.wall === wall);
  const dd = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  // 门：各次的铰链/锁侧可能对调，先按第一次的对齐
  const doors = S.map(r => r.door).filter(d => d && ok(d.hinge) && ok(d.latch));
  const doorsA = doors.map(d => doors[0] && dd(d.hinge, doors[0].hinge) > dd(d.latch, doors[0].hinge) ? { ...d, hinge: d.latch, latch: d.hinge } : d);
  const door = doorsA.length >= need ? { hinge: medPt(doorsA.map(d => d.hinge)), latch: medPt(doorsA.map(d => d.latch)), swing: mode(doorsA.map(d => d.swing)) || 'in' } : null;
  const corner = {};
  for (const k of ['left', 'right']) corner[k] = medPt(S.map(r => r.corner?.[k]).filter(p => ok(p) && p[0] > 0.02 && p[0] < 0.98));
  // 家具：按落地点重心在 0.12 以内归成一组，一半以上的结果里都有才要，取最接近组平均的那一个
  const cen = o => [med(o.pts.map(p => p[0])), med(o.pts.map(p => p[1]))], groups = [];
  S.forEach((r, i) => (Array.isArray(r.obstacles) ? r.obstacles : []).forEach(o => {
    if (!Array.isArray(o?.pts) || !o.pts.some(ok)) return;
    o = { ...o, pts: o.pts.filter(ok) }; const c = cen(o);
    const g = groups.find(g => !g.runs.has(i) && dd(g.c, c) < 0.12);
    if (g) { g.list.push(o); g.runs.add(i); } else groups.push({ c, list: [o], runs: new Set([i]) });
  }));
  const obstacles = groups.filter(g => g.list.length >= need).map(g => {
    const m = [med(g.list.map(o => cen(o)[0])), med(g.list.map(o => cen(o)[1]))];
    const o = g.list.reduce((b, o) => dd(cen(o), m) < dd(cen(b), m) ? o : b);
    return { ...o, depth: med(g.list.map(o => o.depth)) };
  });
  const top = medPt(S.map(r => ok(r.doorTop) && ok(r.doorBottom) ? r.doorTop : null)), bottom = medPt(S.map(r => ok(r.doorTop) && ok(r.doorBottom) ? r.doorBottom : null));
  return {
    ...S[0], best, wall, wallBase: medPt(W.map(r => r.wallBase)), cameraHeight: med(S.map(r => r.cameraHeight)),
    doorTop: top && bottom ? top : null, doorBottom: top && bottom ? bottom : null, door, corner, obstacles,
    lens: mode(S.map(r => r.lens)),
    rec: S[0].rec && { style: S[0].rec.style, shelfMaterial: mode(S.map(r => r.rec?.shelfMaterial)), rodFinish: mode(S.map(r => r.rec?.rodFinish)) }, note: (W[0] || S[0]).note, votes: `${W.length}/${runs.length}`,
  };
}
