# 在 Blender 里生成 9 款低多边形参照鞋，导出 public/shoes.glb
# 用法：Blender 的 Python 控制台 exec(open(r'...\scripts\shoes_blender.py', encoding='utf-8').read())
# 坐标：鞋长沿 +Y（鞋头朝 +Y，鞋跟在 y=0），宽沿 X，高沿 Z；单位米。每款是一个空物体，下面挂一只右脚的零件，左脚在网页里镜像。
import bpy, bmesh, math, os

MM = 0.001
N_ST = 14   # 沿长度的截面数（少 = 纸模那种大切面）

def smooth(a, b, x):
    t = min(1, max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t)

def lerp_prof(pts, u):  # pts: [(u, v)...] 折线插值
    for (u0, v0), (u1, v1) in zip(pts, pts[1:]):
        if u <= u1: return v0 + (v1 - v0) * smooth(u0, u1, u)
    return pts[-1][1]

BLUNT = (0.45, 0.72, 0.9)    # 圆头：鞋头最前端留下的宽度（占最宽处）、高度（占该处鞋高）、从哪里开始收圆；参考纸模鞋的鞋头是鼓起来有厚度的
POINTY = (0.0, 0.32, 0.86)  # 尖头（高跟鞋）

def half_w(u, W, toe=0.26, cap=BLUNT[0]):  # 俯视轮廓：鞋跟圆、前掌最宽、鞋头宽圆
    k = 1 - toe
    base = 0.78 + 0.22 * math.sin(min(u / k, 1) * math.pi / 2) if u <= k else (cap + (1 - cap) * math.sqrt(max(0, 1 - ((u - k) / toe) ** 2)) if cap > 0 else 1 - ((u - k) / toe) ** 1.8)  # cap=0 尖头：收到一点，不是圆
    if u < 0.1: base *= math.sqrt(max(0, 1 - ((0.1 - u) / 0.1) ** 2)) * 0.25 + 0.75 * (u / 0.1) ** 0.5
    return W / 2 * base

TOE_BULGE, HEEL_BULGE, APEX_T = 0.3, 0.3, 0.45  # 封口尖顶往外推多少（占该处半宽）、尖顶在截面的相对高度
ST_LIN = 0.5  # 截面间距：0 = 纯余弦（两端密），1 = 均匀
TOE_SPRING = 6
FACET, JITTER = True, 1.5  # 鞋头离地翘起（mm），皮鞋 10、运动鞋 ×1.4

OPEN_P = 3     # 鞋口俯视形状的超椭圆指数：2 是椭圆（两头尖成枣核），越大两头越圆，像真鞋的 U 形鞋口
OPEN_N = 7     # 鞋口范围内的截面数：截面少时鞋口边是折线，看着像菱形
RIM = 4.5      # 鞋帮顶厚度（mm）

def stations(opening=None):
    base = [ST_LIN * i / (N_ST - 1) + (1 - ST_LIN) * (1 - math.cos(math.pi * i / (N_ST - 1))) / 2 for i in range(N_ST)]
    if not opening: return base
    u0, u1 = max(0.0, opening[0] - opening[1]), min(1.0, opening[0] + opening[1])
    extra = [u0 + 0.004 + (u1 - u0 - 0.008) * i / (OPEN_N - 1) for i in range(OPEN_N)]
    extra += [u for u in (u0 - 0.003, u1 + 0.003) if 0 < u < 1]  # 鞋口两头外面紧挨一圈不开口的截面：鞋口两端是一堵墙，不是斜坡
    keep = [u for u in base if all(abs(u - e) > 0.012 for e in extra)]
    return sorted(keep + extra)

def rings_mat_end(regions, u):
    for cond, mi in regions:
        if cond(u, 0.5): return mi
    return 0

def mat(name, hexc, rough=0.7):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    c = tuple(int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
    b.inputs['Base Color'].default_value = (*[x ** 2.2 for x in c], 1)
    b.inputs['Roughness'].default_value = rough
    return m

def new_obj(name, bm, mats, parent):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = False  # 平面着色，切面风格
    for m in mats: me.materials.append(m)
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); o.parent = parent
    return o

