export type NeruVariant = "wasm32_nommu" | "wasm64_nommu";

export interface NeruArtifactPaths {
  root: string;
  kernel: string;
  initramfs: string;
  browserRuntime: string;
  browserWorker: string;
  manifest: string;
}

export interface NeruBuildOptions {
  userland: string;
  output?: string;
  variant?: NeruVariant;
  workspace?: string;
  rebuildLinux?: boolean;
  sharedFs?: string;
  sharedFsToken?: string;
}

export interface NeruBootOptions {
  artifactRoot?: string;
  linuxRuntime?: string;
  kernel?: string;
  initramfs?: string;
  sharedFs?: string;
  sharedFsToken?: string;
  argv?: string[];
  environment?: Record<string, string>;
}

export interface NeruBootPlan {
  executable: string;
  argv: string[];
  environment: Record<string, string>;
  kernel: string;
  initramfs: string;
  browserRuntime: string;
  browserWorker: string;
  sharedFs: string;
}

export interface NeruProbeResult {
  executable: string;
  kernel: string;
  initramfs: string;
  browserRuntime: string;
  browserWorker: string;
  sharedFs: string;
}
