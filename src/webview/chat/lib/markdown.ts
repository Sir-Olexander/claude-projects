import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { parsePathRef } from './paths';

const languages: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile,
  markdown, php, plaintext, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx', 'mts', 'cts'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['html', 'svg', 'vue', 'xhtml', 'plist'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rb'], { languageName: 'ruby' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['toml', 'env', 'properties'], { languageName: 'ini' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['text', 'txt', 'log', 'output'], { languageName: 'plaintext' });
hljs.registerAliases(['kt'], { languageName: 'kotlin' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['h', 'hpp', 'cc'], { languageName: 'cpp' });
hljs.registerAliases(['docker'], { languageName: 'dockerfile' });

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  md: 'markdown', mdx: 'markdown', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
};

/** highlight.js language for a file path, if we know one. */
export function languageForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_LANG[ext];
}

/** Syntax-highlights code and returns HTML (escaped when the language is unknown). */
export function highlight(code: string, language?: string): string {
  const lang = language?.toLowerCase();
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through
    }
  }
  return escapeHtml(code);
}

/** Highlights a single line in isolation (used by diff views). Keeps output short-circuit for huge lines. */
export function highlightLine(line: string, language?: string): string {
  if (!language || line.length > 2000) return escapeHtml(line);
  return highlight(line, language);
}

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang || '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      const body = highlight(text.replace(/\n$/, ''), language || undefined);
      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '<span class="code-lang"></span>';
      return (
        `<div class="code-block">` +
        `<div class="code-block-bar">${label}<button class="code-copy" data-action="copy-code" title="Copy code" aria-label="Copy code"><i class="codicon codicon-copy"></i></button></div>` +
        `<pre><code class="hljs">${body}</code></pre></div>`
      );
    },
    codespan({ text }: Tokens.Codespan): string {
      const ref = parsePathRef(text);
      if (ref) {
        return `<code class="file-ref" data-path="${escapeHtml(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ''} title="Open ${escapeHtml(ref.path)}">${escapeHtml(text)}</code>`;
      }
      return `<code>${escapeHtml(text)}</code>`;
    },
    table(token: Tokens.Table): string | false {
      // Wrap tables so wide ones scroll horizontally instead of overflowing.
      const head = token.header.map((cell) => `<th${cell.align ? ` style="text-align:${cell.align}"` : ''}>${this.parser.parseInline(cell.tokens)}</th>`).join('');
      const rows = token.rows
        .map((row) => `<tr>${row.map((cell) => `<td${cell.align ? ` style="text-align:${cell.align}"` : ''}>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`)
        .join('');
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noreferrer');
  }
});

const cache = new Map<string, string>();
const CACHE_LIMIT = 400;

/** Markdown -> sanitized HTML. Results are cached by source text. */
export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) {
    // refresh LRU position
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  let html: string;
  try {
    html = marked.parse(src, { async: false }) as string;
  } catch {
    html = `<p>${escapeHtml(src)}</p>`;
  }
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'script'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  }) as unknown as string;
  if (src.length < 200_000) {
    cache.set(src, clean);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return clean;
}
