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

def half_w(u, W, toe=0.32):  # 俯视轮廓：鞋跟圆、前掌最宽、鞋头圆
    k = 1 - toe
    base = 0.78 + 0.22 * math.sin(min(u / k, 1) * math.pi / 2) if u <= k else math.sqrt(max(0, 1 - ((u - k) / toe) ** 2))
    if u < 0.1: base *= math.sqrt(max(0, 1 - ((0.1 - u) / 0.1) ** 2)) * 0.25 + 0.75 * (u / 0.1) ** 0.5
    return W / 2 * base

def stations():
    return [(1 - math.cos(math.pi * i / (N_ST - 1))) / 2 for i in range(N_ST)]

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

def loft(name, parent, L, W, zb, zt, mats, wscale=1.0, taper=0.0, sq=0.55, opening=None, regions=()):
    """沿长度放样：每个截面底平、顶圆，往上收窄 taper。zb/zt(u) 给底和顶高（mm），鞋头鞋跟自动收圆。
    opening=(uc, ru, rx, floor)：顶上开一个椭圆鞋口，直接做进每个截面里（外壁 → 3mm 鞋帮 → 内壁 → 鞋底 → 另一侧），
    边缘顺着椭圆走，不会有锯齿；里面用第 2 个材质。
    regions=[(f(u, t) -> bool, 材质序号)]：按位置给面换材质（鞋跟片、鞋头包边），t 是相对高度。"""
    NO, NF, NB = 3, 4, 8          # 顶部每侧外壁点数、鞋口底点数、侧面和底部点数
    RIM = 3.0
    def outer(a, hw, b, t):
        rt = ring_t(math.sin(a)); c = math.cos(a)
        return hw * math.copysign(abs(c) ** sq, c) * (1 - taper * max(0, rt - 0.3) / 0.7), b + (t - b) * rt
    A0 = math.radians(25)
    bm = bmesh.new(); rings = []
    for u in stations():
        hw = half_w(u, W) * wscale; b, t = zb(u), zt(u)
        if u > 0.86: t = b + (t - b) * math.sqrt(max(0.1, 1 - ((u - 0.86) / 0.14) ** 2))  # 鞋头圆
        if u < 0.04: t = b + (t - b) * math.sqrt(max(0.55, 1 - ((0.04 - u) / 0.04) ** 2))
        wo, depth = 0.0, 0.0
        if opening:
            uc, ru, rx, floor = opening
            e = 1 - ((u - uc) / ru) ** 2
            if e > 0: wo = rx * hw * math.sqrt(e)
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
        rings.append((u, b, t, [bm.verts.new((x * MM, u * L * MM, z * MM)) for x, z in pts]))
    n = len(rings[0][3]); lin = range(NO, NO + NF + 1) if opening else range(0)
    for (ua, ba, ta, ra), (ub, _, _, rb) in zip(rings, rings[1:]):
        for j in range(n):
            f = bm.faces.new((ra[j], ra[(j + 1) % n], rb[(j + 1) % n], rb[j]))
            if j in lin: f.material_index = 1; continue
            c = f.calc_center_median(); tm = (c.z / MM - ba) / max(1e-6, ta - ba)
            for cond, mi in regions:
                if cond((ua + ub) / 2, tm): f.material_index = mi
    bm.faces.new(list(reversed(rings[0][3]))); bm.faces.new(rings[-1][3])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.05 * MM)
    outward(bm)
    return new_obj(name, bm, mats, parent)

def band(name, parent, L, W, ua, ub, zbase, h, th, m, wscale=1.06):
    """横跨鞋面的拱形带（凉鞋、拖鞋、魔术贴）。"""
    bm = bmesh.new(); n = 9; layers = []
    for u in (ua, ub):
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

def heel_pin(name, parent, L, u, top, r0, r1, m):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=r0 * MM, radius2=r1 * MM, depth=top * MM)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, u * L * MM, top * MM / 2))
    return new_obj(name, bm, [m], parent)

LINING = mat('lining', '#2b2522', 0.9)

def laces(key, root, L, W, top, color, us=(0.43, 0.48, 0.53, 0.58, 0.63)):
    """鞋带：鞋舌上交叉的白条，顺着鞋面坡度。"""
    from mathutils import Matrix
    lm = mat(key + '_l', color, 0.8)
    for i, u in enumerate(us):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
        slope = (top(u + 0.01) - top(u - 0.01)) / (0.02 * L)
        bmesh.ops.scale(bm, vec=(W * 0.5 * MM, 7 * MM, 3 * MM), verts=bm.verts)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(0.32 * (1 if i % 2 else -1), 3, 'Z'))
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.atan(slope), 3, 'X'))
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, u * L * MM, (top(u) + 0.5) * MM))
        new_obj(f'{key}_lace{i}', bm, [lm], root)

