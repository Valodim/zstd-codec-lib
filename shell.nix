{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    yarn
    bun
    llvmPackages_21.clang-unwrapped
    lld
    binaryen
    gnumake
    zopfli
  ];

  shellHook = ''
    export LLVM_DIR=${pkgs.llvmPackages_21.clang-unwrapped}
  '';
}
