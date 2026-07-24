export type NeruVariant = "wasm32_nommu" | "wasm64_nommu";

export interface NeruArtifactPaths {
  root: string;
  kernel: string;
  /** Present only for the legacy embedded-userspace proof-of-concept image. */
  initramfs: string;
  browserRuntime: string;
  browserWorker: string;
  manifest: string;
}

export interface NeruRuntimeBuildOptions {
  output?: string;
  variant?: NeruVariant;
  workspace?: string;
  rebuildLinux?: boolean;
}

export interface NeruPocImageBuildOptions extends NeruRuntimeBuildOptions {
  userland: string;
}

/** @deprecated Use NeruPocImageBuildOptions for the legacy embedded-userspace image. */
export type NeruBuildOptions = NeruPocImageBuildOptions;

export interface NeruBootOptions {
  artifactRoot?: string;
  linuxRuntime?: string;
  kernel?: string;
  /** Explicitly set only when reproducing the legacy proof-of-concept image. */
  initramfs?: string;
  argv?: string[];
  environment?: Record<string, string>;
  /** Exact local mikuOS root selected by the Thistle/Teto host. */
  filesystemRoot?: string;
  /** Optional remote or shared authority endpoint. */
  filesystemEndpoint?: string;
  filesystemToken?: string;
  filesystemClientId?: string;
}

export interface NeruBootPlan {
  executable: string;
  argv: string[];
  environment: Record<string, string>;
  kernel: string;
  initramfs?: string;
}

export interface NeruProbeResult {
  executable: string;
  kernel: string;
  initramfs?: string;
}
