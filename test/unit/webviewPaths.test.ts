import { describe, expect, it } from 'vitest';
import { classifyHref, displayPath, parsePathRef } from '../../src/webview/chat/lib/paths';

describe('chat paths', () => {
  it('shortens macOS/Linux paths', () => {
    expect(displayPath('/Users/x/proj/src/a.ts', '/Users/x/proj')).toBe('src/a.ts');
    expect(displayPath('/Users/x/proj', '/Users/x/proj/')).toBe('.');
    expect(displayPath('/Users/x/other/b.ts', '/Users/x/proj')).toBe('~/other/b.ts');
    expect(displayPath('/Users/x/project2/b.ts', '/Users/x/proj')).toBe('~/project2/b.ts');
    expect(displayPath('/etc/hosts', '/Users/x/proj')).toBe('/etc/hosts');
  });

  it('shortens Windows paths, whatever the slashes and case', () => {
    const cwd = 'C:\\Users\\x\\proj';
    expect(displayPath('C:\\Users\\x\\proj\\src\\a.ts', cwd)).toBe('src\\a.ts');
    expect(displayPath('c:/Users/x/proj/src/a.ts', cwd)).toBe('src/a.ts');
    expect(displayPath('C:\\Users\\x\\proj', cwd)).toBe('.');
    expect(displayPath('C:\\Users\\x\\other\\b.ts', cwd)).toBe('~\\other\\b.ts');
    expect(displayPath('D:\\data\\b.ts', cwd)).toBe('D:\\data\\b.ts');
  });

  it('recognizes Windows file references and links', () => {
    expect(parsePathRef('C:\\Users\\x\\proj\\src\\a.ts:12')).toEqual({ path: 'C:\\Users\\x\\proj\\src\\a.ts', line: 12 });
    expect(parsePathRef('src\\Makefile')).toEqual({ path: 'src\\Makefile', line: undefined });
    expect(classifyHref('file:///C:/Users/x/a.ts')).toEqual({ kind: 'file', ref: { path: 'C:/Users/x/a.ts', line: undefined } });
    expect(classifyHref('C:\\Users\\x\\a.ts')).toEqual({ kind: 'file', ref: { path: 'C:\\Users\\x\\a.ts', line: undefined } });
    expect(classifyHref('slack:open')).toBeUndefined();
  });
});
