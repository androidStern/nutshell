class Nutshell < Formula
  desc "Local personal trace ingestion runtime"
  homepage "https://github.com/androidStern/nutshell"
  url "https://github.com/androidStern/nutshell/releases/download/v0.1.5/nutshell-0.1.5-darwin-arm64.tar.gz"
  version "0.1.5"
  sha256 "a9783ca29b3081fe4f2b320c9f67046c890a5093c8622c89c653759c316d43e7"
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
