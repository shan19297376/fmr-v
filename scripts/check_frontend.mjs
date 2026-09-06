import fs from 'node:fs';
import { parse } from 'acorn';

const files = ['public/shell.js', 'public/apps/health.js'];
let failed = false;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: false,
      locations: true,
    });
    console.log(`${file}: syntax OK`);
  } catch (error) {
    failed = true;
    const line = error.loc?.line ?? '?';
    const column = error.loc?.column ?? '?';
    console.error(`${file}:${line}:${column}: ${error.message}`);
  }
}

if (failed) process.exit(1);
