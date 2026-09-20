/**
 * AgentFlow 项目官网（单页中文静态落地页）验收测试
 *
 * 对应需求「创业项目官网」的验收标准：
 *  AC1 单页中文静态落地页（不替代 docs 文档站、不是观测面板）
 *  AC2 站点位于仓库根新建的独立目录 website/（不污染其他既有目录）
 *  AC3 纯静态、零依赖、零构建：无 npm 依赖、无 CDN 资源、断网可打开、无需安装/打包
 *  AC4 内容骨架完整：Hero / ≥4 痛点 / 三条设计原则 / 核心机制 / 架构分层 / 12 角色 /
 *      技术栈 / Phase 0–5 路线图 / 快速开始 / 页脚
 *  AC5 内容 100% 可溯源 + 进度如实标注（Phase 0/1 已完成、Phase 2+ 规划中）
 *  AC6 对仓库其余内容零改动（web/ src/ config/ docs/ 记录.md 根 package.json 未被接线改动）
 *
 * 说明：本测试只读取文件，不修改仓库任何内容；事实核对以 docs/ 设计文档、记录.md、
 * 以及仓库真实配置（package.json / .env.example / config/roles / src/shared/artifacts.ts）为准。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 需求指定的交付位置：仓库根 /website */
const CANONICAL_DIR = path.join(REPO_ROOT, 'website');
/** 实际交付位置（若根 website/ 存在则优先使用它） */
const DELIVERED_DIR = existsSync(path.join(CANONICAL_DIR, 'index.html'))
  ? CANONICAL_DIR
  : path.join(REPO_ROOT, 'src', 'website');

const readAt = (dir: string, ...rel: string[]): string => readFileSync(path.join(dir, ...rel), 'utf8');

const HTML = readAt(DELIVERED_DIR, 'index.html');
const CSS = readAt(DELIVERED_DIR, 'assets', 'style.css');
const JS = readAt(DELIVERED_DIR, 'assets', 'app.js');

const DESIGN_DOC = readAt(
  REPO_ROOT,
  'docs/superpowers/specs/2026-09-18-multi-agent-dev-orchestration-design.md',
);
const ENV_EXAMPLE = readAt(REPO_ROOT, '.env.example');
const ROOT_PKG = JSON.parse(readAt(REPO_ROOT, 'package.json')) as { scripts: Record<string, string>; engines: { node: string } };
const MAIN_TS = readAt(REPO_ROOT, 'src', 'main.ts');

// ---------------------------------------------------------------- 工具函数

const count = (haystack: string, re: RegExp): number => (haystack.match(re) ?? []).length;

const stripTags = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** 去掉 script/style 后的可见文本 */
const VISIBLE_TEXT = stripTags(
  HTML.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' '),
);

/** 所有 <section id="x"> 到下一个 section 之间的片段 */
function sectionChunks(src: string): Record<string, string> {
  const marks: Array<{ id: string; start: number }> = [];
  const re = /<section\b[^>]*\bid="([^"]+)"/g;
  let m = re.exec(src);
  while (m !== null) {
    marks.push({ id: m[1] ?? '', start: m.index });
    m = re.exec(src);
  }
  const out: Record<string, string> = {};
  marks.forEach((mark, i) => {
    const next = marks[i + 1];
    out[mark.id] = src.slice(mark.start, next ? next.start : src.length);
  });
  return out;
}
const SECTIONS = sectionChunks(HTML);

function listFilesRec(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRec(full));
    else out.push(full);
  }
  return out;
}
const SITE_FILES = listFilesRec(DELIVERED_DIR).map((f) => path.relative(DELIVERED_DIR, f).split(path.sep).join('/'));

/** 提取 HTML 里所有 src/href/url() 引用值 */
function assetRefs(src: string): string[] {
  const refs: string[] = [];
  for (const m of src.matchAll(/\b(?:src|href)="([^"]*)"/g)) if (m[1]) refs.push(m[1]);
  for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) if (m[1]) refs.push(m[1].trim());
  return refs;
}

