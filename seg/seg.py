# 照片语义分割 → 小尺寸分组图（每像素一个组号），给摆放判断「候选脚印下面是不是空地面、有没有压家具挡门」
# 模型 Mask2Former（ADE20K 150 类，swin-small），CPU 每张约 2 秒；第一次运行从 HuggingFace 下载约 200MB
# 需要：pip install torch torchvision transformers pillow numpy（CPU 版即可）
#   python -I seg/seg.py serve [端口]                 常驻服务（server.js 自动启动）：POST /seg {"image": dataURL} → {"w", "h", "data": 每像素一字节的 base64, "depth": 同尺寸 uint16 小端的 base64}
#   python -I seg/seg.py <照片目录> <输出目录> [名字前缀...]   批量（评测用）
#   python -I seg/seg.py depth <照片目录> <输出目录> [名字前缀...]   批量出深度图 <名>.depth（评测用）
#   python -I seg/seg.py moge <照片目录> <输出目录>                  批量出 MoGe 相机高 moge.json（评测用，要先有分组图）
import sys, os, glob, io, json, base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
from PIL import Image
import torch
from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation

MODEL = 'facebook/mask2former-swin-small-ade-semantic'
# 组号：0 其他（天花板、窗、画…）1 地面 2 墙 3 门 4 固定家具/楼梯（挡鞋架）5 随手能挪的小东西（不挡）
GROUPS = {
    1: ['floor', 'rug', 'road', 'sidewalk', 'path', 'earth', 'ground', 'carpet'],
    2: ['wall', 'building', 'column', 'house', 'fence', 'pillar'],
    3: ['door', 'screen door', 'double door'],
    4: ['cabinet', 'table', 'sofa', 'shelf', 'seat', 'desk', 'wardrobe', 'chest of drawers', 'counter',
        'bookcase', 'coffee table', 'bench', 'kitchen island', 'buffet', 'bed', 'fireplace',
        'refrigerator', 'radiator', 'stairs', 'stairway', 'step', 'bannister', 'railing', 'bathtub', 'washer', 'case',
        'piano', 'sideboard', 'console table', 'dresser'],
    # 椅子、凳子、脚凳、盆栽随手能挪开，它们占的地方也能放鞋架（用户 2026-11-03 定）
    5: ['box', 'bag', 'basket', 'ashcan', 'plaything', 'apparel', 'bottle', 'vase', 'pot', 'cushion', 'pillow', 'towel',
        'chair', 'armchair', 'swivel chair', 'stool', 'ottoman', 'plant'],
}
W = 256

class Seg:
    def __init__(self):
        self.proc = AutoImageProcessor.from_pretrained(MODEL)
        self.model = Mask2FormerForUniversalSegmentation.from_pretrained(MODEL).eval()
        names = {i: n.split(',')[0].strip().lower() for i, n in self.model.config.id2label.items()}
        self.lut = np.zeros(len(names), np.uint8)
        for g, ns in GROUPS.items():
            for i, n in names.items():
                if n in ns: self.lut[i] = g

    def __call__(self, im):
        im = im.convert('RGB'); im.thumbnail((640, 640))
        with torch.no_grad():
            out = self.model(**self.proc(images=im, return_tensors='pt'))
        seg = self.proc.post_process_semantic_segmentation(out, target_sizes=[(im.height, im.width)])[0].numpy()
        return Image.fromarray(self.lut[seg]).resize((W, round(W * im.height / im.width)), Image.NEAREST)

def serve(port):
    seg, dep, mg = Seg(), Depth(), Moge()
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'] or 0)))
                im = Image.open(io.BytesIO(base64.b64decode(body['image'].split(',')[-1])))
                g, d = seg(im), dep(im)  # 不回 PNG：浏览器在后台时 Image.decode() 不返回
                out, code = {'w': g.width, 'h': g.height, 'data': base64.b64encode(np.asarray(g).tobytes()).decode(), 'depth': base64.b64encode(d.tobytes()).decode(), 'camH': mg(im, g)}, 200
            except Exception as e:
                out, code = {'error': str(e)[:200]}, 500
            data = json.dumps(out).encode()
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        def log_message(self, *a): pass
    print(f'seg service http://127.0.0.1:{port}', flush=True)  # Windows 控制台编码不一定是 UTF-8，只打 ASCII
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()

# 单目深度（Depth Anything V2 Small，约 100MB）：输出相对视差（越大越近，只差一个仿射变换），和分组图同尺寸，存 uint16 小端
DEPTH = 'depth-anything/Depth-Anything-V2-Small-hf'

