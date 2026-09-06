/**
 * 阅读时长估算。
 *
 * 规则：
 * - 围栏代码块（``` / ~~~）整段剔除，不参与计数——代码是「看」的，不是「读」的；
 * - 中文按字数计（约 400 字/分钟），拉丁词按词数计（约 200 词/分钟）；
 * - 结果向上取整到分钟，最少 1 分钟。
 */

/** 中文阅读速度：字/分钟 */
const CJK_CPM = 400;
/** 拉丁文阅读速度：词/分钟（技术词汇偏慢） */
const LATIN_WPM = 200;

/** CJK 统一表意文字 + 扩展 A + 兼容表意 + 假名（顺手覆盖日文） */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** 拉丁词：字母/数字开头，可含撇号、连字符、下划线 */
const LATIN_RE = /[A-Za-z0-9][A-Za-z0-9'’\-_]*/g;

export interface ReadingTime {
  /** 展示用分钟数：向上取整，最少 1 */
  minutes: number;
  /** 未取整的精确分钟数 */
  exactMinutes: number;
  /** 剔除代码块后的中文字数 */
  cjkCount: number;
  /** 剔除代码块后的拉丁词数 */
  wordCount: number;
  /** 展示文案，如「约 8 分钟」 */
  label: string;
}

/**
 * 剔除 Markdown 围栏代码块（含未闭合的尾部代码块）。
 * 逐行状态机实现，避免正则回溯，也避免把代码里的 ``` 误当围栏外的正文。
 */
export function stripFencedCode(body: string): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  let fenceChar = '';
  let fenceLength = 0;

  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1];
      if (!fenceChar) {
        // 开栏：记录字符与长度，关闭围栏须同字符且不短于开栏
        fenceChar = marker[0];
        fenceLength = marker.length;
        kept.push('');
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLength) {
        fenceChar = '';
        fenceLength = 0;
      }
      // 围栏内的 ``` 只当代码内容，丢弃
      kept.push('');
      continue;
    }
    kept.push(fenceChar ? '' : line);
  }

  return kept.join('\n');
}

/** 若正文以 frontmatter 开头则剔除（glob loader 通常已剥离，这里兜底） */
function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return body;
  const nextLine = body.indexOf('\n', end + 1);
  return nextLine === -1 ? '' : body.slice(nextLine + 1);
}

/** 剔除围栏代码块后的正文 */
export function readableBody(body: string): string {
  return stripFencedCode(stripFrontmatter(body));
}

/** 估算阅读时长 */
export function readingTime(body: string): ReadingTime {
  const text = readableBody(body);
  const cjkCount = (text.match(CJK_RE) ?? []).length;
  const wordCount = (text.match(LATIN_RE) ?? []).length;
  const exactMinutes = cjkCount / CJK_CPM + wordCount / LATIN_WPM;
  const minutes = Math.max(1, Math.ceil(exactMinutes));

  return {
    minutes,
    exactMinutes,
    cjkCount,
    wordCount,
    label: `约 ${minutes} 分钟`,
  };
}
