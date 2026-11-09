import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableTracking, enableTracking, hasTracking, HooksConfigError } from '../../src/core/hooksConfig';

let dir: string;
let file: string;
const opts = () => ({ settingsFile: file, nodePath: '/usr/local/bin/node', recorderPath: '/home/u/.claude/skilltree/record-skill-event.mjs', logFile: '/home/u/.claude/skilltree/activity.jsonl', now: () => new Date('2026-01-01T00:00:00Z') });
const original = JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/check.sh' }] }] } }, null, 4) + '\n';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skilltree-hooks-'));
  file = path.join(dir, '.claude', 'settings.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('enable/disable tracking', () => {
  it('adds narrowly scoped, non-blocking handlers and keeps existing settings', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original);
    const install = await enableTracking(opts());
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.model).toBe('opus');
    expect(json.hooks.PreToolUse).toHaveLength(2);
    expect(json.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(json.hooks.PreToolUse[1]).toEqual({ matcher: 'Skill', hooks: [{ type: 'command', command: '/usr/local/bin/node', args: [opts().recorderPath, opts().logFile], timeout: 5 }] });
    expect(json.hooks.UserPromptExpansion[0].matcher).toBeUndefined();
    expect(json.hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command: '/usr/local/bin/node', args: [opts().recorderPath, opts().logFile], timeout: 5 }] }]);
    expect(hasTracking(json, opts().recorderPath)).toBe(true);
    expect(await fs.readFile(install.backupFile!, 'utf8')).toBe(original);
  });

  it('restores the original file byte-for-byte when unchanged since enabling', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original);
    const install = await enableTracking(opts());
    const r = await disableTracking(install);
    expect(r).toEqual({ mode: 'restored', removedHandlers: 3 });
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(['settings.json']);
  });

  it('removes only its handlers when the file changed meanwhile', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original);
    const install = await enableTracking(opts());
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    json.theme = 'dark';
    await fs.writeFile(file, JSON.stringify(json));
    const r = await disableTracking(install);
    expect(r).toEqual({ mode: 'removed', removedHandlers: 3 });
    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(after).toEqual({ model: 'opus', theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/check.sh' }] }] } });
  });

  it('creates and later deletes a settings file that did not exist', async () => {
    const install = await enableTracking(opts());
    expect(install.backupFile).toBeNull();
    expect((await disableTracking(install)).mode).toBe('restored');
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('is idempotent when enabled twice', async () => {
    await enableTracking(opts());
    await enableTracking({ ...opts(), now: () => new Date('2026-01-02T00:00:00Z') });
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.hooks.PreToolUse).toHaveLength(1);
    expect(json.hooks.UserPromptExpansion).toHaveLength(1);
  });

  it('refuses to modify invalid JSON', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ "model": "opus", }');
    await expect(enableTracking(opts())).rejects.toBeInstanceOf(HooksConfigError);
    expect(await fs.readFile(file, 'utf8')).toBe('{ "model": "opus", }');
  });
});

describe('installs from before SessionEnd', () => {
  it('still count as tracking with only the two skill handlers', () => {
    const h = { type: 'command', command: '/n', args: [opts().recorderPath, opts().logFile], timeout: 5 };
    expect(hasTracking({ hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [h] }], UserPromptExpansion: [{ hooks: [h] }] } }, opts().recorderPath)).toBe(true);
  });
});

