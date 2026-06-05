#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.env.VERSION || process.argv[2] || '').replace(/^v/, '');
const releaseDir = path.resolve(process.env.RELEASE_DIR || process.argv[3] || process.cwd());
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Provide VERSION as 0.0.9 or v0.0.9');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, file))).digest('hex');
}

function readTemplate(relativePath) {
  return fs.readFileSync(path.join(rootDir, 'packaging/package-managers', relativePath), 'utf8');
}

function writeGenerated(relativePath, content) {
  const outputPath = path.join(rootDir, 'packaging/package-managers/generated', `v${version}`, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
  console.log(`Wrote ${path.relative(rootDir, outputPath)}`);
}

const replacements = {
  '{{VERSION}}': version,
  '{{SHA256_DMG_ARM64}}': sha256(`better-douyin-R-v${version}-macos-arm64.dmg`),
  '{{SHA256_DMG_X64}}': sha256(`better-douyin-R-v${version}-macos-x64.dmg`),
  '{{SHA256_WINDOWS_INSTALLER}}': sha256(`better-douyin-R-v${version}-windows-x64-installer.exe`).toUpperCase(),
  '{{SHA256_WINDOWS_PORTABLE}}': sha256(`better-douyin-R-v${version}-windows-x64-portable.zip`)
};

function applyReplacements(content) {
  return Object.entries(replacements).reduce(
    (next, [needle, value]) => next.replaceAll(needle, value),
    content
  );
}

const files = [
  ['homebrew/better-douyin-r.rb', 'homebrew/better-douyin-r.rb'],
  ['scoop/better-douyin-r.json', 'scoop/better-douyin-r.json'],
  ['winget/AnYuJia.BetterDouyinR/AnYuJia.BetterDouyinR.yaml', 'winget/AnYuJia.BetterDouyinR.yaml'],
  ['winget/AnYuJia.BetterDouyinR/AnYuJia.BetterDouyinR.locale.zh-CN.yaml', 'winget/AnYuJia.BetterDouyinR.locale.zh-CN.yaml'],
  ['winget/AnYuJia.BetterDouyinR/AnYuJia.BetterDouyinR.installer.yaml', 'winget/AnYuJia.BetterDouyinR.installer.yaml']
];

for (const [templatePath, outputPath] of files) {
  writeGenerated(outputPath, applyReplacements(readTemplate(templatePath)));
}
