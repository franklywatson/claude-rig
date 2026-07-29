import { describe, it, expect } from 'vitest';
import { detectRtkGlobalHook } from '../../src/session/rtk-global-hook.js';

const settings = (preToolUseHooks: unknown): string =>
  JSON.stringify({ hooks: { PreToolUse: preToolUseHooks } });

describe('detectRtkGlobalHook', () => {
  const read = (s: string) => () => s;
  const exists = () => true;

  it('detects `rtk hook claude` in PreToolUse hooks', () => {
    const s = settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }]);
    expect(detectRtkGlobalHook(read(s), exists, '/fake')).toBe(true);
  });

  it('detects a rtk hook variant (rtk hook check)', () => {
    const s = settings([{ hooks: [{ type: 'command', command: '/usr/bin/rtk hook check --agent claude x' }] }]);
    expect(detectRtkGlobalHook(read(s), exists, '/fake')).toBe(true);
  });

  it('does not flag a non-rtk PreToolUse hook', () => {
    const s = settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /some/other-hook.ts' }] }]);
    expect(detectRtkGlobalHook(read(s), exists, '/fake')).toBe(false);
  });

  it('does not match rtk appearing only inside a path/command name (word boundary)', () => {
    // `xrtk-hook` has no word boundary before `rtk` — must not match `rtk hook`.
    const s = settings([{ hooks: [{ command: 'xrtk-hook runner' }] }]);
    expect(detectRtkGlobalHook(read(s), exists, '/fake')).toBe(false);
  });

  it('does not match "rtk hooks" (plural — trailing word boundary)', () => {
    const s = settings([{ hooks: [{ command: 'rtk hooks something' }] }]);
    expect(detectRtkGlobalHook(read(s), exists, '/fake')).toBe(false);
  });

  it('returns false when settings.json is absent', () => {
    expect(detectRtkGlobalHook(() => '', () => false, '/fake')).toBe(false);
  });

  it('returns false on malformed JSON', () => {
    expect(detectRtkGlobalHook(() => 'not json{{{', exists, '/fake')).toBe(false);
  });

  it('returns false when there are no PreToolUse hooks', () => {
    expect(detectRtkGlobalHook(read('{}'), exists, '/fake')).toBe(false);
  });
});