def sneaker(key, L, W, H, upper, sole, accent=None, kid=False):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    sH = 22 if not kid else 16
    sole_b = lambda u: 7 * smooth(0.82, 1, u)           # 鞋头微翘
    sole_t = lambda u: sole_b(u) + sH + 5 * (1 - smooth(0.2, 0.6, u))  # 后跟厚
    loft(key + '_sole', root, L, W, sole_b, sole_t, [mat(key + '_s', sole, 0.6)], wscale=1.04, sq=0.3)
    top = lambda u: lerp_prof([(0, H * 0.8), (0.1, H * 0.76), (0.24, H * 0.6), (0.42, H * 0.86), (0.6, H * 0.74), (0.86, H * 0.5), (1, H * 0.34)], u)
    mats = [mat(key + '_u', upper, 0.75), LINING, mat(key + '_t', sole, 0.6)]
    regions = [(lambda u, t: u > 0.72, 2)]  # 白鞋头，后半段是彩色
    loft(key + '_up', root, L, W * 0.97, lambda u: sole_t(u) - 2, top, mats, taper=0.22,
         opening=(0.25, 0.16, 0.68, sole_t), regions=regions)
    if accent: band(key + '_strap', root, L, W, 0.5, 0.6, sH - 2, H * 0.66, 3, mat(key + '_a', accent, 0.6), wscale=0.9)
    else: laces(key, root, L, W * 0.9, top, '#e6e3dc')
    return root

def leather(key, L, W, H, upper, sole, boot=False, heel=25):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    st = lambda u: lerp_prof([(0, heel), (0.24, heel), (0.3, 12), (1, 12)], u) + 4 * smooth(0.85, 1, u)
    loft(key + '_sole', root, L, W, lambda u: 4 * smooth(0.85, 1, u), st, [mat(key + '_s', sole, 0.5)], wscale=1.03, sq=0.3)
    if boot:
        top = lambda u: lerp_prof([(0, H), (0.3, H * 0.97), (0.42, H * 0.52), (0.8, H * 0.36), (1, H * 0.2)], u); op = (0.17, 0.15, 0.72); regions = []
    else:
        top = lambda u: lerp_prof([(0, H * 0.62), (0.12, H * 0.6), (0.3, H * 0.55), (0.5, H * 0.68), (0.86, H * 0.48), (1, H * 0.3)], u); op = (0.27, 0.17, 0.66)
        regions = [(lambda u, t: u > 0.8, 2)]  # 鞋头包头颜色深一点
    loft(key + '_up', root, L, W * 0.96, lambda u: st(u) - 2, top, [mat(key + '_u', upper, 0.45), LINING, mat(key + '_c', '#3e332c', 0.35)],
         taper=0.18, opening=(*op, st), regions=regions)
    if not boot: laces(key, root, L, W * 0.75, top, '#1e1612', (0.47, 0.51, 0.55))
    return root

def pump(key, L, W, H, upper, sole, heelH=75):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    ins = lambda u: lerp_prof([(0, heelH), (0.2, heelH * 0.95), (0.62, 6), (1, 6)], u)
    loft(key + '_sole', root, L, W, lambda u: ins(u) - 5, ins, [mat(key + '_s', sole, 0.4)], sq=0.3)
    top = lambda u: ins(u) + lerp_prof([(0, 44), (0.12, 40), (0.3, 26), (0.6, 22), (0.74, 34), (1, 22)], u)
    loft(key + '_up', root, L, W * 0.97, lambda u: ins(u) - 1, top, [mat(key + '_u', upper, 0.35), LINING], taper=0.15,
         opening=(0.37, 0.28, 0.8, ins))
    heel_pin(key + '_heel', root, L, 0.07, heelH - 4, 5, 11, mat(key + '_u', upper, 0.35))
    return root

def flat(key, L, W, H, upper, sole):
    root = bpy.data.objects.new(key, None); bpy.context.collection.objects.link(root)
    st = lambda u: 12 - 3 * smooth(0.3, 0.5, u)
    loft(key + '_sole', root, L, W, lambda u: 0, st, [mat(key + '_s', sole, 0.5)], wscale=1.02, sq=0.3)
    top = lambda u: lerp_prof([(0, H * 0.6), (0.12, H * 0.58), (0.3, H * 0.5), (0.52, H * 0.66), (0.86, H * 0.5), (1, H * 0.3)], u)
    loft(key + '_up', root, L, W * 0.97, lambda u: 8, top, [mat(key + '_u', upper, 0.5), LINING], taper=0.18,
         opening=(0.29, 0.19, 0.68, st))
    band(key + '_bar', root, L, W, 0.56, 0.6, 8, H * 0.6, 2.5, mat(key + '_a', '#b3a68e', 0.3), wscale=0.9)  # 乐福鞋鞋面横条
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
        band(key + '_b0', root, L, W, 0.46, 0.76, sH, 38, 6, m, wscale=1.0)
    return root

def build():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
    for me in list(bpy.data.meshes): bpy.data.meshes.remove(me)
    S = [  # key, 构造, 尺寸 L×W×H(mm)
        ('m_sneaker', lambda: sneaker('m_sneaker', 290, 110, 105, '#9a9b9e', '#e6e3dc')),
        ('m_oxford', lambda: leather('m_oxford', 290, 105, 95, '#5e4f45', '#2f2b28')),
        ('m_boot', lambda: leather('m_boot', 295, 112, 165, '#a8957f', '#3a3633', boot=True)),
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
