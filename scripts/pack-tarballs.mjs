#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseOutDir(argv) {
  const idx = argv.indexOf('--out');
  if (idx >= 0 && argv[idx + 1]) {
    return path.resolve(process.cwd(), argv[idx + 1]);
  }
  return path.join(repoRoot, 'dist-tarballs');
}

const PACKAGES = [
  { dir: 'packages/core', pkgName: '@harnix/core', tgzName: 'harnix-core.tgz' },
  { dir: 'packages/native', pkgName: '@harnix/native', tgzName: 'harnix-native.tgz' },
  { dir: 'packages/pi', pkgName: '@harnix/pi', tgzName: 'harnix-pi.tgz' },
  { dir: 'packages/acp', pkgName: '@harnix/acp', tgzName: 'harnix-acp.tgz' },
  { dir: 'packages/harnix', pkgName: 'harnix', tgzName: 'harnix.tgz' },
];

async function main() {
  const outDir = parseOutDir(process.argv.slice(2));
  await fs.mkdir(outDir, { recursive: true });

  const outputs = [];
  for (const item of PACKAGES) {
    const pkgDir = path.join(repoRoot, item.dir);
    const stdout = execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
      cwd: pkgDir,
      encoding: 'utf8',
    });
    const lines = stdout
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter(Boolean);
    const producedPath = lines[lines.length - 1];
    if (!producedPath) {
      throw new Error(`pnpm pack did not output a tarball path for ${item.pkgName}`);
    }
    const resolvedProduced = path.isAbsolute(producedPath)
      ? producedPath
      : path.resolve(pkgDir, producedPath);
    const targetPath = path.join(outDir, item.tgzName);
    if (resolvedProduced !== targetPath) {
      await fs.rename(resolvedProduced, targetPath);
    }

    const pkgJsonText = execFileSync('tar', ['-xOzf', targetPath, 'package/package.json'], {
      encoding: 'utf8',
    });
    if (pkgJsonText.includes('workspace:')) {
      throw new Error(`Tarball ${item.tgzName} still contains unresolved workspace: protocol`);
    }

    outputs.push({
      package: item.pkgName,
      tarball: item.tgzName,
      path: targetPath,
    });
  }

  const summary = {
    ok: true,
    outDir,
    tarballs: outputs,
    recommendedDependencies: {
      harnix: 'file:./vendor/harnix/harnix.tgz',
    },
    recommendedOverrides: {
      '@harnix/core': 'file:./vendor/harnix/harnix-core.tgz',
      '@harnix/native': 'file:./vendor/harnix/harnix-native.tgz',
      '@harnix/pi': 'file:./vendor/harnix/harnix-pi.tgz',
      '@harnix/acp': 'file:./vendor/harnix/harnix-acp.tgz',
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
