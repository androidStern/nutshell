class Nutshell < Formula
  desc "Local personal trace ingestion runtime"
  homepage "https://github.com/androidStern/nutshell"
  url "https://github.com/androidStern/nutshell/releases/download/v0.1.1/nutshell-0.1.1-darwin-arm64.tar.gz"
  version "0.1.1"
  sha256 "387fc7d8583d8757dbac53ada0e4ff331ba5f713a195c6f8a7b4c655972e111b"
  license "MIT"

  def install
    bin.install "bin/nutshell"
    prefix.install "Nutshell.app" if File.directory?("Nutshell.app")
  end

  def caveats
    <<~EOS
      Run `nutshell setup` after install. Protected-data sync is owned by Nutshell.app, not a Homebrew service.
    EOS
  end

  test do
    ENV["NUTSHELL_CONFIG"] = testpath/"nutconfig.jsonc"
    ENV["NUTSHELL_ROOT"] = testpath/"Nutshell"
    system bin/"nutshell", "--version"
    assert_match "nutshell setup", shell_output("#{bin}/nutshell help")
  end
end