const ROLE_IDS = (fragment: string): string[] =>
  [...fragment.matchAll(/<td><code>([a-z_]+)<\/code><\/td>/g)].map((m) => m[1] as string);

// ================================================================ AC1 单页中文静态落地页

describe('AC1 单页中文静态落地页', () => {
  it('交付物是单一 HTML 页面（站点目录内只有一个 .html 文件）', () => {
    const htmlFiles = SITE_FILES.filter((f) => f.endsWith('.html'));
    expect(htmlFiles).toEqual(['index.html']);
  });

  it('是完整可独立打开的 HTML 文档（doctype / lang=zh-CN / charset / title / 唯一 h1）', () => {
    expect(HTML.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(HTML).toMatch(/<html[^>]*lang="zh-CN"/);
    expect(HTML).toMatch(/<meta[^>]*charset="utf-8"/i);
    expect(HTML).toMatch(/<meta[^>]*name="viewport"/);
    const title = /<title>([^<]*)<\/title>/.exec(HTML)?.[1] ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(count(HTML, /<h1[\s>]/g)).toBe(1);
    expect(count(HTML, /<meta[^>]*name="description"[^>]*content="[^"]{20,}"/g)).toBe(1);
  });

  it('正文以中文为主，且不依赖 JavaScript 呈现核心内容（禁用脚本内容仍在 HTML 里）', () => {
    const cjk = count(VISIBLE_TEXT, /[\u4e00-\u9fa5]/g);
    const latin = count(VISIBLE_TEXT, /[A-Za-z]/g);
    expect(cjk).toBeGreaterThan(1000);
    expect(cjk / (cjk + latin)).toBeGreaterThan(0.5);
    // 正文文本直接存在于静态 HTML 中（非运行时注入）：无 JS 也能读到核心信息
    for (const keyword of ['多 Agent 开发流程编排平台', 'Phase 0', '工作包', '快速开始']) {
      expect(VISIBLE_TEXT).toContain(keyword);
    }
    // 页面没有靠脚本渲染的占位壳（如 <div id="root">）
    expect(HTML).not.toMatch(/<div[^>]*id="(root|app)"/);
  });

  it('页内锚点无死链（每个 href="#x" 都能找到对应 id）', () => {
    const anchors = [...HTML.matchAll(/href="#([^"]+)"/g)].map((m) => m[1] as string);
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(HTML, `锚点 #${a} 无对应元素`).toMatch(new RegExp(`id="${a}"`));
    }
  });

  it('HTML 标签闭合平衡（页面结构完整可解析）', () => {
    const tags = [
      'html', 'head', 'body', 'header', 'footer', 'main', 'nav', 'section', 'article',
      'div', 'span', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
      'tr', 'td', 'th', 'caption', 'pre', 'code', 'strong', 'em', 'a', 'h1', 'h2', 'h3', 'h4', 'script',
    ];
    const unbalanced: Record<string, number> = {};
    for (const tag of tags) {
      const open = count(HTML, new RegExp(`<${tag}(?=[\\s>])`, 'g'));
      const close = count(HTML, new RegExp(`</${tag}>`, 'g'));
      if (open !== close) unbalanced[tag] = open - close;
    }
    expect(unbalanced).toEqual({});
  });

  it('CSS 花括号平衡、JavaScript 可解析（无语法错误）', () => {
    expect(count(CSS, /\{/g)).toBe(count(CSS, /\}/g));
    expect(() => new Function(JS)).not.toThrow();
  });
});

// ================================================================ AC2 交付位置

describe('AC2 站点位于仓库根独立目录 website/', () => {
  it('站点位于仓库根新建的独立目录 website/，未落进 src/ 等既有目录', () => {
    const violations: string[] = [];
    if (!existsSync(path.join(CANONICAL_DIR, 'index.html'))) {
      violations.push(`仓库根不存在 website/index.html（需求指定交付位置：${CANONICAL_DIR}）`);
    }
    const topDir = path.relative(REPO_ROOT, DELIVERED_DIR).split(path.sep)[0] ?? '';
    if (['src', 'web', 'config', 'docs', 'tests'].includes(topDir)) {
      violations.push(`站点实际落进既有目录 ${topDir}/（${path.relative(REPO_ROOT, DELIVERED_DIR)}）`);
    }
    expect(violations).toEqual([]);
  });

  it('站点目录自包含（不引用站点目录之外的仓库文件）', () => {
    const escaping = assetRefs(HTML).filter((r) => r.includes('/') && !r.startsWith('#') && !r.startsWith('mailto:'));
    for (const ref of escaping) {
      expect(ref.startsWith('..'), `资源引用逃出站点目录：${ref}`).toBe(false);
      if (!/^[a-z]+:/i.test(ref)) {
        expect(SITE_FILES, `本地资源缺失：${ref}`).toContain(ref);
      }
    }
  });
});

// ================================================================ AC3 零依赖 / 零构建 / 可离线

describe('AC3 纯静态、零依赖、零构建、断网可打开', () => {
  it('HTML/CSS/JS 中不存在任何 http(s) 外部资源引用（无 CDN、无外链字体）', () => {
    const refs = assetRefs(`${HTML}\n${CSS}\n${JS}`);
    expect(refs.length, '未提取到任何资源引用，断言会假通过').toBeGreaterThan(2);
    const remote = refs.filter((r) => /^(https?:)?\/\//i.test(r) || /^[a-z]+:\/\//i.test(r));
    expect(remote, `存在外部资源引用：${remote.join(', ')}`).toEqual([]);
    expect(CSS).not.toMatch(/@import/i);
    expect(CSS).not.toMatch(/@font-face/i);
  });

  it('站点目录内没有 npm 依赖与构建产物（无 package.json / node_modules / 构建配置）', () => {
    expect(SITE_FILES.length, '站点目录为空').toBeGreaterThan(0);
    const forbidden = SITE_FILES.filter((f) =>
      /(^|\/)package(-lock)?\.json$/.test(f) ||
      f.includes('node_modules') ||
      /(^|\/)(vite|webpack|rollup|parcel|tsconfig|babel)\.(config\.)?(js|ts|json|mjs|cjs)$/.test(f) ||
      /\.min\.(js|css)$/.test(f),
    );
    expect(forbidden).toEqual([]);
  });

  it('脚本不做任何网络请求，且引用全部为相对路径（file:// 直接打开可用）', () => {
    expect(JS).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon|import\s*\(/);
    const refs = assetRefs(HTML).filter((r) => !r.startsWith('#'));
    expect(refs.length, '未提取到任何资源引用，断言会假通过').toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('/'), `绝对路径在 file:// 下会失效：${ref}`).toBe(false);
    }
  });

  it('外部样式与脚本均为本文件，且文件真实存在', () => {
    expect(HTML).toMatch(/<link[^>]*rel="stylesheet"[^>]*href="assets\/style\.css"/);
    expect(HTML).toMatch(/<script[^>]*src="assets\/app\.js"[^>]*>/);
    expect(SITE_FILES).toContain('assets/style.css');
    expect(SITE_FILES).toContain('assets/app.js');
  });
});