def outward(bm):
    """法线朝外：recalc 遇到收成一点的鞋头鞋跟会整体翻反，所以按“法线和离中心方向一致”再检查一遍。"""
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.normal_update()
    c = sum((v.co for v in bm.verts), __import__('mathutils').Vector()) / len(bm.verts)
    if sum((f.calc_center_median() - c).dot(f.normal) * f.calc_area() for f in bm.faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)

def ring_t(s):  # 截面上一点的相对高度 0（底）~1（顶）；底部压平
    return 0.5 + 0.5 * math.copysign(abs(s) ** (0.45 if s < 0 else 0.8), s)

A0 = math.radians(25)  # 截面外壁从侧面这个角度开始往上算（再往下是底）

def sect_pt(a, hw, b, t, sq, taper):  # loft 截面上角度 a 处的点 (x, z)
    rt = ring_t(math.sin(a)); c = math.cos(a)
    return hw * math.copysign(abs(c) ** sq, c) * (1 - taper * max(0, rt - 0.3) / 0.7), b + (t - b) * rt

def loft(name, parent, L, W, zb, zt, mats, wscale=1.0, taper=0.0, sq=0.55, opening=None, regions=(), tip=BLUNT, jitter=None, extra=(), heel=(0.04, 0.55), cup=0):
    """沿长度放样：每个截面底平、顶圆，往上收窄 taper。zb/zt(u) 给底和顶高（mm），鞋头鞋跟自动收圆。
    opening=(uc, ru, rx, floor)：顶上开一个椭圆鞋口，直接做进每个截面里（外壁 → 3mm 鞋帮 → 内壁 → 鞋底 → 另一侧），
    边缘顺着椭圆走，不会有锯齿；里面用第 2 个材质。
    regions=[(f(u, t) -> bool, 材质序号)]：按位置给面换材质（鞋跟片、鞋头包边），t 是相对高度。
    tip：鞋头形状，BLUNT 圆头或 POINTY 尖头。"""
    NO, NF, NB = 3, 4, 8          # 顶部每侧外壁点数、鞋口底点数、侧面和底部点数
    outer = lambda a, hw, b, t: sect_pt(a, hw, b, t, sq, taper)
    bm = bmesh.new(); rings = []; collar = set()
    for u in sorted(set(stations(opening)) | set(extra)):  # extra：额外截面，让鞋面贴近 zt（截面稀时鞋面是弦，会盖住贴在上面的鞋带）
        hw = half_w(u, W, toe=0.42 if tip[0] == 0 else 0.26, cap=tip[0]) * wscale; b, t = zb(u), zt(u)
        if u > tip[2]: t = b + (t - b) * math.sqrt(max(tip[1] ** 2, 1 - ((u - tip[2]) / (1 - tip[2])) ** 2))  # 鞋头圆
        hr, hm = heel  # 鞋跟收圆：从 u=hr 往后收，最后面留 √hm 的高度
        if u < hr: t = b + (t - b) * math.sqrt(max(hm, 1 - ((hr - u) / hr) ** 2))
        wo, depth = 0.0, 0.0
        if opening:
            uc, ru, rx, floor = opening
            e = 1 - abs((u - uc) / ru) ** OPEN_P
            if e > 0: wo = rx * hw * e ** (1 / OPEN_P)
        # 右侧外壁：从 A0 往上走到鞋口边（x = wo），二分找角度
        lo, hi = A0, math.pi / 2
        for _ in range(30):
            m = (lo + hi) / 2
            if outer(m, hw, b, t)[0] > wo: lo = m
            else: hi = m
        ar = lo if wo > 0 else math.pi / 2
        pts = [outer(A0 + (ar - A0) * i / (NO - 1), hw, b, t) for i in range(NO)]
        zr = pts[-1][1]
        if opening:
            fz = min(zr, floor(u) + 1); zf = zr + (fz - zr) * smooth(0, 10, wo)
            xi = max(0.0, pts[-1][0] - RIM)
            pts.append((xi, zr))                                   # 鞋帮顶（厚度 RIM）
            pts += [(xi - 2 * xi * i / (NF - 1), zf) for i in range(NF)]  # 内壁下到鞋口底，横过去
            pts.append((-xi, zr))
        pts += [(-x, z) for x, z in reversed(pts[:NO])]           # 左侧外壁（镜像）
        pts += [outer(math.pi - A0 + (math.pi + 2 * A0) * (i + 1) / (NB + 1), hw, b, t) for i in range(NB)]  # 侧面和底
        # cup：后跟杯往后鼓的 mm 数，中间高度鼓得最多、上下不鼓，侧面看后跟是一道弧而不是竖直的墙
        bulge = lambda z: cup * math.sin(math.pi * min(1, max(0, (z - b) / max(1e-6, t - b)))) * (1 - u / hr) if u < hr else 0
        vs = [bm.verts.new((x * MM, (u * L - bulge(z)) * MM, z * MM)) for x, z in pts]
        if wo > 0: collar.update(vs[NO - 1:NO + NF + 2])
        rings.append((u, b, t, vs))
    n = len(rings[0][3]); lin = range(NO, NO + NF + 1) if opening else range(0)
    for (ua, ba, ta, ra), (ub, _, _, rb) in zip(rings, rings[1:]):
        for j in range(n):
            f = bm.faces.new((ra[j], ra[(j + 1) % n], rb[(j + 1) % n], rb[j]))
            if j in lin: f.material_index = 1; continue
            c = f.calc_center_median(); tm = (c.z / MM - ba) / max(1e-6, ta - ba)
            for cond, mi in regions:
                if cond((ua + ub) / 2, tm): f.material_index = mi
    # 两端不用平面封口（鞋头会像被锯掉一截），改成往外鼓的尖顶扇形：鞋头前推 TOE_BULGE×该处半宽，鞋跟后推 HEEL_BULGE×半宽
    from mathutils import Vector
    for (u, b, t, ring), push, rev in ((rings[0], -HEEL_BULGE, True), (rings[-1], TOE_BULGE, False)):
        hw = max(abs(v.co.x) for v in ring)
        c = sum((v.co for v in ring), Vector()) / len(ring)
        apex = bm.verts.new((0, ring[0].co.y + push * hw, (b + (t - b) * APEX_T) * MM))
        rr = list(reversed(ring)) if rev else ring
        for a, bb in zip(rr, rr[1:] + rr[:1]):
            if (a.co - bb.co).length > 1e-7: f = bm.faces.new((a, bb, apex)); f.material_index = rings_mat_end(regions, u)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.05 * MM)
    if FACET:  # 纸模感：长条四边形拆成交错三角形，顶点按固定伪随机轻推 JITTER mm，相邻切面朝向不同、明暗分得开
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) == 4], quad_method='ALTERNATE')
        for i, v in enumerate(bm.verts):
            if v in collar: continue  # 鞋口边不推：推了边会变锯齿
            r = math.sin(i * 12.9898 + len(name)) * 43758.5453; r -= math.floor(r)
            v.co.x += (r - 0.5) * 2 * (JITTER if jitter is None else jitter) * MM * (1 if v.co.x >= 0 else -1) * 0.5
            v.co.z += (((r * 7.31) % 1) - 0.5) * 2 * (JITTER if jitter is None else jitter) * MM if v.co.z > 2 * MM else 0
    outward(bm)
    return new_obj(name, bm, mats, parent)

