/**
 * ABOUTME: Tests for the generic acp-run agent plugin.
 * Covers stdin delivery, CLI options, detection, validation, and task result mapping without agents.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import createAcpAgent, { AcpAgentPlugin } from './acp.js';
import type { AgentExecuteOptions, AgentExecutionResult } from '../types.js';

class TestableAcpPlugin extends AcpAgentPlugin {
  args(prompt = 'private prompt', options?: AgentExecuteOptions): string[] {
    return this.buildArgs(prompt, undefined, options);
  }

  stdin(prompt: string): string | undefined {
    return this.getStdinInput(prompt);
  }

  baseTimeout(): number {
    return this.defaultTimeout;
  }
}

/** A simulated process; no executable or agent is launched by these tests. */
function fakeProcess(code: number, stdout = '', stderr = '', error?: Error) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: mock(() => true),
  });
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => {
    queueMicrotask(() => {
      if (error) proc.emit('error', error);
      proc.stdout.end(stdout);
      proc.stderr.end(stderr);
      proc.emit('close', code, null);
    });
    return proc as unknown as childProcess.ChildProcess;
  }) as typeof childProcess.spawn);
  return { proc, spawn };
}

describe('AcpAgentPlugin', () => {
  let plugin: TestableAcpPlugin;

  beforeEach(async () => {
    plugin = new TestableAcpPlugin();
    await plugin.initialize({ agent: 'codex', model: 'gpt-6-astra', command: process.execPath });
  });

  afterEach(async () => {
    await plugin.dispose();
    mock.restore();
  });

  test('factory metadata describes buffered output', () => {
    expect(createAcpAgent()).toBeInstanceOf(AcpAgentPlugin);
    expect(plugin.meta.id).toBe('acp');
    expect(plugin.meta.defaultCommand).toBe('acp-run');
    expect(plugin.meta.supportsStreaming).toBe(false);
    expect(plugin.meta.supportsSubagentTracing).toBe(false);
    expect(plugin.meta.supportsInterrupt).toBe(true);
    expect(plugin.meta.supportsFileContext).toBe(false);
  });

  test('builds agent, cwd, default permissions and model while keeping prompt on stdin', () => {
    const prompt = 'private\n$(do not execute)';
    expect(plugin.args(prompt, { cwd: '/tmp/task with spaces' })).toEqual([
      'codex', '-C', '/tmp/task with spaces', '--perm', 'all', '--model', 'gpt-6-astra',
    ]);
    expect(plugin.stdin(prompt)).toBe(prompt);
    expect(plugin.args()).toContain(process.cwd());
  });

  test('passes mode, scoped permissions, repeated settings and seconds timeout', async () => {
    await plugin.initialize({ agent: 'agy', model: 'gemini-example', mode: 'code',
      perm: 'scoped:src,docs', set: ['provider=example', 'reasoning=high', 'extra=a=b'], timeout: 60 });
    expect(plugin.args('prompt', { cwd: '/tmp/task' })).toEqual([
      'agy', '-C', '/tmp/task', '--perm', 'scoped:src,docs', '--model', 'gemini-example',
      '--mode', 'code', '--set', 'provider=example', '--set', 'reasoning=high',
      '--set', 'extra=a=b', '--timeout', '60',
    ]);
    expect(plugin.baseTimeout()).toBe(0);
  });

  test('supports deny permissions', async () => {
    await plugin.initialize({ agent: 'codex', model: 'future-model', perm: 'deny' });
    expect(plugin.args()).toContain('deny');
  });

  test('zcode omits model and accepts an empty model', async () => {
    await plugin.initialize({ agent: 'zcode' });
    expect(plugin.args()).not.toContain('--model');
    expect(plugin.validateModel('')).toBeNull();
    expect(plugin.validateModel('unsupported')).toContain('does not support');
    expect(() => plugin.args('', { flags: ['--model', 'unsupported'] })).toThrow();
  });

  test('requires a model without hardcoding a list', async () => {
    expect(plugin.validateModel('future-model/unknown-version')).toBeNull();
    expect(plugin.validateModel('  ')).toContain('requires a model');
    await plugin.initialize({ agent: 'codex' });
    expect(() => plugin.args()).toThrow('requires a model');
    expect(() => plugin.args('', { flags: ['--model', 'runtime-model'] })).not.toThrow();
  });

  test('runtime model overrides the configured model', () => {
    const args = plugin.args('', { flags: ['--model', 'runtime-model'] });
    expect(args).toContain('runtime-model');
    expect(args).not.toContain('gpt-6-astra');
  });

  test('rejects missing and option-like agent names before spawn', async () => {
    for (const agent of ['', '--list']) {
      await plugin.initialize({ agent, model: 'm' });
      expect(() => plugin.args()).toThrow('agent name');
    }
  });

  test('rejects malformed optional settings', async () => {
    for (const config of [{ perm: 'ask' }, { set: ['missing-equals'] },
      { set: 'key=value' }, { timeout: -1 }, { timeout: NaN }, { timeout: '60' }]) {
      await plugin.initialize({ agent: 'codex', model: 'm', ...config });
      expect(() => plugin.args()).toThrow();
    }
  });

  test('setup asks for agent and model and validates zcode separately', async () => {
    expect(plugin.getSetupQuestions().find((q) => q.id === 'agent')?.required).toBe(true);
    expect(plugin.getSetupQuestions().find((q) => q.id === 'model')?.type).toBe('text');
    expect(plugin.getSetupQuestions().find((q) => q.id === 'command')).toBeDefined();
    expect(await plugin.validateSetup({})).toContain('agent name');
    expect(await plugin.validateSetup({ agent: 'codex' })).toContain('model');
    expect(await plugin.validateSetup({ agent: 'zcode' })).toBeNull();
    expect(await plugin.validateSetup({ agent: 'zcode', model: 'm' })).toContain('empty');
    expect(await plugin.validateSetup({ agent: 'agy', model: 'claude-future' })).toBeNull();
  });

  test('detect parses exact installed agent names and uses command override', async () => {
    const { spawn } = fakeProcess(0, '-- claude    claude-acp\r\nok codex     codex-acp\r\n');
    expect(await plugin.detect()).toEqual({ available: true, executablePath: process.execPath });
    expect(spawn.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(spawn.mock.calls[0]?.[1]).toEqual(['--list']);
  });

  test('detect rejects uninstalled agents', async () => {
    fakeProcess(0, '-- codex codex-acp\nok claude claude-acp\n');
    expect((await plugin.detect()).error).toContain('not installed');
  });

  test('detect rejects absent agents and substring matches', async () => {
    fakeProcess(0, 'ok codex-other codex-acp\nok claude /codex\n');
    expect((await plugin.detect()).error).toContain('not found in acp-run --list');
  });

  test('detect reports list execution failures', async () => {
    fakeProcess(1, '', 'missing dependency');
    expect((await plugin.detect()).error).toContain('missing dependency');
  });

  test('detect reports spawn failures', async () => {
    fakeProcess(1, '', '', new Error('permission denied'));
    expect((await plugin.detect()).error).toContain('permission denied');
  });

  test('detect reports a missing binary', async () => {
    await plugin.initialize({ agent: 'codex', command: '/nonexistent/acp-test-binary' });
    const result = await plugin.detect();
    expect(result.available).toBe(false);
    expect(result.error).toContain('/nonexistent/acp-test-binary');
  });

  test('detect requires a configured agent', async () => {
    await plugin.initialize({});
    expect((await plugin.detect()).error).toContain('options.agent');
  });

  for (const [code, status] of [[0, 'completed'], [1, 'failed'], [5, 'failed'], [124, 'timeout'], [75, 'failed']] as const) {
    test(`maps exit ${code} to ${status} for promise and callback`, async () => {
      const stderr = 'acp-run: agent=codex stop=error secs=1';
      const { proc, spawn } = fakeProcess(code, 'final answer', stderr);
      let input = '';
      proc.stdin.on('data', (chunk) => { input += chunk.toString(); });
      const onEnd = mock((_result: AgentExecutionResult) => {});
      const result = await plugin.execute('secret prompt', undefined, { onEnd }).promise;
      expect(result.status).toBe(status);
      expect(result.exitCode).toBe(code);
      expect(result.stdout).toBe('final answer');
      expect(result.error).toBe(code === 0 ? undefined : stderr);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onEnd.mock.calls[0]?.[0]).toBe(result);
      expect(input).toBe('secret prompt');
      expect(spawn.mock.calls[0]?.[1]).not.toContain('secret prompt');
    });
  }

  test('prefers FAILED classification over trailing summary', async () => {
    fakeProcess(1, '', 'acp-run: FAILED quota: exhausted\nacp-run: agent=codex stop=error\n');
    const result = await plugin.execute('prompt').promise;
    expect(result.error).toBe('acp-run: FAILED quota: exhausted');
  });

  test('falls back to exit code when stderr is empty', async () => {
    fakeProcess(5);
    expect((await plugin.execute('prompt').promise).error).toBe('acp-run exited with code 5');
  });

  test('preserves user interruption even when process reports timeout', async () => {
    fakeProcess(124);
    const result = await plugin.execute('prompt', undefined, {
      onStart: (id) => { plugin.interrupt(id); },
    }).promise;
    expect(result.status).toBe('interrupted');
    expect(result.interrupted).toBe(true);
  });
});
