# 实景装置合成（AI 定制光轴鞋架网页原型）

拍一张家里角落的照片，用语音或文字说需求（例如「门口，五六双鞋，能挂雨伞」），AI 把需求翻译成结构参数，生成 3 个光轴鞋架方案，用 three.js 叠在照片上拖动对位；可以反复修改，选定后由程序**确定性地**算出零件表：每种长度的光轴根数、T 型/十字/角件等连接件、底座、限位环、隔板尺寸，可填单价并导出 CSV。

- 在线演示（模拟模式，无需密钥）：https://fxrcred.github.io/ai-shoe-rack/
- AI 只输出参数 JSON，不出零件表；结构和清单逻辑在 [`public/rack.js`](public/rack.js)，开头写清了连接件判定规则。

## 本地运行
```bash
node server.js
```
打开 http://localhost:8787（Node 18+，零依赖）。手机连同一 WiFi 用终端打印的局域网地址。

## 接入真实 AI（Semantix，OpenAI 兼容接口）
1. 复制 `.env.example` 为 `.env`
2. 在 https://sem.ensureok.ai/keys 创建密钥（建议设额度上限），填进 `SEMANTIX_API_KEY`
3. 重启 `node server.js`，右上角显示「AI：模型名」即生效

没有密钥、没有后端（如 GitHub Pages）或 AI 调用失败时，自动用关键词规则的模拟模式，整条流程照样能走通。

## 文件
| 文件 | 作用 |
|---|---|
| `server.js` | 托管页面 + 转发 AI 请求，密钥只在服务器端 |
| `ai.js` | 提示词与 AI 调用 |
| `public/rack.js` | 参数校验 → 光轴骨架 → 连接件判定 → 零件表 / CSV |
| `public/mock.js` | 模拟模式 |
| `public/viewer.js` | three.js 渲染与照片对位 |
| `public/app.js` | 页面流程、语音输入、版本历史 |

零件尺寸为原型估算（插入连接件每端扣 d/2），下单前请厂家按实际连接件复核。