def band(name, parent, L, W, ua, ub, zbase, h, th, m, wscale=1.06):
    """横跨鞋面的拱形带（凉鞋、拖鞋、魔术贴）。h 可以给 (后沿高, 前沿高)，顺着脚背往前低下去。"""
    bm = bmesh.new(); n = 9; layers = []
    hs = h if isinstance(h, tuple) else (h, h)
    for u, h in zip((ua, ub), hs):
        hw = half_w((ua + ub) / 2, W) * wscale
        outer = [bm.verts.new(((hw + th) * math.cos(math.pi * i / (n - 1)) * MM, u * L * MM, (zbase + (h + th) * math.sin(math.pi * i / (n - 1))) * MM)) for i in range(n)]
        inner = [bm.verts.new((hw * math.cos(math.pi * i / (n - 1)) * MM, u * L * MM, (zbase + h * math.sin(math.pi * i / (n - 1))) * MM)) for i in range(n)]
        layers.append((outer, inner))
    (o0, i0), (o1, i1) = layers
    for i in range(n - 1):
        bm.faces.new((o0[i], o0[i + 1], o1[i + 1], o1[i]))
        bm.faces.new((i0[i + 1], i0[i], i1[i], i1[i + 1]))
    for (o, ii) in layers:
        for i in range(n - 1): bm.faces.new((o[i], ii[i], ii[i + 1], o[i + 1]))
    for i in (0, n - 1):
        bm.faces.new((o0[i], i0[i], i1[i], o1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, [m], parent)

def saddle(name, parent, L, W, ua, ub, zb, zt, m, th=2.5, sq=0.55, taper=0.0, gap=1.5):
    """贴着鞋面横跨的带子：截面和 loft 的鞋面一样（参数也要一样），往外让开 gap（盖过鞋面顶点推动），厚 th。
    band() 是半圆拱，鞋面截面更方，拱会埋进鞋面里只露两端。"""
    bm = bmesh.new(); n = 11; layers = []
    for u in (ua, ub):
        hw, b, t = half_w(u, W), zb(u), zt(u)
        pts = [sect_pt(A0 + (math.pi - 2 * A0) * i / (n - 1), hw, b, t, sq, taper) for i in range(n)]
        def off(i, d):  # 沿截面外法线让开 d
            (x0, z0), (x1, z1) = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
            tx, tz = x1 - x0, z1 - z0; k = math.hypot(tx, tz)
            return pts[i][0] + tz / k * d, pts[i][1] - tx / k * d  # 点从右往左走，切线左转 90° 朝里，所以取右转
        mk = lambda d: [bm.verts.new((x * MM, u * L * MM, z * MM)) for x, z in (off(i, d) for i in range(n))]
        layers.append((mk(gap + th), mk(gap)))
    (o0, i0), (o1, i1) = layers
    for i in range(n - 1):
        bm.faces.new((o0[i], o0[i + 1], o1[i + 1], o1[i]))
        bm.faces.new((i0[i + 1], i0[i], i1[i], i1[i + 1]))
    for (o, ii) in layers:
        for i in range(n - 1): bm.faces.new((o[i], ii[i], ii[i + 1], o[i + 1]))
    for i in (0, n - 1):
        bm.faces.new((o0[i], i0[i], i1[i], o1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm, [m], parent)

def heel_pin(name, parent, L, u, top, r0, r1, m):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=r0 * MM, radius2=r1 * MM, depth=top * MM)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, u * L * MM, top * MM / 2))
    return new_obj(name, bm, [m], parent)

