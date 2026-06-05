cask "better-douyin-r" do
  version "{{VERSION}}"

  on_arm do
    sha256 "{{SHA256_DMG_ARM64}}"
    url "https://github.com/anYuJia/better-douyin-R/releases/download/v#{version}/better-douyin-R-v#{version}-macos-arm64.dmg"
  end

  on_intel do
    sha256 "{{SHA256_DMG_X64}}"
    url "https://github.com/anYuJia/better-douyin-R/releases/download/v#{version}/better-douyin-R-v#{version}-macos-x64.dmg"
  end

  name "better-douyin-R"
  desc "Better Douyin desktop toolkit built with Rust and Tauri"
  homepage "https://github.com/anYuJia/better-douyin-R"

  app "better-douyin-R.app"
end
