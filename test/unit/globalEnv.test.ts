import { describe, expect, it } from 'vitest';
import { globalEnvPrompt, parseEnv } from '../../src/sessions/globalEnv';

describe('shared .env', () => {
  it('reads the usual .env syntax', () => {
    const env = parseEnv(
      [
        '# comment',
        'API_KEY=sk-123',
        'export SERVER_URL = https://example.com  # trailing comment',
        'QUOTED="a value with # hash"',
        "SINGLE='literal \\n'",
        'MULTI="line one',
        'line two"',
        'EMPTY=',
        'not a line',
      ].join('\n'),
    );
    expect(env.vars).toEqual({
      API_KEY: 'sk-123',
      SERVER_URL: 'https://example.com',
      QUOTED: 'a value with # hash',
      SINGLE: 'literal \\n',
      MULTI: 'line one\nline two',
      EMPTY: '',
    });
  });

  it('never takes names that would change how Claude Code runs', () => {
    const env = parseEnv('ANTHROPIC_API_KEY=x\nCLAUDE_CODE_USE_BEDROCK=1\nPATH=/tmp\nOK=1');
    expect(env.vars).toEqual({ OK: '1' });
    expect(env.skipped.map((s) => s.name)).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'PATH']);
  });

  it('tells Claude the names only', () => {
    const p = globalEnvPrompt(['API_KEY', 'SERVER_URL']);
    expect(p).toContain('- API_KEY');
    expect(p).toContain('Never print');
  });
});