LINING = mat('lining', '#2b2522', 0.9)

def laces(key, root, L, W, top, color, us=(0.43, 0.48, 0.53, 0.58, 0.63), lift=0.5):
    """鞋带：鞋舌上一排横条，顺着鞋面坡度。不交替转角：连起来会读成字母 N。"""
    from mathutils import Matrix
    lm = mat(key + '_l', color, 0.8)
    for i, u in enumerate(us):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
        slope = (top(u + 0.01) - top(u - 0.01)) / (0.02 * L)
        bmesh.ops.scale(bm, vec=(W * 0.5 * MM, 7 * MM, 3 * MM), verts=bm.verts)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.atan(slope), 3, 'X'))
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, (u * L - lift * slope / math.hypot(1, slope)) * MM, (top(u) + lift / math.hypot(1, slope)) * MM))  # 沿鞋面法线抬 lift
        new_obj(f'{key}_lace{i}', bm, [lm], root)

def sneaker(key, L, W, H, upper, sole, accent=None, kid=False):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    sH = 22 if not kid else 16
    sole_b = lambda u: 1.4 * TOE_SPRING * smooth(0.7, 1, u)           # 鞋头微翘
    sole_t = lambda u: sole_b(u) + sH + 5 * (1 - smooth(0.2, 0.6, u))  # 后跟厚
    loft(key + '_sole', root, L, W, sole_b, sole_t, [mat(key + '_s', sole, 0.6)], wscale=1.04, sq=0.3)
    top = lambda u: lerp_prof([(0, H * 0.8), (0.1, H * 0.76), (0.24, H * 0.6), (0.42, H * 0.86), (0.6, H * 0.74), (0.8, H * 0.58), (0.92, H * 0.54), (1, H * 0.5)], u)
    mats = [mat(key + '_u', upper, 0.75), LINING, mat(key + '_t', sole, 0.6)]
    regions = [(lambda u, t: u > 0.72, 2)]  # 白鞋头，后半段是彩色
    loft(key + '_up', root, L, W * 0.97, lambda u: sole_t(u) - 2, top, mats, taper=0.22,
         opening=(0.25, 0.16, 0.68, sole_t), regions=regions)
    if accent: band(key + '_strap', root, L, W, 0.5, 0.6, sH - 2, H * 0.66, 3, mat(key + '_a', accent, 0.6), wscale=0.9)
    else: laces(key, root, L, W * 0.9, top, '#e6e3dc')
    return root

