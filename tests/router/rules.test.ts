import { describe, it, expect } from 'vitest';
import { getDefaultRules, findMatchingRule, isCodeFile } from '../../src/router/rules.js';
import type { ToolRule } from '../../src/types.js';

// Helper to find rule by intent
function findRule(intent: string, rules: ToolRule[]): ToolRule | undefined {
  return rules.find(r => r.intent === intent);
}

describe('getDefaultRules', () => {
  it('returns rules for all intents', () => {
    const rules = getDefaultRules();
    const intents = rules.map(r => r.intent);
    expect(intents).toContain('text_search');
    expect(intents).toContain('file_discovery');
    expect(intents).toContain('file_read');
    expect(intents).toContain('file_modify');
  });

  it('file_modify rules always block sed -i', () => {
    const rules = getDefaultRules();
    const sedRule = rules.find(r =>
      r.intent === 'file_modify' && r.enforcement === 'block'
    );
    expect(sedRule).toBeDefined();
  });

  it('text_search rules have jcodemunch resolution', () => {
    const rules = getDefaultRules();
    const grepRule = rules.find(r => r.intent === 'text_search');
    expect(grepRule).toBeDefined();
    expect(grepRule!.resolutions.jcodemunch).toBeDefined();
  });

  it('file_discovery rules have jcodemunch resolution', () => {
    const rules = getDefaultRules();
    const findRule = rules.find(r => r.intent === 'file_discovery');
    expect(findRule).toBeDefined();
    expect(findRule!.resolutions.jcodemunch).toBeDefined();
  });

  it('file_read rules advise rtk cat when rtk available', () => {
    const rules = getDefaultRules();
    const catRule = rules.find(r => r.intent === 'file_read');
    expect(catRule).toBeDefined();
    const rtkRes = catRule!.resolutions.rtk as { action: string; tool: string };
    expect(rtkRes.action).toBe('advise');
    expect(rtkRes.tool).toBe('rtk cat');
  });
});

