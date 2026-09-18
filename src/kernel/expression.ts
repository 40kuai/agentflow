export type Facts = Record<string, unknown> & {
  __functions?: Record<string, (arg: unknown, facts: Facts) => unknown>;
};

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ---------- 词法分析 ----------

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'str'; value: string; pos: number }
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'];
const ALLOWED_FUNCTIONS = new Set(['all', 'any', 'count', 'deps']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new ExpressionError(`第 ${i} 个字符处字符串未闭合`);
      tokens.push({ kind: 'str', value: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      const raw = src.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new ExpressionError(`第 ${i} 个字符处数字非法："${raw}"`);
      tokens.push({ kind: 'num', value, pos: i });
      i = j;
      continue;
    }
    // 起点允许 '.'：函数调用后的尾随属性访问（如 deps(x).a.b）会以 ".a.b" 的形式成为 ident 记号
    if (/[A-Za-z_.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    const matched = OPERATORS.find((op) => src.startsWith(op, i));
    if (matched) {
      tokens.push({ kind: 'op', value: matched, pos: i });
      i += matched.length;
      continue;
    }
    throw new ExpressionError(`第 ${i} 个字符处出现非法字符 "${ch}"`);
  }
  tokens.push({ kind: 'eof', pos: src.length });
  return tokens;
}

// ---------- 语法分析 ----------

type Ast =
  | { k: 'lit'; v: number | string | boolean }
  | { k: 'ref'; head: { fn: string; args: Ast[] } | null; path: string[] }
  | { k: 'not'; e: Ast }
  | { k: 'bin'; op: string; l: Ast; r: Ast };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const t = this.tokens[this.pos]!;
    this.pos += 1;
    return t;
  }

  parse(): Ast {
    const e = this.parseOr();
    const t = this.peek();
    if (t.kind !== 'eof') {
      throw new ExpressionError(`第 ${t.pos} 个字符处存在无法解析的剩余内容`);
    }
    return e;
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.peek().kind === 'ident' && (this.peek() as { value: string }).value === 'or') {
      this.next();
      left = { k: 'bin', op: 'or', l: left, r: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseNot();
    while (this.peek().kind === 'ident' && (this.peek() as { value: string }).value === 'and') {
      this.next();
      left = { k: 'bin', op: 'and', l: left, r: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Ast {
    const t = this.peek();
    if (t.kind === 'ident' && t.value === 'not') {
      this.next();
      return { k: 'not', e: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const left = this.parsePrimary();
    const t = this.peek();
    if (t.kind === 'op' && OPERATORS.includes(t.value)) {
      this.next();
      const right = this.parsePrimary();
      return { k: 'bin', op: t.value, l: left, r: right };
    }
    return left;
  }

  private parsePrimary(): Ast {
    const t = this.next();
    if (t.kind === 'num') return { k: 'lit', v: t.value };
    if (t.kind === 'str') return { k: 'lit', v: t.value };
    if (t.kind === 'op' && t.value === '(') {
      const inner = this.parseOr();
      const close = this.next();
      if (close.kind !== 'op' || close.value !== ')') {
        throw new ExpressionError(`第 ${close.pos} 个字符处缺少右括号`);
      }
      return inner;
    }
    if (t.kind === 'ident') {
      if (t.value === 'true') return { k: 'lit', v: true };
      if (t.value === 'false') return { k: 'lit', v: false };
      if (t.value === 'and' || t.value === 'or' || t.value === 'not') {
        throw new ExpressionError(`第 ${t.pos} 个字符处关键字 "${t.value}" 位置不合法`);
      }

      const head = this.tryParseCallHeader(t);
      if (head.fn) {
        return { k: 'ref', head: { fn: head.fn, args: head.args }, path: head.trailingPath };
      }
      return { k: 'ref', head: null, path: t.value.split('.') };
    }
    throw new ExpressionError(`第 ${t.pos} 个字符处表达式不完整或非法`);
  }

  /** 处理 `fn(arg1).a.b` 形式；非函数调用时返回 fn=null */
  private tryParseCallHeader(
    ident: Token & { kind: 'ident' },
  ): { fn: string | null; args: Ast[]; trailingPath: string[] } {
    if (this.peek().kind !== 'op' || (this.peek() as { value: string }).value !== '(') {
      return { fn: null, args: [], trailingPath: [] };
    }
    if (!ALLOWED_FUNCTIONS.has(ident.value)) {
      throw new ExpressionError(
        `第 ${ident.pos} 个字符处不允许调用函数 "${ident.value}"；只允许 ${[...ALLOWED_FUNCTIONS].join(' / ')}`,
      );
    }
    this.next(); // 消费 '('
    const args: Ast[] = [];
    if (!(this.peek().kind === 'op' && (this.peek() as { value: string }).value === ')')) {
      args.push(this.parseOr());
      while (this.peek().kind === 'op' && (this.peek() as { value: string }).value === ',') {
        this.next();
        args.push(this.parseOr());
      }
    }
    const close = this.next();
    if (close.kind !== 'op' || close.value !== ')') {
      throw new ExpressionError(`第 ${close.pos} 个字符处缺少右括号`);
    }

    const trailing: string[] = [];
    while (this.peek().kind === 'ident' && (this.peek() as { value: string }).value.startsWith('.')) {
      const part = this.next() as Token & { kind: 'ident' };
      for (const seg of part.value.split('.')) {
        if (seg) trailing.push(seg);
      }
    }
    return { fn: ident.value, args, trailingPath: trailing };
  }
}

// ---------- 求值 ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 逐级解析路径；遇到数组则映射其元素的后续属性 */
function resolvePath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const seg of path) {
    if (Array.isArray(current)) {
      current = current.map((item) => {
        if (!isPlainObject(item)) return undefined;
        return item[seg];
      });
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[seg];
  }
  return current;
}

function toBoolArray(value: unknown, context: string): boolean[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'boolean')) {
    throw new ExpressionError(`${context} 需要一个布尔数组，实际得到 ${JSON.stringify(value)}`);
  }
  return value;
}

function evalValue(ast: Ast, facts: Facts): unknown {
  switch (ast.k) {
    case 'lit':
      return ast.v;

    case 'ref': {
      let base: unknown;
      if (ast.head) {
        const argValues = ast.head.args.map((a) => evalValue(a, facts));

        // all / any / count 是内置函数，不走 __functions 注册表
        if (ast.head.fn === 'all' || ast.head.fn === 'any' || ast.head.fn === 'count') {
          if (argValues.length !== 1) {
            throw new ExpressionError(`${ast.head.fn}() 只接受 1 个参数`);
          }
          const bools = toBoolArray(argValues[0], `${ast.head.fn}()`);
          if (ast.head.fn === 'all') return bools.every(Boolean);
          if (ast.head.fn === 'any') return bools.some(Boolean);
          return bools.filter(Boolean).length;
        }

        const fn = facts.__functions?.[ast.head.fn];
        if (!fn) throw new ExpressionError(`未注册的函数 "${ast.head.fn}"`);
        base = fn(argValues.length === 1 ? argValues[0] : argValues, facts);
      } else {
        base = facts;
      }
      const resolved = resolvePath(base, ast.path);
      if (resolved === undefined) {
        throw new ExpressionError(`路径 "${ast.path.join('.')}" 解析结果为空`);
      }
      return resolved;
    }

    case 'not': {
      const v = evalValue(ast.e, facts);
      if (typeof v !== 'boolean') throw new ExpressionError('not 只能作用于布尔值');
      return !v;
    }

    case 'bin': {
      if (ast.op === 'and' || ast.op === 'or') {
        const l = evalValue(ast.l, facts);
        const r = evalValue(ast.r, facts);
        if (typeof l !== 'boolean' || typeof r !== 'boolean') {
          throw new ExpressionError(`${ast.op} 两侧必须是布尔值`);
        }
        return ast.op === 'and' ? l && r : l || r;
      }

      const l = evalValue(ast.l, facts);
      const r = evalValue(ast.r, facts);
      return compare(ast.op, l, r);
    }
  }
}

function scalarCompare(op: string, l: unknown, r: unknown): boolean {
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '>':
      return typeof l === 'number' && typeof r === 'number' && l > r;
    case '<':
      return typeof l === 'number' && typeof r === 'number' && l < r;
    case '>=':
      return typeof l === 'number' && typeof r === 'number' && l >= r;
    case '<=':
      return typeof l === 'number' && typeof r === 'number' && l <= r;
    default:
      throw new ExpressionError(`不支持的运算符 "${op}"`);
  }
}

/** 数组广播：任一侧为数组时，逐元素比较并返回布尔数组 */
function compare(op: string, l: unknown, r: unknown): boolean | boolean[] {
  if (Array.isArray(l) && Array.isArray(r)) {
    if (l.length !== r.length) {
      throw new ExpressionError(`数组长度不一致，无法逐元素比较（${l.length} vs ${r.length}）`);
    }
    return l.map((lv, idx) => scalarCompare(op, lv, r[idx]));
  }
  if (Array.isArray(l)) return l.map((lv) => scalarCompare(op, lv, r));
  if (Array.isArray(r)) return r.map((rv) => scalarCompare(op, l, rv));
  return scalarCompare(op, l, r);
}

/**
 * 求值受限表达式。
 * 只支持文档化的语法子集：不做任意 JS 求值，因此不存在注入风险。
 */
export function evaluateExpression(src: string, facts: Facts): boolean {
  const ast = new Parser(tokenize(src)).parse();
  const value = evalValue(ast, facts);
  if (typeof value !== 'boolean') {
    throw new ExpressionError(`表达式 "${src}" 求值结果为非布尔值（${JSON.stringify(value)}）`);
  }
  return value;
}