import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MOCK_API_KEY, MOCK_MODEL, startMockProvider } from './mock-provider';

async function main() {
  const root = process.cwd();
  const dataDir = mkdtempSync(path.join(root, '.test-data-e2e-'));
  const provider = await startMockProvider();
  console.info(`[e2e] Isolated data: ${dataDir}`);
  console.info(`[e2e] Local provider: ${provider.baseURL}`);
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MEMOAGENT_DATA_DIR: dataDir,
      LLM_BASE_URL: provider.baseURL,
      LLM_API_KEY: MOCK_API_KEY,
      LLM_MODEL: MOCK_MODEL,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  let stopping = false;
  async function stop(code: number) {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => { child.kill('SIGKILL'); process.exit(code); }, 5_000);
    timer.unref();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
    }
    await provider.close();
    clearTimeout(timer);
    // Keep this run's isolated files for failure inspection; never touch the application workspace.
    process.exit(code);
  }
  process.once('SIGINT', () => { void stop(0); });
  process.once('SIGTERM', () => { void stop(0); });
  child.once('error', error => { console.error(error); void stop(1); });
  child.once('exit', code => { void stop(code ?? 1); });
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
