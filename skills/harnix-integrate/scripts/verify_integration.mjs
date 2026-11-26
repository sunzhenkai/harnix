#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  let hostDir = '';
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      hostDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (arg === '--json') {
      json = true;
    }
  }
  if (!hostDir) {
    throw new Error('Usage: verify_integration.mjs --host <host-dir> [--json]');
  }
  return { hostDir, json };
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir, exts, out = []) {
  if (!(await fileExists(dir))) return out;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const { hostDir, json } = parseArgs(process.argv.slice(2));
  const checks = [];

  // 1. package.json dependency check
  const pkgPath = path.join(hostDir, 'package.json');
  let usesVendor = false;
  if (!(await fileExists(pkgPath))) {
    checks.push({ id: 'package_dependency', status: 'fail', message: 'package.json not found' });
  } else {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const hasHarnix = Boolean(deps['harnix'] || deps['@harnix/core']);
    if (!hasHarnix) {
      checks.push({
        id: 'package_dependency',
        status: 'fail',
        message: 'package.json dependencies missing harnix or @harnix/core',
      });
    } else {
      const harnixDep = String(deps['harnix'] ?? '');
      if (harnixDep.startsWith('file:./vendor/harnix/')) {
        usesVendor = true;
        const tgzExists = await fileExists(path.join(hostDir, harnixDep.slice('file:./'.length)));
        const overrides = pkg.overrides ?? {};
        const hasOverrides = ['@harnix/core', '@harnix/native', '@harnix/pi', '@harnix/acp'].every((name) =>
          Boolean(overrides[name]),
        );
        if (!tgzExists || !hasOverrides) {
          checks.push({
            id: 'package_dependency',
            status: 'fail',
            message: 'Vendor tarball missing or package.json overrides incomplete for @harnix/* subpackages',
          });
        } else {
          checks.push({
            id: 'package_dependency',
            status: 'pass',
            message: 'harnix vendor tarball and @harnix/* overrides configured',
          });
        }
      } else {
        checks.push({
          id: 'package_dependency',
          status: 'pass',
          message: 'harnix dependency configured in package.json',
        });
      }
    }
  }

  // 2. Dockerfile vendor check (stage-aware for multi-stage Dockerfiles)
  const dockerfilePath = path.join(hostDir, 'Dockerfile');
  if (await fileExists(dockerfilePath)) {
    const df = await fs.readFile(dockerfilePath, 'utf8');
    if (usesVendor) {
      const stages = df.split(/^FROM\s+/mu).slice(1);
      const vendorStages = stages.filter((s) => s.includes('vendor/harnix'));
      if (vendorStages.length === 0) {
        checks.push({
          id: 'dockerfile_vendor',
          status: 'fail',
          message: 'Dockerfile must COPY vendor/harnix before RUN npm ci',
        });
      } else {
        const allValid = vendorStages.every((stage) => {
          const copyIdx = stage.indexOf('vendor/harnix');
          const ciMatch = /\bnpm\s+(?:ci|install)\b/u.exec(stage);
          return ciMatch === null || copyIdx < ciMatch.index;
        });
        checks.push({
          id: 'dockerfile_vendor',
          status: allValid ? 'pass' : 'fail',
          message: allValid
            ? 'Dockerfile copies vendor/harnix before npm ci in build stage'
            : 'Dockerfile stage with vendor/harnix must COPY it before RUN npm ci/install',
        });
      }
    } else {
      checks.push({
        id: 'dockerfile_vendor',
        status: 'pass',
        message: 'Dockerfile checked (non-vendor dependency)',
      });
    }
  }

  // 3 & 4. Backend harness bridge & three kinds
  const srcFiles = await collectFiles(path.join(hostDir, 'src'), ['.ts', '.js']);
  const srcContents = await Promise.all(srcFiles.map((f) => fs.readFile(f, 'utf8')));
  const combinedSrc = srcContents.join('\n');

  const hasHarnixImport = /from\s+['"](?:harnix|@harnix\/core)['"]/u.test(combinedSrc);
  const hasFactoryOrSettings =
    combinedSrc.includes('createHarness') &&
    (combinedSrc.includes('normalizeHarnixSettings') || combinedSrc.includes('HarnixSettings'));
  if (!hasHarnixImport || !hasFactoryOrSettings) {
    checks.push({
      id: 'backend_harness_bridge',
      status: 'fail',
      message: 'Backend src/ missing harnix import, createHarness, or HarnixSettings integration',
    });
  } else {
    checks.push({
      id: 'backend_harness_bridge',
      status: 'pass',
      message: 'Backend integrates harnix createHarness and HarnixSettings',
    });
  }

  const hasThreeKinds =
    combinedSrc.includes('native') && combinedSrc.includes('pi') && combinedSrc.includes('acp');
  const hasProbeOrDescriptors =
    combinedSrc.includes('probeHarness') || combinedSrc.includes('listHarnessDescriptors');
  if (!hasThreeKinds || !hasProbeOrDescriptors) {
    checks.push({
      id: 'backend_three_kinds',
      status: 'fail',
      message: 'Backend missing full native/pi/acp support or harness probe/descriptors endpoints',
    });
  } else {
    checks.push({
      id: 'backend_three_kinds',
      status: 'pass',
      message: 'Backend supports native/pi/acp and harness probe/descriptors',
    });
  }

  // 4b. Database agent_kind CHECK constraint check (if SQL CHECK exists)
  const hasAgentKindCheck = /agent_kind\b[^;\n]*\bCHECK\s*\(/iu.test(combinedSrc);
  if (hasAgentKindCheck) {
    const allowsPi = /CHECK\s*\(\s*agent_kind\s+IN\s*\([^)]*'pi'[^)]*\)\s*\)/iu.test(combinedSrc);
    checks.push({
      id: 'db_agent_kind_constraint',
      status: allowsPi ? 'pass' : 'fail',
      message: allowsPi
        ? "Database agent_kind CHECK constraint includes 'pi'"
        : "Database agent_kind CHECK constraint found without 'pi'; add migration to allow ('native','pi','acp')",
    });
  }

  // 4c. Legacy runtime cleanup warning
  const hasLegacyRuntimeDir = await fileExists(path.join(hostDir, 'src', 'agentruntime'));
  const hasLegacyAcpJsonRpc = await fileExists(path.join(hostDir, 'src', 'acp', 'jsonrpc.ts'));
  if (hasLegacyRuntimeDir || hasLegacyAcpJsonRpc) {
    checks.push({
      id: 'legacy_runtime_cleanup',
      status: 'warn',
      message: 'Legacy src/agentruntime or src/acp/jsonrpc.ts still present; verify cleanup if migrating',
    });
  }

  // 5. Frontend harness settings check (if web/src exists)
  const webSrcDir = path.join(hostDir, 'web', 'src');
  if (await fileExists(webSrcDir)) {
    const webFiles = await collectFiles(webSrcDir, ['.ts', '.tsx']);
    const webContents = await Promise.all(webFiles.map((f) => fs.readFile(f, 'utf8')));
    const combinedWeb = webContents.join('\n');
    const hasHarnessUi =
      combinedWeb.includes('harnix_settings') &&
      combinedWeb.includes('harness') &&
      combinedWeb.includes('native') &&
      combinedWeb.includes('pi') &&
      combinedWeb.includes('acp');
    if (!hasHarnessUi) {
      checks.push({
        id: 'frontend_harness_settings',
        status: 'fail',
        message: 'Frontend web/src missing harnix_settings or native/pi/acp settings UI',
      });
    } else {
      checks.push({
        id: 'frontend_harness_settings',
        status: 'pass',
        message: 'Frontend web/src includes harnix_settings and native/pi/acp UI',
      });
    }

    const modelsSettingsPath = path.join(webSrcDir, 'pages', 'settings', 'models.tsx');
    if (await fileExists(modelsSettingsPath)) {
      const modelsContent = await fs.readFile(modelsSettingsPath, 'utf8');
      const harnessSettingsPath = path.join(webSrcDir, 'pages', 'settings', 'harness.tsx');
      const harnessContent = (await fileExists(harnessSettingsPath))
        ? await fs.readFile(harnessSettingsPath, 'utf8')
        : '';

      const colocated =
        modelsContent.includes('Harness') || modelsContent.includes('harnix_settings');
      const hasSplitTabs =
        harnessContent.includes('<Tabs') && harnessContent.includes('TabsList');

      if (!colocated) {
        checks.push({
          id: 'frontend_harness_model_colocation',
          status: 'fail',
          message: 'web/src/pages/settings/models.tsx must co-locate and couple Harness settings with Model/Provider settings',
        });
      } else if (hasSplitTabs) {
        checks.push({
          id: 'frontend_harness_model_colocation',
          status: 'fail',
          message: 'web/src/pages/settings/harness.tsx must use single active-kind selection instead of disconnected Tabs/TabsList',
        });
      } else {
        checks.push({
          id: 'frontend_harness_model_colocation',
          status: 'pass',
          message: 'Model and Harness settings are co-located in models.tsx without disconnected Tabs',
        });
      }
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  const report = { ok, hostDir, checks };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
