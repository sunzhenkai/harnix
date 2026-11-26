#!/usr/bin/env node
import { runCli } from './runner.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`harnix error: ${msg}\n`);
    process.exitCode = 1;
  },
);
