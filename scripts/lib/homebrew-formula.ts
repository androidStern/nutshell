export interface FormulaArtifact {
  url: string;
  sha256: string;
}

export interface FormulaInput {
  version: string;
  homepage: string;
  arm64: FormulaArtifact;
  x64: FormulaArtifact;
}

export function homebrewFormula(input: FormulaInput): string {
  return `class Nutshell < Formula
  desc "Local personal trace ingestion runtime"
  homepage "${input.homepage}"
  version "${input.version}"
  license "MIT"

  depends_on macos: :sonoma

  on_arm do
    url "${input.arm64.url}"
    sha256 "${input.arm64.sha256}"
  end

  on_intel do
    url "${input.x64.url}"
    sha256 "${input.x64.sha256}"
  end

  def install
    bin.install "bin/nutshell"
    prefix.install "Nutshell.app" if File.directory?("Nutshell.app")
  end

  def caveats
    <<~EOS
      Run \`nutshell setup\` after install. Protected-data sync is owned by Nutshell.app, not a Homebrew service.
    EOS
  end

  test do
    ENV["NUTSHELL_CONFIG"] = testpath/"nutconfig.jsonc"
    ENV["NUTSHELL_ROOT"] = testpath/"Nutshell"
    system bin/"nutshell", "--version"
    assert_match "nutshell setup", shell_output("#{bin}/nutshell help")
  end
end
`;
}
