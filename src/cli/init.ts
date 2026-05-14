import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from './renderer.js';
import { DEFAULT_CONFIG } from '../config.js';
import { stringify as yamlStringify } from 'yaml';
import { detectEnvironment, type ExecFn } from '../session/environment.js';
import { REQUIRED_PERMISSIONS } from './permissions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..', '..', 'templates');

interface InitOptions {
  force: boolean;
  exec?: ExecFn;
}

export async function initCommand(projectDir: string, options: InitOptions): Promise<void> {
  const claudeDir = join(projectDir, '.claude');
  const projectName = basename(projectDir);
  const generatedDate = new Date().toISOString().split('T')[0];
  const rigDistPath = resolve(__dirname, '..');

  // Build render context with environment-aware variables
  const renderContext: Record<string, string> = {
    PROJECT_NAME: projectName,
    GENERATED_DATE: generatedDate,
    RIG_DIST_PATH: rigDistPath,
  };

  let rtkAvailable = false;
  try {
    const env = await detectEnvironment(projectDir, options.exec);
    rtkAvailable = env.rtkAvailable;
    if (env.rtkAvailable && env.rtkPath) {
      renderContext.RTK_PATH = env.rtkPath;
    }
    if (env.jcodemunchAvailable) {
      renderContext.JCODEMUNCH_AVAILABLE = 'true';
    }
  } catch {
    // Environment detection is best-effort; templates render with available vars
  }

  // Create directory structure
  const dirs = [
    join(claudeDir, 'hooks', 'scripts'),
    join(claudeDir, 'skills'),
    join(claudeDir, 'agents'),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Copy and render hook scripts
  const hookTemplates = ['pre-tool-use.ts', 'post-tool-use.ts', 'session-start.ts'];

  // Prune old-format hooks (pre-scripts layout: files directly in .claude/hooks/)
  const hooksDir = join(claudeDir, 'hooks');
  for (const hookFile of hookTemplates) {
    const oldPath = join(hooksDir, hookFile);
    if (existsSync(oldPath)) {
      unlinkSync(oldPath);
    }
  }

  for (const hookFile of hookTemplates) {
    const src = join(TEMPLATES_DIR, 'hooks', hookFile);
    const dest = join(claudeDir, 'hooks', 'scripts', hookFile);
    copyGeneratedTemplate(src, dest, renderContext);
  }

  // Copy skill templates
  const skillDirs = ['brain-plus', 'plan-plus', 'tdd-plus', 'verify-plus', 'review-plus', 'debug-plus', 'verify-harness', 'savings', 'investigate'];
  for (const skillDir of skillDirs) {
    const srcDir = join(TEMPLATES_DIR, 'skills', skillDir);
    if (!existsSync(srcDir)) continue;
    const destDir = join(claudeDir, 'skills', skillDir);
    mkdirSync(destDir, { recursive: true });
    copyUserTemplate(
      join(srcDir, 'SKILL.md'),
      join(destDir, 'SKILL.md'),
      renderContext,
      options.force,
    );
  }

  // Copy agent templates
  const agentFiles = ['scout.md'];
  for (const agentFile of agentFiles) {
    const src = join(TEMPLATES_DIR, 'agents', agentFile);
    if (!existsSync(src)) continue;
    copyUserTemplate(src, join(claudeDir, 'agents', agentFile), renderContext, options.force);
  }

  // Write default config
  const configPath = join(projectDir, '.harness.yaml');
  if (!existsSync(configPath) || options.force) {
    writeFileSync(configPath, yamlStringify(DEFAULT_CONFIG, { lineWidth: 0 }));
  }

  // Create graphify-out directory (graph built on-demand, no placeholder)
  const graphifyDir = join(projectDir, 'graphify-out');
  if (!existsSync(graphifyDir)) {
    mkdirSync(graphifyDir, { recursive: true });
  }

  // Update settings.json with hook registrations
  const npxCommand = resolveNpxPath(options.exec);
  updateSettingsJson(claudeDir, npxCommand, rtkAvailable);

  // Update .gitignore with rig-managed section
  updateGitignore(projectDir);
}

const GITIGNORE_MARKER_START = '# --- rig-managed (do not edit below) ---';
const GITIGNORE_MARKER_END = '# --- end rig-managed ---';
const GITIGNORE_ENTRIES = [
  '.harness.yaml.local',
  '*.session-cache.json',
  'graphify-out/',
];

function updateGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  let content = '';

  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  // Check if rig-managed section already exists
  if (content.includes(GITIGNORE_MARKER_START)) {
    // Update entries within existing section if any are missing
    const startIdx = content.indexOf(GITIGNORE_MARKER_START);
    const endIdx = content.indexOf(GITIGNORE_MARKER_END);
    if (endIdx > startIdx) {
      const section = content.substring(startIdx, endIdx + GITIGNORE_MARKER_END.length);
      let updated = section;
      for (const entry of GITIGNORE_ENTRIES) {
        if (!section.includes(entry)) {
          // Insert before the end marker
          updated = updated.replace(GITIGNORE_MARKER_END, `${entry}\n${GITIGNORE_MARKER_END}`);
        }
      }
      if (updated !== section) {
        writeFileSync(gitignorePath, content.replace(section, updated));
      }
    }
    return;
  }

  // Append rig-managed section
  const section = [
    '',
    GITIGNORE_MARKER_START,
    ...GITIGNORE_ENTRIES.map(e => e),
    GITIGNORE_MARKER_END,
    '',
  ].join('\n');

  writeFileSync(gitignorePath, content + section);
}

