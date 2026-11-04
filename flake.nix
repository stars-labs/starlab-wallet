{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    { nixpkgs, flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      perSystem =
        { pkgs, ... }:
        {
          devShells.default = pkgs.mkShell {
            # Browser extension is TS/Svelte (WXT) + a vendored WASM artifact —
            # no Rust toolchain or graphics libs needed to build it.
            nativeBuildInputs = with pkgs; [
              bun
              nodejs_26
            ];
            shellHook = ''
              echo "🦊 Starlab Wallet dev shell (WXT + Svelte + FROST WASM)"
              echo "  bun install      - install deps"
              echo "  bun run dev      - extension dev server (hot reload)"
              echo "  bun run build    - production build"
            '';
          };
        };
    };
}