describe('findMatchingRule', () => {
  const rules = getDefaultRules();

  it('matches grep bash command to text_search rule', () => {
    const match = findMatchingRule('Bash', { command: 'grep -r pattern .' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('text_search');
  });

  it('matches Grep tool to native_grep rule (not text_search)', () => {
    const match = findMatchingRule('Grep', { pattern: 'function' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('native_grep');
  });

  it('matches Glob tool on code pattern to native_glob rule (not file_discovery)', () => {
    const match = findMatchingRule('Glob', { pattern: '**/*.ts' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('native_glob');
  });

  it('matches sed -i to file_modify block rule', () => {
    const match = findMatchingRule('Bash', { command: "sed -i 's/a/b/g' f" }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('file_modify');
    expect(match!.enforcement).toBe('block');
  });

  it('returns undefined for Read tool on non-code file (no rule — pass through)', () => {
    const match = findMatchingRule('Read', { file_path: '/some/readme.txt' }, rules);
    expect(match).toBeUndefined();
  });

  it('returns undefined for unknown tools', () => {
    const match = findMatchingRule('SomeOtherTool', {}, rules);
    expect(match).toBeUndefined();
  });
});

describe('isCodeFile', () => {
  it('returns true for TypeScript files', () => {
    expect(isCodeFile('src/index.ts')).toBe(true);
    expect(isCodeFile('component.tsx')).toBe(true);
  });

  it('returns true for JavaScript files', () => {
    expect(isCodeFile('app.js')).toBe(true);
    expect(isCodeFile('component.jsx')).toBe(true);
  });

  it('returns true for other code files', () => {
    expect(isCodeFile('main.py')).toBe(true);
    expect(isCodeFile('server.go')).toBe(true);
    expect(isCodeFile('lib.rs')).toBe(true);
    expect(isCodeFile('App.java')).toBe(true);
    expect(isCodeFile('util.c')).toBe(true);
    expect(isCodeFile('util.cpp')).toBe(true);
    expect(isCodeFile('header.h')).toBe(true);
    expect(isCodeFile('app.rb')).toBe(true);
    expect(isCodeFile('cli.swift')).toBe(true);
    expect(isCodeFile('Main.kt')).toBe(true);
    expect(isCodeFile('App.scala')).toBe(true);
  });

  it('returns false for non-code files', () => {
    expect(isCodeFile('readme.txt')).toBe(false);
    expect(isCodeFile('data.json')).toBe(false);
    expect(isCodeFile('config.yaml')).toBe(false);
    expect(isCodeFile('notes.md')).toBe(false);
  });

  it('returns false for files without extension', () => {
    expect(isCodeFile('Makefile')).toBe(false);
    expect(isCodeFile('Dockerfile')).toBe(false);
    expect(isCodeFile('.gitignore')).toBe(false);
  });
});

describe('native tool rules', () => {
  const rules = getDefaultRules();

  it('matches Read tool on code file to native_read rule', () => {
    const match = findMatchingRule('Read', { file_path: '/some/file.ts' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('native_read');
  });

  it('does not match Read tool on non-code file', () => {
    const match = findMatchingRule('Read', { file_path: '/some/readme.txt' }, rules);
    expect(match).toBeUndefined();
  });

  it('does not match Read tool with targeted re-read (offset)', () => {
    const match = findMatchingRule('Read', { file_path: '/some/file.ts', offset: 10 }, rules);
    expect(match).toBeUndefined();
  });

  it('does not match Read tool with targeted re-read (limit)', () => {
    const match = findMatchingRule('Read', { file_path: '/some/file.ts', limit: 20 }, rules);
    expect(match).toBeUndefined();
  });

  it('native_read rule has jcodemunch resolution', () => {
    const rule = rules.find(r => r.intent === 'native_read');
    expect(rule).toBeDefined();
    expect(rule!.resolutions.jcodemunch).toBeDefined();
    // No rtk or claudeTool resolution — agent is already on the native tool
    expect(rule!.resolutions.rtk).toBeUndefined();
    expect(rule!.resolutions.claudeTool).toBeUndefined();
  });

  it('matches Grep tool to native_grep rule', () => {
    const match = findMatchingRule('Grep', { pattern: 'function' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('native_grep');
  });

  it('native_grep rule has jcodemunch resolution', () => {
    const rule = rules.find(r => r.intent === 'native_grep');
    expect(rule).toBeDefined();
    expect(rule!.resolutions.jcodemunch).toBeDefined();
    expect(rule!.resolutions.rtk).toBeUndefined();
    expect(rule!.resolutions.claudeTool).toBeUndefined();
  });

  it('matches Glob tool on code pattern to native_glob rule', () => {
    const match = findMatchingRule('Glob', { pattern: '**/*.ts' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('native_glob');
  });

  it('falls through to file_discovery for Glob on non-code pattern', () => {
    const match = findMatchingRule('Glob', { pattern: '**/*.log' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('file_discovery');
  });

  it('native_glob rule has jcodemunch resolution', () => {
    const rule = rules.find(r => r.intent === 'native_glob');
    expect(rule).toBeDefined();
    expect(rule!.resolutions.jcodemunch).toBeDefined();
    expect(rule!.resolutions.rtk).toBeUndefined();
    expect(rule!.resolutions.claudeTool).toBeUndefined();
  });

  it('matches rtk cat on code file to rtk_cat_code rule', () => {
    const match = findMatchingRule('Bash', { command: 'rtk cat /some/file.ts' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('rtk_cat_code');
  });

  it('does not match rtk cat on non-code file', () => {
    const match = findMatchingRule('Bash', { command: 'rtk cat /some/readme.txt' }, rules);
    expect(match).toBeUndefined();
  });

  it('rtk_cat_code rule has wildcard block resolution', () => {
    const rule = rules.find(r => r.intent === 'rtk_cat_code');
    expect(rule).toBeDefined();
    expect(rule!.resolutions._).toBeDefined();
    expect(rule!.enforcement).toBe('block');
  });

  it('native rules fire before broader intent rules', () => {
    // Grep should match native_grep, not text_search
    const grepMatch = findMatchingRule('Grep', { pattern: 'fn' }, rules);
    expect(grepMatch!.intent).toBe('native_grep');

    // Glob should match native_glob, not file_discovery
    const globMatch = findMatchingRule('Glob', { pattern: '**/*.ts' }, rules);
    expect(globMatch!.intent).toBe('native_glob');

    // Read should match native_read, not file_read
    const readMatch = findMatchingRule('Read', { file_path: 'src/index.ts' }, rules);
    expect(readMatch!.intent).toBe('native_read');

    // Bash grep should still match text_search
    const bashGrepMatch = findMatchingRule('Bash', { command: 'grep -r pattern .' }, rules);
    expect(bashGrepMatch!.intent).toBe('text_search');
  });
});

describe('scout_explore rule', () => {
  const rules = getDefaultRules();

  it('matches Agent with Explore subagent to scout_explore rule', () => {
    const match = findMatchingRule('Agent', { subagent_type: 'Explore', prompt: 'find auth files' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('scout_explore');
  });

  it('does not match Agent with general-purpose subagent', () => {
    const match = findMatchingRule('Agent', { subagent_type: 'general-purpose', prompt: 'fix the bug' }, rules);
    expect(match).toBeUndefined();
  });

  it('does not match Agent with Plan subagent', () => {
    const match = findMatchingRule('Agent', { subagent_type: 'Plan', prompt: 'create a plan' }, rules);
    expect(match).toBeUndefined();
  });

  it('scout_explore rule fires before file_discovery rule', () => {
    // Agent+Explore should match scout_explore, not file_discovery
    const match = findMatchingRule('Agent', { subagent_type: 'Explore', prompt: 'map the codebase' }, rules);
    expect(match).toBeDefined();
    expect(match!.intent).toBe('scout_explore');
    expect(match!.intent).not.toBe('file_discovery');
  });

  it('has jcodemunch resolution with scout advisory', () => {
    const rule = findRule('scout_explore', rules);
    expect(rule).toBeDefined();
    expect(rule!.resolutions.jcodemunch).toBeDefined();
    const jmRes = rule!.resolutions.jcodemunch as { action: string; tool: string };
    expect(jmRes.action).toBe('advise');
    expect(jmRes.tool).toContain('scout');
  });

  it('fallback resolution is allow', () => {
    const rule = findRule('scout_explore', rules);
    expect(rule).toBeDefined();
    expect(rule!.resolutions.fallback).toBeDefined();
    const fbRes = rule!.resolutions.fallback as { action: string };
    expect(fbRes.action).toBe('allow');
  });

  it('findMatchingRule with skipIntents falls to file_discovery', () => {
    const match = findMatchingRule(
      'Agent',
      { subagent_type: 'Explore', prompt: 'find auth files' },
      rules,
      new Set(['scout_explore']),
    );
    expect(match).toBeDefined();
    expect(match!.intent).toBe('file_discovery');
  });
});
