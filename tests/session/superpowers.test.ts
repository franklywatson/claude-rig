import { describe, it, expect } from 'vitest';
import { detectSuperpowers } from '../../src/session/superpowers.js';

describe('detectSuperpowers', () => {
  const read = (s: string) => () => s;
  const exists = () => true;

  it('detects superpowers@claude-plugins-official with version + path', () => {
    const s = JSON.stringify({
      plugins: { 'superpowers@claude-plugins-official': [{ version: '6.2.0', installPath: '/x/superpowers' }] },
    });
    const r = detectSuperpowers(read(s), exists, '/fake');
    expect(r.installed).toBe(true);
    expect(r.version).toBe('6.2.0');
    expect(r.path).toBe('/x/superpowers');
  });

  it('detects superpowers from any marketplace', () => {
    const s = JSON.stringify({ plugins: { 'superpowers@obra/superpowers-marketplace': [{ version: '6.1.0' }] } });
    expect(detectSuperpowers(read(s), exists, '/fake').installed).toBe(true);
  });

  it('returns not-installed when only unrelated plugins are present', () => {
    const s = JSON.stringify({ plugins: { 'frontend-design@claude-plugins-official': [{ version: '1.0' }] } });
    expect(detectSuperpowers(read(s), exists, '/fake').installed).toBe(false);
  });

  it('returns not-installed when the registry is absent', () => {
    expect(detectSuperpowers(() => '', () => false, '/fake').installed).toBe(false);
  });

  it('returns not-installed on malformed JSON', () => {
    expect(detectSuperpowers(() => 'not json{{{', exists, '/fake').installed).toBe(false);
  });

  it('returns not-installed when plugins is empty', () => {
    expect(detectSuperpowers(read('{}'), exists, '/fake').installed).toBe(false);
  });
});