class Depth:
    def __init__(self):
        from transformers import AutoModelForDepthEstimation
        self.proc = AutoImageProcessor.from_pretrained(DEPTH)
        self.model = AutoModelForDepthEstimation.from_pretrained(DEPTH).eval()

    def __call__(self, im):
        im = im.convert('RGB'); im.thumbnail((640, 640))
        with torch.no_grad():
            d = self.model(**self.proc(images=im, return_tensors='pt')).predicted_depth[0].numpy()
        d = np.asarray(Image.fromarray(d).resize((W, round(W * im.height / im.width)), Image.BILINEAR))
        return np.round((d - d.min()) / max(d.max() - d.min(), 1e-6) * 65535).astype('<u2')

# MoGe-2（微软，MIT）：单张照片出米制点云 → 分组图里的地面拟平面 → 相机离地高（米），给 scene.js camHeight 当尺度来源
# 门没拍全时原来只能让 AI 猜（和门高法中位差 24%），MoGe 中位差 11%。安装：pip install git+https://github.com/microsoft/MoGe.git
MOGE = 'Ruicheng/moge-2-vits-normal'
FLOOR_TOL = 0.03  # 地面平面内点阈值（米）
MOGE_LEVEL = 3  # 分辨率档 0~9：104 张实测 3 档和默认 9 档相机高误差一样（中位 11%），CPU 快约一倍

class Moge:
    def __init__(self):
        try:
            from moge.model.v2 import MoGeModel
            self.model = MoGeModel.from_pretrained(MOGE).eval()
        except Exception as e:  # 没装 MoGe 时其余照常
            print('moge off:', str(e)[:80].encode('ascii', 'replace').decode(), flush=True); self.model = None

    def __call__(self, im, g):
        if not self.model: return None
        im = im.convert('RGB'); im.thumbnail((640, 640))
        with torch.no_grad():
            o = self.model.infer(torch.tensor(np.asarray(im) / 255, dtype=torch.float32).permute(2, 0, 1), use_fp16=False, resolution_level=MOGE_LEVEL)
        pts, mask = o['points'].numpy(), o['mask'].numpy() > 0.5
        fl = (np.asarray(g.resize((mask.shape[1], mask.shape[0]), Image.NEAREST)) == 1) & mask
        P = pts[fl]
        if len(P) < 200: return None
        rng, best = np.random.default_rng(0), None
        for _ in range(300):  # RANSAC 平面
            a, b, c = P[rng.choice(len(P), 3, replace=False)]
            n = np.cross(b - a, c - a); nn = np.linalg.norm(n)
            if nn < 1e-9: continue
            n /= nn; inl = np.abs((P - a) @ n) < FLOOR_TOL
            if best is None or inl.sum() > best.sum(): best = inl
        if best.mean() < 0.5: return None  # 地面不成平面（分割错了）
        Q = P[best]; c0 = Q.mean(0); n = np.linalg.svd(Q - c0, full_matrices=False)[2][-1]
        return round(float(abs(n @ c0)), 3)

def batch_moge(src, dst):
    mg, out = Moge(), {}
    for f in sorted(glob.glob(os.path.join(src, '*.jpg'))):
        base = os.path.splitext(os.path.basename(f))[0]; gp = os.path.join(dst, base + '.png')
        if not os.path.exists(gp): continue
        out[base + '.jpg'] = mg(Image.open(f), Image.open(gp)); print(base, out[base + '.jpg'], flush=True)
    json.dump(out, open(os.path.join(dst, 'moge.json'), 'w'), indent=0)

def batch_depth(src, dst, only):
    os.makedirs(dst, exist_ok=True); dep = Depth()
    for f in sorted(glob.glob(os.path.join(src, '*.jpg'))):
        base = os.path.splitext(os.path.basename(f))[0]
        if only and not any(base.startswith(o) for o in only): continue
        d = dep(Image.open(f)); open(os.path.join(dst, base + '.depth'), 'wb').write(d.tobytes())
        print(base, d.shape, flush=True)

def batch(src, dst, only):
    os.makedirs(dst, exist_ok=True); seg = Seg()
    for f in sorted(glob.glob(os.path.join(src, '*.jpg'))):
        base = os.path.splitext(os.path.basename(f))[0]
        if only and not any(base.startswith(o) for o in only): continue
        g = seg(Image.open(f)); g.save(os.path.join(dst, base + '.png'))
        print(base, np.bincount(np.asarray(g).ravel(), minlength=6).tolist(), flush=True)

if __name__ == '__main__':
    if sys.argv[1] == 'serve': serve(int(sys.argv[2]) if len(sys.argv) > 2 else 8790)
    elif sys.argv[1] == 'depth': batch_depth(sys.argv[2], sys.argv[3], sys.argv[4:])
    elif sys.argv[1] == 'moge': batch_moge(sys.argv[2], sys.argv[3])
    else: batch(sys.argv[1], sys.argv[2], sys.argv[3:])
