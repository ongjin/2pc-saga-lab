import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

describe('cli', () => {
  test('prints usage before requiring database environment for invalid args', async () => {
    const result = await runCliExpectingFailure(['bad']);

    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      'Usage: npm run demo -- <2pc|saga> <happy|payment-fail|inventory-fail|crash>',
    );
    expect(result.stdout).toContain('Recovery: npm run demo -- 2pc recover');
    expect(result.stderr).not.toContain('Missing required environment variable');
  });
});

async function runCliExpectingFailure(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    await execFileAsync('npm', ['run', 'demo', '--', ...args], {
      cwd: process.cwd(),
      env: cliEnvWithoutDbs(),
      timeout: 10_000,
    });
  } catch (error) {
    const result = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      code: result.code ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  throw new Error('expected CLI command to fail');
}

function cliEnvWithoutDbs(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: '/tmp/2pc-saga-lab-empty-env',
  };
  delete env.ORDER_DB_URL;
  delete env.PAYMENT_DB_URL;
  delete env.INVENTORY_DB_URL;
  return env;
}
