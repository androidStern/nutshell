class Nutshell < Formula
  desc "Local personal trace ingestion runtime"
  homepage "https://github.com/winterfell/nutshell"
  url "https://github.com/winterfell/nutshell/releases/download/v0.1.0/nutshell-0.1.0-darwin-arm64.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  def install
    bin.install "bin/nutshell"
  end

  service do
    run [opt_bin/"nutshell", "sync", "all", "--mode", "recent", "--json"]
    run_type :interval
    interval 900
    environment_variables PATH: std_service_path_env
  end

  test do
    ENV["NUTSHELL_CONFIG"] = testpath/"nutconfig.jsonc"
    ENV["NUTSHELL_ROOT"] = testpath/"Nutshell"
    system bin/"nutshell", "--version"
    system bin/"nutshell", "init"
    assert_match "\"status\"", shell_output("#{bin}/nutshell health --json", 2)
  end
end