def leather(key, L, W, H, upper, sole, boot=False, heel=25, chukka=False):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    st = lambda u: lerp_prof([(0, heel), (0.24, heel), (0.3, 12), (1, 12)], u) + TOE_SPRING * smooth(0.7, 1, u)
    loft(key + '_sole', root, L, W, lambda u: TOE_SPRING * smooth(0.7, 1, u), st, [mat(key + '_s', sole, 0.5)], wscale=1.03, sq=0.3)
    if boot:
        top = lambda u: lerp_prof([(0, H), (0.3, H * 0.97), (0.42, H * 0.52), (0.8, H * 0.42), (0.92, H * 0.4), (1, H * 0.36)], u); op = (0.17, 0.15, 0.72); regions = []
        if chukka: regions = [(lambda u, t: u < 0.24 and t < 0.6, 2)]  # 后跟包片
    else:
        top = lambda u: lerp_prof([(0, H * 0.7), (0.12, H * 0.66), (0.3, H * 0.7), (0.47, H * 0.95), (0.64, H * 0.78), (0.8, H * 0.6), (0.92, H * 0.55), (1, H * 0.52)], u); op = (0.27, 0.17, 0.66)
        regions = [(lambda u, t: u > 0.8, 2)]  # 鞋头包头颜色深一点
    accent = '#8a7560' if chukka else '#3e332c'
    loft(key + '_up', root, L, W * 0.96, lambda u: st(u) - 2, top, [mat(key + '_u', upper, 0.45), LINING, mat(key + '_c', accent, 0.35)],
         taper=0.18, opening=(*op, st), regions=regions, extra=(0.34, 0.37, 0.40, 0.43) if chukka else ())
    if not boot: laces(key, root, L, W * 0.75, top, '#1e1612', (0.47, 0.51, 0.55))
    if chukka:  # 沙漠靴：靴筒前面三道鞋带，后面一个提环
        laces(key, root, L, W * 0.4, top, '#4a3c30', (0.33, 0.355, 0.38, 0.405), lift=3)  # 靴筒前面陡，横条要抬高才露得出来
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=(14 * MM, 3 * MM, 24 * MM), verts=bm.verts)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, (0.02 * L + 1.5) * MM, (H - 8) * MM))  # 插在鞋口后沿的鞋帮里（鞋跟往下是收圆的，再往后就悬空了），露出顶上一截
        new_obj(key + '_tab', bm, [mat(key + '_c', accent, 0.35)], root)
    return root

# 高跟鞋侧面轮廓：从参考照片（images/4.png，红色细高跟正侧面）逐列量出，鞋长 250mm，u=0 鞋跟最后、1 鞋尖，单位 mm
PUMP_TOP = [(0, 149), (0.02, 159), (0.05, 170), (0.08, 179), (0.11, 186), (0.14, 194), (0.18, 183), (0.22, 165), (0.27, 142), (0.32, 118),
            (0.37, 94), (0.42, 68), (0.47, 51), (0.52, 41), (0.56, 37), (0.6, 36), (0.65, 38), (0.7, 37), (0.76, 31), (0.82, 24), (0.88, 18), (0.94, 13), (1, 5)]
PUMP_BOT = [(0, 110), (0.08, 105), (0.14, 107), (0.18, 102), (0.22, 91), (0.27, 73), (0.32, 45), (0.37, 14), (0.42, 3), (0.47, 0), (1, 0)]

