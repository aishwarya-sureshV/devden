class Devden < Formula
  desc "Web workbench for pi, Claude Code, Grok, and Codex"
  homepage "https://github.com/aishwarya-sureshV/devden"
  license "MIT"
  head "https://github.com/aishwarya-sureshV/devden.git", branch: "main"

  depends_on "node"

  def install
    # dist/ is gitignored. Build it before npm copies the package into libexec.
    # package.json "files" is bin, server, and dist.
    system "npm", "install"
    system "npm", "run", "build"
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      DevDen runs on macOS and Linux. The launcher is a bash script.
      On macOS, node-pty ships a prebuilt binary, so Xcode is not required.
      On Linux, node-pty 1.1.0 has no prebuild and compiles during install
      (Python, make, and a C++ compiler).
    EOS
  end

  test do
    assert_predicate bin/"devden", :exist?
  end
end
