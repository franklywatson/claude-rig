import { describe, it, expect } from 'vitest';
import { classifyIntent, isCompoundCommand, type IntentType } from '../../src/router/intent.js';

describe('classifyIntent', () => {
  describe('bash command classification', () => {
    it('classifies grep as text_search', () => {
      expect(classifyIntent('Bash', { command: 'grep -r "pattern" src/' })).toBe('text_search');
    });

    it('classifies rg as text_search', () => {
      expect(classifyIntent('Bash', { command: 'rg "export.*function" .' })).toBe('text_search');
    });

    it('classifies grep -x as text_search', () => {
      expect(classifyIntent('Bash', { command: 'grepx something' })).toBe('text_search');
    });

    it('classifies find as file_discovery', () => {
      expect(classifyIntent('Bash', { command: 'find . -name "*.ts"' })).toBe('file_discovery');
    });

    it('classifies fd as file_discovery', () => {
      expect(classifyIntent('Bash', { command: 'fd "\\.ts$"' })).toBe('file_discovery');
    });

    it('classifies cat as file_read', () => {
      expect(classifyIntent('Bash', { command: 'cat src/config.ts' })).toBe('file_read');
    });

    it('classifies head as file_read', () => {
      expect(classifyIntent('Bash', { command: 'head -20 src/config.ts' })).toBe('file_read');
    });

    it('classifies sed -i as file_modify', () => {
      expect(classifyIntent('Bash', { command: "sed -i 's/old/new/g' file.ts" })).toBe('file_modify');
    });

    it('classifies sed --in-place as file_modify', () => {
      expect(classifyIntent('Bash', { command: "sed --in-place 's/old/new/g' file.ts" })).toBe('file_modify');
    });

    it('classifies awk with redirect as file_modify', () => {
      expect(classifyIntent('Bash', { command: "awk '{print $1}' file > out" })).toBe('file_modify');
    });

    it('classifies plain sed (no -i) as text_search', () => {
      expect(classifyIntent('Bash', { command: "sed -n 's/pattern/&/p' file" })).toBe('text_search');
    });

    it('classifies git status as pass_through', () => {
      expect(classifyIntent('Bash', { command: 'git status' })).toBe('pass_through');
    });

    it('classifies ls as pass_through', () => {
      expect(classifyIntent('Bash', { command: 'ls -la' })).toBe('pass_through');
    });

    it('classifies compound commands by most restrictive intent', () => {
      // grep && sed -i: sed -i (file_modify) is more restrictive than grep (text_search)
      expect(classifyIntent('Bash', { command: "grep pattern file && sed -i 's/a/b/g' file" })).toBe('file_modify');
    });

    it('classifies piped commands by first segment only', () => {
      // cat | grep: only cat (file_read) is classified — grep is output filtering
      expect(classifyIntent('Bash', { command: 'cat file | grep pattern' })).toBe('file_read');
    });

    it('classifies piped grep as pass_through (output filtering)', () => {
      // docker build | grep Error: grep is right side of pipe, not code search
      expect(classifyIntent('Bash', { command: 'docker compose build 2>&1 | grep -E "error|Error"' })).toBe('pass_through');
    });

    it('classifies standalone grep as text_search', () => {
      expect(classifyIntent('Bash', { command: 'grep -r "TODO" src/' })).toBe('text_search');
    });

    it('classifies piped find as pass_through (output filtering)', () => {
      expect(classifyIntent('Bash', { command: 'ls -la | find . -type f' })).toBe('pass_through');
    });

    it('classifies npx ... && grep as pass_through (grep is post-processing)', () => {
      expect(classifyIntent('Bash', { command: 'npx vitest run --coverage 2>&1 > /tmp/out.txt && grep -n "%" /tmp/out.txt | head -30' })).toBe('pass_through');
    });

    it('classifies npm test && grep as pass_through', () => {
      expect(classifyIntent('Bash', { command: 'npm test 2>&1 | tee /tmp/out.txt && grep "FAIL" /tmp/out.txt' })).toBe('pass_through');
    });

    it('still classifies grep && grep as text_search', () => {
      expect(classifyIntent('Bash', { command: 'grep "TODO" src/a.ts && grep "FIXME" src/b.ts' })).toBe('text_search');
    });

    it('classifies sed -i after a pass_through segment as file_modify', () => {
      expect(
        classifyIntent('Bash', { command: 'echo "const x = 1;" > /tmp/f.ts && sed -i \'\' \'s/x/y/\' /tmp/f.ts' }),
      ).toBe('file_modify');
    });

    it('classifies sed -i after a semicolon as file_modify', () => {
      expect(classifyIntent('Bash', { command: "cd /tmp; sed -i 's/a/b/' file.ts" })).toBe('file_modify');
    });

    it('classifies sed -i on the right side of a pipe as file_modify', () => {
      expect(classifyIntent('Bash', { command: "cat list.txt | sed -i 's/a/b/' file.ts" })).toBe('file_modify');
    });

    it('classifies awk redirect after && as file_modify', () => {
      expect(classifyIntent('Bash', { command: "mkdir -p out && awk '{print}' a.txt > out/b.txt" })).toBe('file_modify');
    });

    it('does not classify quoted sed -i text as file_modify', () => {
      expect(classifyIntent('Bash', { command: 'echo "run sed -i later && sed -i fake"' })).toBe('pass_through');
    });
  });

  describe('Claude tool classification', () => {
    it('classifies Grep tool as text_search', () => {
      expect(classifyIntent('Grep', { pattern: 'export.*function' })).toBe('text_search');
    });

    it('classifies Glob tool as file_discovery', () => {
      expect(classifyIntent('Glob', { pattern: '**/*.ts' })).toBe('file_discovery');
    });

    it('classifies Read tool as file_read', () => {
      expect(classifyIntent('Read', { file_path: '/home/user/project/src/file.ts' })).toBe('file_read');
    });

    it('classifies Agent with Explore as file_discovery', () => {
      expect(classifyIntent('Agent', { subagent_type: 'Explore', prompt: 'find auth files' })).toBe('file_discovery');
    });

    it('classifies Edit tool as file_modify', () => {
      expect(classifyIntent('Edit', { file_path: '/home/user/project/src/file.ts' })).toBe('file_modify');
    });

    it('classifies Write tool as file_modify', () => {
      expect(classifyIntent('Write', { file_path: '/home/user/project/src/file.ts' })).toBe('file_modify');
    });

    it('classifies unknown tool as pass_through', () => {
      expect(classifyIntent('UnknownTool', {})).toBe('pass_through');
    });
  });

  describe('precedence', () => {
    it('file_modify wins over text_search in compound command', () => {
      expect(classifyIntent('Bash', { command: "rg pattern . ; sed -i 's/a/b/g' f" })).toBe('file_modify');
    });

    it('file_modify wins over file_read in compound command', () => {
      expect(classifyIntent('Bash', { command: "cat file ; sed -i 's/a/b/g' file" })).toBe('file_modify');
    });
  });

  describe('isCompoundCommand', () => {
    it('detects semicolon separator', () => {
      expect(isCompoundCommand('ls -la /path/file 2>/dev/null; diff /path/file -')).toBe(true);
    });

    it('detects && separator', () => {
      expect(isCompoundCommand('git status && git diff')).toBe(true);
    });

    it('detects || separator', () => {
      expect(isCompoundCommand('cmd1 || cmd2')).toBe(true);
    });

    it('detects | pipe', () => {
      expect(isCompoundCommand('cat file | grep pattern')).toBe(true);
    });

    it('detects mixed operators', () => {
      expect(isCompoundCommand('cat file | grep foo && ls')).toBe(true);
    });

    it('returns false for simple command', () => {
      expect(isCompoundCommand('cat file.ts')).toBe(false);
    });

    it('returns false for redirect without pipe', () => {
      expect(isCompoundCommand('ls -la /path 2>/dev/null')).toBe(false);
    });

    it('returns false for 2>&1 redirect', () => {
      expect(isCompoundCommand('docker compose build 2>&1 | grep error')).toBe(true);
    });

    it('ignores semicolon inside single quotes', () => {
      expect(isCompoundCommand("grep 'foo;bar' file")).toBe(false);
    });

    it('ignores pipe inside double quotes', () => {
      expect(isCompoundCommand('grep "a|b" file')).toBe(false);
    });

    it('ignores && inside double quotes', () => {
      expect(isCompoundCommand('echo "run && check"')).toBe(false);
    });

    it('detects operator outside quotes even when quotes present', () => {
      expect(isCompoundCommand("echo 'hello' && grep 'world' file")).toBe(true);
    });
  });
});
