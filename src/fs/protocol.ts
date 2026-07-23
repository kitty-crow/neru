export const SHARED_FS_SCHEMA = 1 as const;
export const PERSISTENT_ROOTS = ["/etc", "/home", "/opt", "/root", "/usr", "/var"] as const;
export const KERNEL_LOCAL_ROOTS = ["/dev", "/proc", "/sys", "/run"] as const;

export type SharedKind = "file" | "directory" | "symlink";

export interface SharedEntry {
  path: string;
  inode: string;
  kind: SharedKind;
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  version: number;
  nlink: number;
  size?: number;
  checksum?: string;
  data?: string;
  target?: string;
}

export interface SharedSnapshot {
  schema: typeof SHARED_FS_SCHEMA;
  filesystemId: string;
  generation: number;
  imageGeneration: number;
  committedAt: string;
  checksum: string;
  entries: SharedEntry[];
}

interface ExpectedVersion {
  expectedVersion?: number;
}

export type SharedOperation =
  | ({ op: "create"; path: string; kind: SharedKind; mode: number; uid: number; gid: number; data?: string; target?: string } & ExpectedVersion)
  | ({ op: "write"; path: string; offset: number; data: string; truncate?: boolean } & ExpectedVersion)
  | ({ op: "truncate"; path: string; size: number } & ExpectedVersion)
  | ({ op: "rename"; from: string; to: string; expectedTargetVersion?: number | null } & ExpectedVersion)
  | ({ op: "unlink"; path: string } & ExpectedVersion)
  | ({ op: "mkdir"; path: string; mode: number; uid: number; gid: number } & ExpectedVersion)
  | ({ op: "rmdir"; path: string } & ExpectedVersion)
  | ({ op: "chmod"; path: string; mode: number } & ExpectedVersion)
  | ({ op: "chown"; path: string; uid: number; gid: number } & ExpectedVersion)
  | ({ op: "link"; from: string; to: string } & ExpectedVersion)
  | ({ op: "symlink"; path: string; target: string; mode?: number; uid?: number; gid?: number } & ExpectedVersion)
  | ({ op: "fsync"; path?: string } & ExpectedVersion);

export interface SharedTransaction {
  schema: typeof SHARED_FS_SCHEMA;
  transactionId: string;
  clientId: string;
  leaseId: string;
  baseGeneration: number;
  imageGeneration?: number;
  operations: SharedOperation[];
}

export interface SharedCommitResult {
  generation: number;
  transactionId: string;
  snapshot: SharedSnapshot;
}

export interface LeaseRequest {
  clientId: string;
  ttlMs?: number;
}

export interface Lease {
  leaseId: string;
  clientId: string;
  expiresAt: number;
}

export interface LockRequest {
  path: string;
  leaseId: string;
  owner: string;
  exclusive: boolean;
  ttlMs?: number;
}

export interface AdvisoryLock extends LockRequest {
  lockId: string;
  expiresAt: number;
}

export interface ConflictDetail {
  path: string;
  expected?: number | null;
  actual?: number | null;
  reason: string;
}

export class SharedFsError extends Error {
  constructor(
    readonly code: "EINVAL" | "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "ESTALE" | "ELOCKED" | "EROFS",
    message: string,
    readonly detail?: ConflictDetail,
  ) {
    super(message);
    this.name = "SharedFsError";
  }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const encodeBytes = (bytes: Uint8Array): string => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return output;
};

export const decodeBytes = (value: string | undefined): Uint8Array => {
  if (!value) return new Uint8Array();
  const clean = value.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) throw new SharedFsError("EINVAL", "invalid base64 payload");
  const output: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const chars = clean.slice(index, index + 4);
    const numbers = [...chars].map(char => char === "=" ? 0 : alphabet.indexOf(char));
    if (numbers.some(number => number < 0)) throw new SharedFsError("EINVAL", "invalid base64 payload");
    const packed = (numbers[0]! << 18) | (numbers[1]! << 12) | (numbers[2]! << 6) | numbers[3]!;
    output.push((packed >>> 16) & 255);
    if (chars[2] !== "=") output.push((packed >>> 8) & 255);
    if (chars[3] !== "=") output.push(packed & 255);
  }
  return Uint8Array.from(output);
};

export const normaliseSharedPath = (value: string): string => {
  if (!value.startsWith("/")) throw new SharedFsError("EINVAL", `path is not absolute: ${value}`);
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new SharedFsError("EINVAL", `path escapes the shared root: ${value}`);
    if (part.includes("\0")) throw new SharedFsError("EINVAL", "path contains NUL");
    parts.push(part);
  }
  return parts.length ? `/${parts.join("/")}` : "/";
};

export const isKernelLocalPath = (value: string): boolean => {
  const path = normaliseSharedPath(value);
  return KERNEL_LOCAL_ROOTS.some(root => path === root || path.startsWith(`${root}/`));
};

export const isPersistentPath = (value: string): boolean => {
  const path = normaliseSharedPath(value);
  return !isKernelLocalPath(path) && path !== "/tmp" && !path.startsWith("/tmp/");
};
