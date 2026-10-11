/**
 * ABOUTME: Generic ACP agent plugin using acp-run for unattended coding tasks.
 * Sends prompts through stdin and preserves acp-run completion and failure diagnostics.
 */

import { spawn } from 'node:child_process';
import { BaseAgentPlugin, quoteForWindowsShell, shouldUseWindowsShell } from '../base.js';
import type {
  AgentDetectResult,
  AgentExecuteOptions,
  AgentExecutionHandle,
  AgentFileContext,
  AgentPluginFactory,
  AgentPluginMeta,
  AgentSetupQuestion,
} from '../types.js';

/** Generic adapter for the agents advertised by acp-run --list. */
export class AcpAgentPlugin extends BaseAgentPlugin {
  readonly meta: AgentPluginMeta = {
    id: 'acp',
    name: 'ACP (acp-run)',
    description: 'Run coding agents through the Agent Client Protocol using acp-run',
    version: '1.0.0',
    defaultCommand: 'acp-run',
    supportsStreaming: false,
    supportsInterrupt: true,
    supportsFileContext: false,
    supportsSubagentTracing: false,
  };

  private agent = '';
  private model = '';

  override async initialize(config: Record<string, unknown>): Promise<void> {
    await super.initialize(config);
    this.agent = typeof config.agent === 'string' ? config.agent.trim() : '';
    this.model = typeof config.model === 'string' ? config.model.trim() : '';
    // ACP owns its seconds-based timeout; do not also interpret it as milliseconds.
    this.defaultTimeout = 0;
  }

  override async detect(): Promise<AgentDetectResult> {
    if (!this.agent) {
      return { available: false, error: 'Configure options.agent with an acp-run agent name.' };
    }
    const resolved = await this.resolveCommandPath();
    if (!resolved) {
      return {
        available: false,
        error: `acp-run executable not found: ${this.commandPath ?? this.meta.defaultCommand}. Install it or configure command.`,
      };
    }
    const executablePath = resolved.executablePath;
    return new Promise((resolve) => {
      const useShell = shouldUseWindowsShell(executablePath);
      const proc = spawn(useShell ? quoteForWindowsShell(executablePath) : executablePath, ['--list'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: AgentDetectResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ executablePath, ...result });
      };
      const timer = setTimeout(() => {
        proc.kill();
        finish({ available: false, error: 'Timeout waiting for acp-run --list' });
      }, 15000);
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('error', (error) => {
        finish({ available: false, error: `Failed to execute acp-run --list: ${error.message}` });
      });
      proc.on('close', (code) => {
        if (code !== 0) {
          finish({ available: false, error: `acp-run --list exited with code ${code}: ${stderr.trim()}` });
          return;
        }
        const entry = stdout.split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .find(([status, name]) => (status === 'ok' || status === '--') && name === this.agent);
        if (entry?.[0] !== 'ok') {
          finish({
            available: false,
            error: entry
              ? `acp-run agent "${this.agent}" is not installed (-- in acp-run --list).`
              : `acp-run agent "${this.agent}" was not found in acp-run --list.`,
          });
          return;
        }
        this.commandPath = executablePath;
        finish({ available: true });
      });
    });
  }

  protected buildArgs(
    _prompt: string,
    _files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): string[] {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(this.agent)) {
      throw new Error('Configure options.agent with an acp-run agent name.');
    }
    // Ralph supplies runtime model overrides in flags; honor those during validation.
    const flags = [...this.defaultFlags, ...(options?.flags ?? [])];
    const modelIndex = flags.lastIndexOf('--model');
    const model = modelIndex >= 0 ? flags[modelIndex + 1] ?? '' : this.model;
    const modelError = this.validateModel(model);
    if (modelError) throw new Error(modelError);
    const perm = this.config.perm ?? 'all';
    if (typeof perm !== 'string' || !/^(all|deny|scoped:.+)$/.test(perm)) {
      throw new Error('ACP perm must be all, deny, or scoped:<paths>.');
    }
    const args = [this.agent, '-C', options?.cwd ?? process.cwd(), '--perm', perm];
    if (this.agent !== 'zcode' && model) args.push('--model', model);
    if (typeof this.config.mode === 'string' && this.config.mode.trim()) {
      args.push('--mode', this.config.mode);
    }
    if (this.config.set !== undefined) {
      if (!Array.isArray(this.config.set) || this.config.set.some(
        (value) => typeof value !== 'string' || !/^[^=\s]+=/.test(value)
      )) {
        throw new Error('ACP set must be a list of key=value strings.');
      }
      for (const value of this.config.set as string[]) args.push('--set', value);
    }
    if (this.config.timeout !== undefined) {
      if (typeof this.config.timeout !== 'number' || !Number.isFinite(this.config.timeout) || this.config.timeout <= 0) {
        throw new Error('ACP timeout must be a positive number of seconds.');
      }
      args.push('--timeout', String(this.config.timeout));
    }
    return args;
  }

  protected override getStdinInput(prompt: string): string {
    return prompt;
  }

  override execute(
    prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): AgentExecutionHandle {
    return super.execute(prompt, files, {
      ...options,
      onEnd: (result) => {
        // Mutate before the base resolves so callbacks and the promise see the same result.
        if (result.status !== 'interrupted' && result.status !== 'timeout') {
          if (result.exitCode === 124) result.status = 'timeout';
          if (result.exitCode !== undefined && result.exitCode !== 0) {
            const lines = result.stderr.trim().split(/\r?\n/);
            result.error = lines.find((line) => /^(?:acp-run: )?FAILED\b/.test(line))
              || [...lines].reverse().find((line) => line.startsWith('acp-run:'))
              || lines.at(-1)
              || `acp-run exited with code ${result.exitCode}`;
          }
        }
        options?.onEnd?.(result);
      },
    });
  }

  override validateModel(model: string): string | null {
    if (this.agent === 'zcode') {
      return model.trim() ? 'zcode does not support a model option; leave model empty.' : null;
    }
    return model.trim() ? null : 'ACP requires a model for every agent except zcode.';
  }

  override async validateSetup(answers: Record<string, unknown>): Promise<string | null> {
    const agent = typeof answers.agent === 'string' ? answers.agent.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agent)) return 'An acp-run agent name is required.';
    const model = typeof answers.model === 'string' ? answers.model.trim() : '';
    if (agent === 'zcode') return model ? 'Leave model empty for zcode.' : null;
    return model ? null : 'A model is required (except for zcode).';
  }

  override getSetupQuestions(): AgentSetupQuestion[] {
    return [
      ...super.getSetupQuestions().filter((question) => question.id !== 'timeout'),
      { id: 'agent', prompt: 'acp-run agent name:', type: 'text', required: true,
        help: 'Choose an installed agent from acp-run --list.' },
      { id: 'model', prompt: 'Model (leave empty only for zcode):', type: 'text', required: false,
        help: 'Required except for zcode. Inspect available models with acp-run <agent> --info.' },
    ];
  }
}

/** Factory for the built-in ACP plugin. */
const createAcpAgent: AgentPluginFactory = () => new AcpAgentPlugin();
export default createAcpAgent;
