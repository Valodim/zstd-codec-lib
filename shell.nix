let
  pkgs = import <nixpkgs> {};
  playwrightPkgs = import (builtins.fetchTarball {
    name = "nixos-unstable-20250-09-23";
    url = "https://github.com/nixos/nixpkgs/archive/b2a3852bd078e68dd2b3dfa8c00c67af1f0a7d20.tar.gz";
    sha256 = "sha256:0lgg0bw6gnaa0sg45da65qzmhwrwjj7gsq2scfq8wcbv0bnc9xb9";
  }) {};
in
  pkgs.mkShell {
    packages = with pkgs; [
      nodejs_22
      yarn
      bun
      llvmPackages_21.clang-unwrapped
      llvmPackages_21.lld
      binaryen
      gnumake
      zopfli
    ];

    LLVM_DIR = pkgs.llvmPackages_21.clang-unwrapped;

    # for driving playwright
    PLAYWRIGHT_BROWSERS_PATH = playwrightPkgs.playwright-driver.browsers;
  }
