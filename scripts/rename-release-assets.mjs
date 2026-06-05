#!/usr/bin/env node

const version = process.env.VERSION || process.argv[2] || '';
const repository = process.env.GITHUB_REPOSITORY || process.argv[3] || '';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!version.startsWith('v')) {
  throw new Error('VERSION must be a tag like v1.0.22');
}
if (!repository.includes('/')) {
  throw new Error('GITHUB_REPOSITORY must be set, for example owner/repo');
}
if (!token) {
  throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
}

const appVersion = version.slice(1);
const [owner, repo] = repository.split('/');
const apiBase = 'https://api.github.com';

const renameMap = new Map([
  [`better-douyin-R_${appVersion}_aarch64.dmg`, `better-douyin-R-v${appVersion}-macos-arm64.dmg`],
  [`better-douyin-R_${appVersion}_x64.dmg`, `better-douyin-R-v${appVersion}-macos-x64.dmg`],
  ['better-douyin-R_aarch64.app.tar.gz', `better-douyin-R-v${appVersion}-macos-arm64-updater.tar.gz`],
  ['better-douyin-R_x64.app.tar.gz', `better-douyin-R-v${appVersion}-macos-x64-updater.tar.gz`],
  [`better-douyin-R_${appVersion}_x64-setup.exe`, `better-douyin-R-v${appVersion}-windows-x64-installer.exe`],
  [`better-douyin-R-v${appVersion}-windows-x64-portable.exe`, `better-douyin-R-v${appVersion}-windows-x64-portable-updater.exe`],
  [`better-douyin-R_${appVersion}_amd64.AppImage`, `better-douyin-R-v${appVersion}-linux-x64.AppImage`],
  [`better-douyin-R_${appVersion}_amd64.deb`, `better-douyin-R-v${appVersion}-linux-x64.deb`],
  [`better-douyin-R-${appVersion}-1.x86_64.rpm`, `better-douyin-R-v${appVersion}-linux-x64.rpm`],
]);

for (const [from, to] of [...renameMap]) {
  renameMap.set(`${from}.sig`, `${to}.sig`);
}

async function github(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${response.status} ${body}`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

const release = await github(`/repos/${owner}/${repo}/releases/tags/${version}`);
const assets = await github(`/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`);
const byName = new Map(assets.map((asset) => [asset.name, asset]));

for (const [from, to] of renameMap) {
  const source = byName.get(from);
  if (!source || from === to) {
    continue;
  }

  const existing = byName.get(to);
  if (existing && existing.id !== source.id) {
    await github(`/repos/${owner}/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
    byName.delete(to);
    console.log(`Deleted duplicate asset: ${to}`);
  }

  await github(`/repos/${owner}/${repo}/releases/assets/${source.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: to }),
  });

  byName.delete(from);
  byName.set(to, { ...source, name: to });
  console.log(`Renamed ${from} -> ${to}`);
}