// ================================================================ AC4 内容骨架

describe('AC4 页面内容骨架完整', () => {
  it('Hero 说明项目定位（标题 + 一句话说明）', () => {
    const hero = SECTIONS['top'] ?? '';
    expect(hero.length).toBeGreaterThan(0);
    expect(stripTags(hero)).toContain('多 Agent 开发流程编排平台');
    expect(count(hero, /<h1[\s>]/g)).toBe(1);
    expect(stripTags(hero).length).toBeGreaterThan(150);
  });

  it('痛点不少于 4 条，且编号连续无占位', () => {
    const problem = SECTIONS['problem'] ?? '';
    const pains = count(problem, /class="card pain"/g);
    expect(pains).toBeGreaterThanOrEqual(4);
    const nos = [...problem.matchAll(/class="pain-no">(\d+)</g)].map((m) => m[1] as string);
    expect(nos).toEqual(Array.from({ length: pains }, (_, i) => String(i + 1).padStart(2, '0')));
    for (const card of problem.split('class="card pain"').slice(1)) {
      expect(stripTags(card).length, '痛点卡片内容过短，疑似占位').toBeGreaterThan(20);
    }
  });

  it('三条决定性设计原则齐备（数量恰好为 3）', () => {
    const principles = SECTIONS['principles'] ?? '';
    expect(count(principles, /class="card principle"/g)).toBe(3);
    const text = stripTags(principles);
    expect(text).toContain('唯一状态真相');
    expect(text).toContain('零自由对话');
  });

  it('核心机制六项齐全（事件真相 / 零自由对话 / 工作包并行 / G0–G3 / 三档 profile / 可观测）', () => {
    const mech = SECTIONS['mechanisms'] ?? '';
    expect(count(mech, /class="card mech"/g)).toBe(6);
    const headings = [...mech.matchAll(/<h3><span class="dot[^"]*"><\/span>([^<]+)<\/h3>/g)].map((m) =>
      stripTags(m[1] ?? ''),
    );
    expect(headings.length).toBe(6);
    const joined = headings.join('|');
    for (const kw of ['事件存储是唯一状态真相', '结构化产物', '工作包并行', 'G0–G3', '三档 profile', '可观测']) {
      expect(joined, `核心机制缺少「${kw}」`).toContain(kw);
    }
  });

  it('架构分层四层齐备（观测前端 / 编排内核 / Runner / 存储）', () => {
    const arch = SECTIONS['architecture'] ?? '';
    expect(count(arch, /class="layer(?: [a-z-]+)?"/g)).toBe(4);
    const text = stripTags(arch);
    for (const layer of ['观测前端', '编排内核', 'Runner Pool', '存储']) {
      expect(text, `架构分层缺少「${layer}」`).toContain(layer);
    }
  });

  it('角色组织：表格恰好 12 个角色，与设计文档默认组织架构一致', () => {
    const roles = SECTIONS['roles'] ?? '';
    const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(roles)?.[1] ?? '';
    const ids = ROLE_IDS(tbody);
    expect(ids.length, `页面角色表格只有 ${ids.length} 个角色`).toBe(12);
    expect(new Set(ids).size).toBe(12);

    const docIds = [...DESIGN_DOC.matchAll(/^\|\s*(?:决策|产品|技术|开发|质量|交付|平台)\s*\|\s*`([a-z_]+)`/gm)]
      .map((m) => m[1] as string)
      .filter((id) => id !== 'orchestrator');
    expect(docIds.length).toBe(12);
    expect([...ids].sort()).toEqual([...docIds].sort());
    // orchestrator 非人角色需在表外说明，不占角色编制
    expect(stripTags(roles)).toContain('orchestrator');
  });

  it('技术栈段落覆盖后端 / HTTP / 存储 / 校验 / 前端', () => {
    const stack = SECTIONS['stack'] ?? '';
    const text = stripTags(stack);
    for (const kw of ['Node 22', 'Fastify', 'SQLite', 'zod', 'React 18']) {
      expect(text, `技术栈缺少「${kw}」`).toContain(kw);
    }
    expect(count(stack, /class="card tech"/g)).toBeGreaterThanOrEqual(4);
  });

  it('Phase 0–5 路线图完整（六个阶段各一条，含验收标准）', () => {
    const roadmap = SECTIONS['roadmap'] ?? '';
    const phases = [...roadmap.matchAll(/class="tl-phase">(Phase \d)</g)].map((m) => m[1] as string);
    expect(phases).toEqual(['Phase 0', 'Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5']);
    expect(count(roadmap, /class="tl-accept"/g)).toBeGreaterThanOrEqual(5);
  });

  it('快速开始可执行：安装 / 配置 / 启动 / 质量门命令齐备', () => {
    const start = SECTIONS['start'] ?? '';
    const text = stripTags(start);
    for (const kw of ['npm install', 'cp .env.example .env', 'npm run dev', 'npm start', 'npm test', 'npm run typecheck']) {
      expect(text, `快速开始缺少命令「${kw}」`).toContain(kw);
    }
    expect(text).toContain('Node 22');
    expect(text).toContain('.env');
  });

  it('页脚存在，且给出内容溯源与站点说明', () => {
    const footer = /<footer[\s\S]*<\/footer>/.exec(HTML)?.[0] ?? '';
    expect(footer.length).toBeGreaterThan(0);
    const text = stripTags(footer);
    expect(text).toContain('内容溯源');
    const sources = [...footer.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((m) => m[1] as string);
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain('记录.md');
    expect(text).toContain('纯静态');
    expect(text).toMatch(/零依赖|零构建/);
  });

  it('访客 1 分钟内可回答五个问题（导航直达 + 关键结论在首屏附近）', () => {
    const nav = /<nav class="nav-links"[\s\S]*?<\/nav>/.exec(HTML)?.[0] ?? '';
    const navAnchors = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1] as string);
    for (const need of ['problem', 'principles', 'roadmap', 'start']) {
      expect(navAnchors, `导航缺少直达 #${need} 的入口`).toContain(need);
    }
    expect(VISIBLE_TEXT).toContain('它解决什么问题');
    expect(VISIBLE_TEXT).toContain('三条决定性设计原则');
    expect(VISIBLE_TEXT).toContain('Phase 0–5 路线图');
    expect(VISIBLE_TEXT).toContain('快速开始');
  });
});

