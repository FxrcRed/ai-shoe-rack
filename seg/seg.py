# 照片语义分割 → 小尺寸分组图（每像素一个组号），给摆放判断「候选脚印下面是不是空地面、有没有压家具挡门」
# 模型 Mask2Former（ADE20K 150 类，swin-small），CPU 每张约 2 秒；第一次运行从 HuggingFace 下载约 200MB
# 需要：pip install torch torchvision transformers pillow numpy（CPU 版即可）
#   python -I seg/seg.py serve [端口]                 常驻服务（server.js 自动启动）：POST /seg {"image": dataURL} → {"w", "h", "data": 每像素一字节的 base64}
#   python -I seg/seg.py <照片目录> <输出目录> [名字前缀...]   批量（评测用）
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
    4: ['cabinet', 'table', 'chair', 'sofa', 'shelf', 'armchair', 'seat', 'desk', 'wardrobe', 'chest of drawers', 'counter',
        'bookcase', 'coffee table', 'bench', 'kitchen island', 'swivel chair', 'buffet', 'stool', 'ottoman', 'bed', 'fireplace',
        'refrigerator', 'radiator', 'stairs', 'stairway', 'step', 'bannister', 'railing', 'bathtub', 'washer', 'case', 'plant',
        'piano', 'sideboard', 'console table', 'dresser'],
    5: ['box', 'bag', 'basket', 'ashcan', 'plaything', 'apparel', 'bottle', 'vase', 'pot', 'cushion', 'pillow', 'towel'],
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
    seg = Seg()
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'] or 0)))
                im = Image.open(io.BytesIO(base64.b64decode(body['image'].split(',')[-1])))
                g = seg(im)  # 不回 PNG：浏览器在后台时 Image.decode() 不返回
                out, code = {'w': g.width, 'h': g.height, 'data': base64.b64encode(np.asarray(g).tobytes()).decode()}, 200
            except Exception as e:
                out, code = {'error': str(e)[:200]}, 500
            data = json.dumps(out).encode()
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        def log_message(self, *a): pass
    print(f'seg service http://127.0.0.1:{port}', flush=True)  # Windows 控制台编码不一定是 UTF-8，只打 ASCII
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()

def batch(src, dst, only):
    os.makedirs(dst, exist_ok=True); seg = Seg()
    for f in sorted(glob.glob(os.path.join(src, '*.jpg'))):
        base = os.path.splitext(os.path.basename(f))[0]
        if only and not any(base.startswith(o) for o in only): continue
        g = seg(Image.open(f)); g.save(os.path.join(dst, base + '.png'))
        print(base, np.bincount(np.asarray(g).ravel(), minlength=6).tolist(), flush=True)

if __name__ == '__main__':
    if sys.argv[1] == 'serve': serve(int(sys.argv[2]) if len(sys.argv) > 2 else 8790)
    else: batch(sys.argv[1], sys.argv[2], sys.argv[3:])