function isRigGenerated(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return content.includes('@rig-generated') || content.includes('<!-- rig-generated -->');
}

function copyGeneratedTemplate(
  src: string,
  dest: string,
  context: Record<string, string>,
): void {
  // Always overwrite: hook scripts are generated code users shouldn't edit.
  const content = readFileSync(src, 'utf-8');
  writeFileSync(dest, renderTemplate(content, context));
}

function copyUserTemplate(
  src: string,
  dest: string,
  context: Record<string, string>,
  force: boolean,
): void {
  if (!force) {
    if (!existsSync(dest)) {
      // File doesn't exist — write it
      const content = readFileSync(src, 'utf-8');
      writeFileSync(dest, renderTemplate(content, context));
      return;
    }
    // File exists — only overwrite if it's a stale rig-generated file
    if (!isRigGenerated(dest)) return;
  }
  const content = readFileSync(src, 'utf-8');
  writeFileSync(dest, renderTemplate(content, context));
}

function resolveNpxPath(exec?: ExecFn): string {
  const runExec: ExecFn = exec ?? ((cmd, opts) =>
    execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string);
  try {
    const npxPath = runExec('command -v npx').trim();
    if (!npxPath) return 'npx tsx';
    const nodeBinDir = npxPath.replace(/\/npx$/, '');
    // Prepend node bin dir to PATH so npx/tsx can find node in restricted shells
    return `PATH="${nodeBinDir}:$PATH" ${npxPath} tsx`;
  } catch {
    return 'npx tsx';
  }
}

const SECRET_DENY_LIST = [
  'Read(**/secrets/**)',
  'Read(**/credentials/**)',
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Edit(**/secrets/**)',
  'Edit(**/credentials/**)',
  'Edit(**/*.pem)',
  'Edit(**/*.key)',
  'Write(**/secrets/**)',
  'Write(**/credentials/**)',
  'Write(**/*.pem)',
  'Write(**/*.key)',
];

function updateSettingsJson(claudeDir: string, npxCommand: string, rtkAvailable: boolean): void {
  const settingsPath = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }

  // ── Hooks ──

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;

  const hookRegistrations: Record<string, string> = {
    PreToolUse: 'pre-tool-use.ts',
    PostToolUse: 'post-tool-use.ts',
    SessionStart: 'session-start.ts',
  };

  for (const [event, script] of Object.entries(hookRegistrations)) {
    if (!hooks[event]) {
      hooks[event] = [];
    }
    const entries = hooks[event] as Array<Record<string, unknown>>;
    const hookScriptPath = `\${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/${script}`;
    const command = `${npxCommand} ${hookScriptPath}`;

    // Remove old-format entries (flat matcher+command without nested hooks array)
    let i = entries.length;
    while (i--) {
      const e = entries[i];
      if (
        typeof e === 'object' &&
        e !== null &&
        'command' in e &&
        typeof e.command === 'string' &&
        e.command.includes(script) &&
        !('hooks' in e)
      ) {
        entries.splice(i, 1);
      }
    }

    // Find existing new-format entry and update command, or add new
    let updated = false;
    for (const entry of entries) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        'hooks' in entry &&
        Array.isArray((entry as Record<string, unknown>).hooks)
      ) {
        const hookEntries = (entry as Record<string, unknown>).hooks as Array<Record<string, string>>;
        for (const h of hookEntries) {
          if (typeof h === 'object' && h.command?.includes(script)) {
            h.command = command;
            updated = true;
            break;
          }
        }
      }
      if (updated) break;
    }
    if (!updated) {
      entries.push({
        matcher: '',
        hooks: [{ type: 'command', command }],
      });
    }
  }

  // ── Permissions ──

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = { allow: [], deny: [] };
  }
  const permissions = settings.permissions as { allow: string[]; deny: string[] };
  if (!Array.isArray(permissions.allow)) permissions.allow = [];
  if (!Array.isArray(permissions.deny)) permissions.deny = [];

  // Auto-allow: the always-required set (MCP tools, session cache cat/ls/Read, npx)
  for (const entry of REQUIRED_PERMISSIONS) {
    if (!permissions.allow.includes(entry)) {
      permissions.allow.push(entry);
    }
  }

  // Auto-allow: rtk binary (only when detected — not in REQUIRED list because conditional)
  if (rtkAvailable && !permissions.allow.includes('Bash(rtk:*)')) {
    permissions.allow.push('Bash(rtk:*)');
  }

  // Default deny: secret file patterns
  for (const entry of SECRET_DENY_LIST) {
    if (!permissions.deny.includes(entry)) {
      permissions.deny.push(entry);
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