// ================================================================ AC5 可溯源 + 进度如实标注

describe('AC5 内容可溯源、进度如实标注', () => {
  it('首屏显式标注 Phase 0/1 已完成、Phase 2+ 规划中，并声明内容可溯源', () => {
    const notice = /class="notice"[\s\S]*?<\/p>/.exec(HTML)?.[0] ?? '';
    const text = stripTags(notice);
    expect(text).toContain('Phase 0');
    expect(text).toMatch(/已(完成|实现)/);
    expect(text).toContain('规划中');
    expect(text).toContain('溯源');
    // 首屏统计条同样标注当前进度
    const hero = stripTags(SECTIONS['top'] ?? '');
    expect(hero).toMatch(/Phase 0\/1 已(完成|实现)/);
  });

  it('路线图徽章：Phase 0/1 标「已完成」，Phase 2–5 标「规划中」', () => {
    const roadmap = SECTIONS['roadmap'] ?? '';
    const items = roadmap.split('<li class="tl').slice(1);
    expect(items.length).toBe(6);
    const expected = ['done', 'done', '', '', '', ''];
    const expectedBadge = ['已完成', '已完成', '规划中', '规划中', '规划中', '规划中'];
    items.forEach((item, i) => {
      expect(count(item, /badge-done/g), `Phase ${i} 徽章与进度不符`).toBe(expected[i] === 'done' ? 1 : 0);
      expect(stripTags(item), `Phase ${i} 未如实标注进度`).toContain(expectedBadge[i] as string);
    });
  });

  it('如实说明 Phase 1 的实现边界（串行 / 无路径级强制 / 无 worktree 隔离 / 无 G1–G3）', () => {
    const arch = SECTIONS['architecture'] ?? '';
    const text = stripTags(arch);
    expect(text).toContain('Phase 1 的实现边界');
    expect(text).toContain('串行');
    expect(text).toContain('AGENTFLOW_GLOBAL_CONCURRENCY');
    expect(text).toContain('artifact.invalidated');
    expect(text).toContain('Phase 2+');
  });

  it('环境变量表与仓库 .env.example 完全一致（键名与默认值）', () => {
    const start = SECTIONS['start'] ?? '';
    const table = /<table class="env-table">[\s\S]*?<\/table>/.exec(start)?.[0] ?? '';
    expect(table.length).toBeGreaterThan(0);

    const sitePairs = new Map<string, string>();
    for (const row of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...(row[1] ?? '').matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '');
      if (cells.length < 2) continue;
      const keys = [...cells[0]!.matchAll(/<code>([A-Z_]+)<\/code>/g)].map((m) => m[1] as string);
      const values = [...cells[1]!.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => (m[1] ?? '').trim());
      keys.forEach((k, i) => sitePairs.set(k, values[i] ?? ''));
    }

    const realEnv = new Map<string, string>();
    for (const line of ENV_EXAMPLE.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) realEnv.set(m[1] as string, (m[2] ?? '').trim());
    }

    expect([...sitePairs.keys()].sort()).toEqual([...realEnv.keys()].sort());
    for (const [k, v] of sitePairs) {
      expect(v, `${k} 的默认值与 .env.example 不一致`).toBe(realEnv.get(k));
    }
  });

  it('快速开始命令与根 package.json scripts 一致（未杜撰命令）', () => {
    const start = stripTags(SECTIONS['start'] ?? '');
    const pairs: Array<[string, string]> = [
      ['npm run dev', ROOT_PKG.scripts.dev ?? ''],
      ['npm start', ROOT_PKG.scripts.start ?? ''],
      ['npm test', ROOT_PKG.scripts.test ?? ''],
      ['npm run typecheck', ROOT_PKG.scripts.typecheck ?? ''],
    ];
    for (const [siteCmd, real] of pairs) {
      expect(start, `页面缺少命令 ${siteCmd}`).toContain(siteCmd);
      expect(real.length, `package.json 未定义 ${siteCmd}`).toBeGreaterThan(0);
      expect(start, `${siteCmd} 的实际脚本与 package.json 不符`).toContain(real);
    }
    expect(ROOT_PKG.engines.node).toContain('22');
  });

  it('启动提示与 src/main.ts 实际输出一致，Host/端口与 .env.example 一致', () => {
    const start = stripTags(SECTIONS['start'] ?? '');
    const host = /^AGENTFLOW_HOST=(.*)$/m.exec(ENV_EXAMPLE)?.[1]?.trim() ?? '';
    const port = /^AGENTFLOW_PORT=(.*)$/m.exec(ENV_EXAMPLE)?.[1]?.trim() ?? '';
    expect(MAIN_TS).toContain('AgentFlow 已启动');
    expect(start).toContain('AgentFlow 已启动');
    expect(start).toContain(`${host}:${port}`);
  });

  it('串行基线 simple_dev 用到的角色与 config/roles 实际注册一致，且站内如实标注', () => {
    const registered = readdirSync(path.join(REPO_ROOT, 'config', 'roles'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''))
      .sort();
    // 不写死角色总数：config/roles 会随并行示例增删角色，只要求串行基线用到的角色确实已注册
    const baseline = ['backend_dev', 'pm', 'qa_engineer'];
    for (const id of baseline) {
      expect(registered, `config/roles 缺少串行基线 simple_dev 用到的角色 ${id}`).toContain(id);
    }
    const rolesText = stripTags(SECTIONS['roles'] ?? '');
    expect(rolesText).toContain('只有 3 个');
    for (const id of baseline) expect(rolesText).toContain(id);
  });

  it('声称已实现的 Artifact 类型与 src/shared/artifacts.ts 的 ARTIFACT_TYPES 一致', () => {
    const declared = [...readAt(REPO_ROOT, 'src/shared/artifacts.ts').matchAll(/^\s*'([a-z_]+)',\s*$/gm)].map(
      (m) => m[1] as string,
    );
    expect([...declared].sort()).toEqual(['code_diff', 'requirement', 'test_report', 'work_package_plan']);
    const pageText = VISIBLE_TEXT;
    for (const t of declared) expect(pageText).toContain(t);
    expect(pageText).toContain('只有 4 种');
  });

  it('技术栈选型可溯源到设计文档 §14.1 或仓库真实依赖', () => {
    const stack = stripTags(SECTIONS['stack'] ?? '');
    const pkg = ROOT_PKG as unknown as { dependencies: Record<string, string> };
    const traceable: Record<string, boolean> = {
      'Node 22': true, // §14.1 后端 + package.json engines
      Fastify: '@fastify/websocket' in pkg.dependencies || DESIGN_DOC.includes('| HTTP | Fastify |'),
      'better-sqlite3': 'better-sqlite3' in pkg.dependencies,
      zod: 'zod' in pkg.dependencies,
      'zod-to-json-schema': 'zod-to-json-schema' in pkg.dependencies,
      pino: 'pino' in pkg.dependencies,
      'React 18': DESIGN_DOC.includes('| 前端 | React 18 + Vite + TypeScript |'),
      '@xyflow/react': DESIGN_DOC.includes('| 图渲染 | `@xyflow/react`'),
      Zustand: DESIGN_DOC.includes('| 前端状态 | Zustand |'),
      'Tailwind CSS': DESIGN_DOC.includes('| 样式 | Tailwind CSS |'),
    };
    for (const [kw, ok] of Object.entries(traceable)) {
      expect(stack, `页面技术栈出现「${kw}」`).toContain(kw);
      expect(ok, `页面技术栈「${kw}」无法溯源到设计文档或依赖`).toBe(true);
    }
  });

  it('不虚构市场数据（无市占率 / 客户数 / 融资 / 用户量等编造事实）', () => {
    const forbidden = ['市占', '市场份额', '客户数', '融资', '估值', '用户量', 'DAU', 'MAU', '营收', '亿元', '千万用户', '行业第一', '头部客户'];
    for (const kw of forbidden) {
      expect(VISIBLE_TEXT, `出现疑似虚构事实：${kw}`).not.toContain(kw);
    }
  });

  it('页脚列出的溯源文件在仓库中真实存在', () => {
    const footer = /<footer[\s\S]*<\/footer>/.exec(HTML)?.[0] ?? '';
    const sources = [...footer.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((m) => m[1] as string);
    for (const src of sources) {
      expect(existsSync(path.join(REPO_ROOT, src)), `溯源文件不存在：${src}`).toBe(true);
    }
  });
});

