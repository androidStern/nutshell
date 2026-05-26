class Nutshell < Formula
  desc "Local personal trace ingestion runtime"
  homepage "https://github.com/androidStern/nutshell"
  url "https://github.com/androidStern/nutshell/releases/download/v0.1.7/nutshell-0.1.7-darwin-arm64.tar.gz"
  version "0.1.7"
  sha256 "53c81981f0279b4f17be54b4eb78ffe997b835241f533ce297e590995b3a93a6"
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