def lin_prof(pts, u):  # 折线线性插值（量出来的点密，用 lerp_prof 的缓动会一段一段起伏）
    for (u0, v0), (u1, v1) in zip(pts, pts[1:]):
        if u <= u1: return v0 + (v1 - v0) * (u - u0) / (u1 - u0)
    return pts[-1][1]

def pump(key, L, W, H, upper, sole):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    s = L / 250
    bot = lambda u: lin_prof(PUMP_BOT, u) * s
    loft(key + '_sole', root, L, W, bot, lambda u: bot(u) + 4, [mat(key + '_s', sole, 0.4)], sq=0.3, tip=(0, 1, 1), heel=(0.04, 1), jitter=0)
    op = (0.37, 0.23, 0.75)  # 鞋口从鞋跟最高点（u=0.14）到鞋面（u=0.6）；鞋口边落在截面约 92% 高处，所以截面顶要抬一点，侧面看鞋口线才对上照片
    def top(u):
        e = max(0, 1 - abs((u - op[0]) / op[1]) ** OPEN_P) ** (1 / OPEN_P)
        b, t = bot(u) + 3, lin_prof(PUMP_TOP, u) * s
        return b + (t - b) / (1 - 0.08 * e)
    loft(key + '_up', root, L, W * 0.97, lambda u: bot(u) + 3, top, [mat(key + '_u', upper, 0.35), LINING], taper=0.15,
         opening=(*op, lambda u: bot(u) + 4), tip=(0, 1, 1), heel=(0.04, 1), jitter=0)  # 照片轮廓已含鞋头鞋跟的收形，不再自动收圆；漆皮要光滑，不推顶点
    seat = bot(0.06)
    heel_pin(key + '_heel', root, L, 0.06, seat, 3.5, 9, mat(key + '_u', upper, 0.35))
    return root

def flat(key, L, W, H, upper, sole):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    st = lambda u: 12 - 3 * smooth(0.3, 0.5, u)
    loft(key + '_sole', root, L, W, lambda u: 0, st, [mat(key + '_s', sole, 0.5)], wscale=1.02, sq=0.3)
    top = lambda u: lerp_prof([(0, H * 0.72), (0.12, H * 0.68), (0.3, H * 0.66), (0.5, H * 0.95), (0.66, H * 0.8), (0.82, H * 0.62), (0.92, H * 0.54), (1, H * 0.48)], u)
    loft(key + '_up', root, L, W * 0.97, lambda u: 8, top, [mat(key + '_u', upper, 0.5), LINING], taper=0.18,
         opening=(0.29, 0.19, 0.68, st))
    saddle(key + '_bar', root, L, W * 0.97, 0.55, 0.6, lambda u: 8, top, mat(key + '_a', '#b3a68e', 0.3), taper=0.18)  # 乐福鞋鞋面横条
    return root

def slide(key, L, W, sole, strap, sandal=False):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    sH = 18 if sandal else 26
    loft(key + '_sole', root, L, W, lambda u: 0, lambda u: sH + (6 if u < 0.3 else 6 * (1 - smooth(0.3, 0.5, u))), [mat(key + '_s', sole, 0.85)], sq=0.3)
    m = mat(key + '_a', strap, 0.6)
    if sandal:
        for i, (ua, ub, h) in enumerate([(0.5, 0.6, 26), (0.7, 0.8, 20)]):  # 两条宽带，贴着脚背
            band(f'{key}_b{i}', root, L, W, ua, ub, sH, h, 4, m, wscale=0.92)
    else:
        band(key + '_b0', root, L, W, 0.46, 0.76, sH, (36, 22), 4, m, wscale=1.0)
    return root