// ================================================================ AC6 零污染

describe('AC6 对仓库其余内容零改动', () => {
  it('需求点名的既有内容（src/ web/ config/ docs/ 记录.md 根配置）中没有一处为站点做的接线改动', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter(
        (rel) =>
          /^(src|web|config|docs|spikes)\//.test(rel) ||
          /^(package\.json|tsconfig\.json|vitest\.config\.ts|\.env\.example|\.gitignore|记录\.md)$/.test(rel),
      );
    expect(tracked.length).toBeGreaterThan(10); // 扫描范围非空，避免空集假通过
    const offenders = tracked.filter((rel) => {
      const content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      return content.includes('src/website') || content.includes('website/index.html');
    });
    expect(offenders, `既有内容被接线改动：${offenders.join(', ')}`).toEqual([]);
  });

  it('本次交付没有把站点接线进任何既有文件（已跟踪文件的改动内容中不含站点引用）', () => {
    const dirty = execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const offenders = dirty.filter((rel) => {
      const diff = execFileSync('git', ['diff', 'HEAD', '--', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
      return /website|官网/.test(diff);
    });
    expect(offenders, `既有文件的改动把站点接线进来：${offenders.join(', ')}`).toEqual([]);
  });

  it('站点目录内没有业务代码或运行时产物（纯静态交付，未混入仓库其他职责）', () => {
    const allowed = /^(index\.html|README\.md|assets\/(style\.css|app\.js))$/;
    const unexpected = SITE_FILES.filter((f) => !allowed.test(f));
    expect(unexpected).toEqual([]);
  });
});