# Package Manager Distribution

This directory contains starter manifests for package-manager distribution after a GitHub Release is published.

Recommended order:

1. Publish the GitHub Release and wait for all assets to upload.
2. Generate SHA-256 hashes for the installer assets.
3. Replace `{{VERSION}}` and `{{SHA256_*}}` placeholders in the manifests.
4. Submit the manifests to the target package-manager repositories.

## Asset Mapping

| Channel | Asset |
|:---|:---|
| Homebrew Cask arm64 | `better-douyin-R-v{{VERSION}}-macos-arm64.dmg` |
| Homebrew Cask x64 | `better-douyin-R-v{{VERSION}}-macos-x64.dmg` |
| Scoop | `better-douyin-R-v{{VERSION}}-windows-x64-portable.zip` |
| winget installer | `better-douyin-R-v{{VERSION}}-windows-x64-installer.exe` |

## Hashes

Download the release assets:

```bash
VERSION=v0.0.12
gh release download "$VERSION" --pattern 'better-douyin-R-v*'
```

Then generate version-pinned manifests:

```bash
VERSION=v0.0.12 node scripts/generate-package-manifests.mjs
```

The script computes SHA-256 hashes and writes files under `generated/<version>/`.

The templates with placeholders are:

- `homebrew/better-douyin-r.rb`
- `scoop/better-douyin-r.json`
- `winget/AnYuJia.BetterDouyinR/*.yaml`

Generated, version-pinned manifests are stored under `generated/<version>/` after a release has been published and hashes have been verified.

## Notes

- Homebrew Cask usually belongs in `homebrew-cask/Casks/b/better-douyin-r.rb`.
- Scoop can be maintained in a custom bucket first, then submitted to a public bucket if desired.
- winget manifests are normally submitted to `microsoft/winget-pkgs` under `manifests/a/AnYuJia/BetterDouyinR/{{VERSION}}/`.
- Store submission can be done after one stable release has been verified manually.