def build():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
    for me in list(bpy.data.meshes): bpy.data.meshes.remove(me)
    S = [  # key, 构造, 尺寸 L×W×H(mm)
        ('m_sneaker', lambda: sneaker('m_sneaker', 290, 110, 105, '#9a9b9e', '#e6e3dc')),
        ('m_oxford', lambda: leather('m_oxford', 290, 105, 95, '#5e4f45', '#2f2b28')),
        ('m_boot', lambda: leather('m_boot', 295, 112, 165, '#a8957f', '#3a3633', boot=True, chukka=True)),
        ('w_pump', lambda: pump('w_pump', 250, 82, 120, '#242324', '#a33a33')),  # 黑面红底
        ('w_loafer', lambda: flat('w_loafer', 250, 90, 72, '#55576a', '#e3ded6')),
        ('w_boot', lambda: leather('w_boot', 255, 90, 150, '#3b3b3d', '#262627', boot=True, heel=35)),
        ('k_sneaker', lambda: sneaker('k_sneaker', 175, 70, 72, '#93a2b3', '#e6e3dc', accent='#cfc2a6', kid=True)),
        ('slipper', lambda: slide('slipper', 280, 105, '#8b8c8e', '#4e535b')),
        ('sandal', lambda: slide('sandal', 260, 98, '#c9bba6', '#7a6a5a', sandal=True)),
    ]
    for i, (k, f) in enumerate(S):
        f().location = (i * 0.15, 0, 0)
    return [k for k, _ in S]

def render(path):
    """3×3 排开、侧前方看，白底渲一张给人确认。不影响导出（导出前重新 build）。"""
    sc = bpy.context.scene
    for i, k in enumerate(KEYS):
        r = bpy.data.objects[k]; r.rotation_euler = (0, 0, -math.pi / 2)
        r.location = ((i % 3) * 0.36 - 0.5, -(i // 3) * 0.24, 0)
    for o in list(bpy.data.objects):
        if o.type in ('CAMERA', 'LIGHT'): bpy.data.objects.remove(o)
    from mathutils import Vector
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = 1.25
    c = Vector((0.0, -0.26, 0.05)); d = Vector((0.2, -1, 0.5)).normalized()
    cam.location = c + d * 3; cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
    for nm, rot, e in [('key', (0.9, 0.3, 0.6), 3.5), ('fill', (1.2, -0.4, -1.2), 1.2)]:
        l = bpy.data.objects.new(nm, bpy.data.lights.new(nm, 'SUN')); l.data.energy = e; l.rotation_euler = rot; sc.collection.objects.link(l)
    w = sc.world or bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND'); bg.inputs[0].default_value = (0.85, 0.85, 0.88, 1); bg.inputs[1].default_value = 0.9
    sc.render.resolution_x, sc.render.resolution_y = 1200, 800
    sc.view_settings.view_transform = 'Standard'
    sc.render.filepath = path; bpy.ops.render.render(write_still=True)

KEYS = build()
print('built', KEYS, sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH'), 'faces')

def export_js(path):
    """导出成 JS 模块（网页 import 后同步可用，不用 GLTFLoader）：
    { 款式: [{ c: 颜色, p: [x,y,z...], i: [三角形索引...] }] }，坐标换成 three 的：x 宽、y 高、z 鞋长（鞋跟 z=0，鞋头朝 +z），单位 0.1mm 取整。"""
    import json
    out = {}
    for k in KEYS:
        parts = {}
        for o in bpy.data.objects[k].children:
            bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.triangulate(bm, faces=bm.faces)
            for f in bm.faces:
                m = o.data.materials[f.material_index]
                b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value
                col = '#%02x%02x%02x' % tuple(round(255 * max(0, b[i]) ** (1 / 2.2)) for i in range(3))
                P = parts.setdefault(col, {'c': col, 'p': [], 'i': [], 'map': {}})
                for v in reversed(f.verts):  # y、z 互换是一次镜像，三角形顶点顺序要反过来，否则正反面颠倒
                    key = (o.name, v.index)
                    if key not in P['map']:
                        P['map'][key] = len(P['p']) // 3
                        P['p'] += [round(v.co.x / MM * 10), round(v.co.z / MM * 10), round(v.co.y / MM * 10)]
                    P['i'].append(P['map'][key])
            bm.free()
        out[k] = [{'c': P['c'], 'p': P['p'], 'i': P['i']} for P in parts.values()]
    with open(path, 'w', encoding='utf-8') as f:
        f.write('// shoe-models.js — 参照鞋低多边形模型，由 scripts/shoes_blender.py 在 Blender 里生成，别手改\n')
        f.write('export default ' + json.dumps(out, separators=(',', ':')) + ';\n')
    print('exported', path, os.path.getsize(path), 'bytes')
