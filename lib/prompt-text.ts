import { Lexer } from 'marked';
import type { MarkedToken, Token } from 'marked';
import { comparableText } from './domain';

export type PromptComparison = { literal: string; rendered: string | null };

// 只读取 Markdown 语法树中的文本，不生成或执行 HTML，不改写待保存的原文。
function visibleMarkdown(tokens: Token[]): string | null {
  let result = '';
  for (const token of tokens) {
    const value = token as MarkedToken;
    switch (value.type) {
      case 'space': case 'br': case 'hr': result += '\n'; break;
      case 'def': break;
      case 'code': result += `\n${value.text}\n`; break;
      case 'codespan': case 'escape': result += value.text; break;
      case 'text': {
        const text = value.tokens ? visibleMarkdown(value.tokens) : value.text;
        if (text === null) return null;
        result += text;
        break;
      }
      case 'paragraph': case 'heading': case 'blockquote': case 'list_item':
      case 'strong': case 'em': case 'del': case 'link': {
        const text = visibleMarkdown(value.tokens);
        if (text === null) return null;
        result += ['paragraph', 'heading', 'blockquote', 'list_item'].includes(value.type) ? `\n${text}\n` : text;
        break;
      }
      case 'list': {
        result += '\n';
        for (const item of value.items) {
          if (item.task) return null;
          const text = visibleMarkdown(item.tokens);
          if (text === null) return null;
          result += `${text}\n`;
        }
        break;
      }
      case 'table': {
        result += '\n';
        for (const row of [value.header, ...value.rows]) {
          for (const cell of row) {
            const text = visibleMarkdown(cell.tokens);
            if (text === null) return null;
            result += `${text}\n`;
          }
        }
        break;
      }
      // 附件与 HTML 不在首版纯文本范围；不猜测这些内容渲染后的含义。
      default: return null;
    }
  }
  return result;
}

export function preparePromptComparison(text: string): PromptComparison {
  let rendered: string | null = null;
  try {
    const projection = visibleMarkdown(Lexer.lex(text));
    if (projection !== null) rendered = comparableText(projection);
  } catch {
    // 无法解析时继续允许原文精确比对，不记录可能含原文的解析异常。
  }
  return { literal: comparableText(text), rendered };
}

export function matchesPromptText(actual: string, expected: PromptComparison): boolean {
  const normalized = comparableText(actual);
  return normalized === expected.literal || (expected.rendered !== null && normalized === expected.rendered);
}
