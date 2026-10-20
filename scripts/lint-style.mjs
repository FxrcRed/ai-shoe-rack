// 样式检查：字号 / 字重 / 间距 / 圆角 / 文字颜色只能用 style.css 顶部定义的几档变量。
// 用法：node scripts/lint-style.mjs（有问题时列出行号并以 1 退出）。确实要特殊值的行，行尾写 /* lint-ok 原因 */
import { readFileSync } from 'node:fs';

const file = new URL('../public/style.css', import.meta.url);
const lines = readFileSync(file, 'utf8').split('\n');
const RULES = [
  ['字号', /(?<![\w-])font-size:\s*([^;}]+)/g, v => /^var\(--fs-\w+\)$|^[\d.]+em$/.test(v), '用 --fs-display/title/sub/body/aux/note'],
  ['字重', /(?<![\w-])font-weight:\s*([^;}]+)/g, v => ['400', '600', '800'].includes(v), '只用 400 / 600 / 800'],
  ['间距', /(?<![\w-])(?:margin|padding|gap|row-gap|column-gap)(?:-top|-right|-bottom|-left)?:\s*([^;}]+)/g,
    v => !v.replace(/calc\(\(100% - 680px\)[^)]*\)/g, '').match(/(?<![\w.-])-?(?!0px|1px)\d+(\.\d+)?px/), '用 --s1…--s6（4/8/12/16/24/32）'],
  ['圆角', /(?<![\w-])border-radius:\s*([^;}]+)/g, v => /^(var\(--r-\w+\)|50%|0)$/.test(v), '用 --r-xl/lg/md/sm/pill 或 50%'],
  ['文字颜色', /(?<![\w-])color:\s*([^;}]+)/g, v => /^(var\(--[\w-]+\)|inherit|currentColor|transparent|#fff)$/.test(v), '用 var(--ink)/var(--muted) 等颜色变量'],
];
let bad = 0;
lines.forEach((line, i) => {
  if (line.includes('lint-ok') || /^\s*--/.test(line) || line.includes('@font-face')) return;
  for (const [name, re, ok, tip] of RULES) {
    for (const m of line.matchAll(re)) {
      const v = m[1].trim().replace(/\s*!important$/, '');
      if (v.startsWith('var(--') && name !== '间距' || ok(v)) continue;
      console.log(`style.css:${i + 1}  ${name}「${v}」→ ${tip}`); bad++;
    }
  }
});
console.log(bad ? `\n${bad} 处不合规` : '样式检查通过：字号、字重、间距、圆角、文字颜色都用的是变量');
process.exit(bad ? 1 : 0);
