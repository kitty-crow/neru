// SPDX-License-Identifier: GPL-2.0-only

import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const ERRNO = Object.freeze({
  EACCES: -13,
  EIO: -5,
  ELOOP: -40,
  ENAMETOOLONG: -36,
  ENOENT: -2,
  ENOTDIR: -20,
  EPERM: -1,
});

const errorCode = (error) => {
  const code = error && typeof error === "object" ? error.code : undefined;
  return ERRNO[code] ?? ERRNO.EIO;
};

const cstring = (memory, pointer) => {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end === bytes.length) throw Object.assign(new Error("unterminated guest path"), { code: "ENAMETOOLONG" });
  return new TextDecoder().decode(bytes.subarray(pointer, end));
};

const writeBytes = (memory, pointer, capacity, source) => {
  if (source.length >= capacity) return ERRNO.ENAMETOOLONG;
  const target = new Uint8Array(memory.buffer, pointer, capacity);
  target.set(source);
  target[source.length] = 0;
  return source.length;
};

const inside = (root, candidate) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export function createNodeMikuosFs(rootValue) {
  const root = realpathSync.native(resolve(rootValue));
  const encoder = new TextEncoder();

  const lexical = (guestPath) => {
    if (!guestPath.startsWith("/") || guestPath.includes("\0")) {
      throw Object.assign(new Error("invalid guest path"), { code: "EACCES" });
    }
    const candidate = resolve(root, `.${guestPath}`);
    if (!inside(root, candidate)) {
      throw Object.assign(new Error("guest path escapes root"), { code: "EACCES" });
    }
    return candidate;
  };

  const finalPath = (guestPath) => {
    const candidate = lexical(guestPath);
    const resolved = realpathSync.native(candidate);
    if (!inside(root, resolved)) {
      throw Object.assign(new Error("guest symlink escapes root"), { code: "EACCES" });
    }
    return resolved;
  };

  const lstatPath = (guestPath) => {
    const candidate = lexical(guestPath);
    const parent = realpathSync.native(dirname(candidate));
    if (!inside(root, parent)) {
      throw Object.assign(new Error("guest parent escapes root"), { code: "EACCES" });
    }
    return candidate;
  };

  const guestLink = (hostPath, target) => {
    if (!isAbsolute(target)) return target;
    const resolved = resolve(target);
    if (!inside(root, resolved)) return target;
    const guest = relative(root, resolved).split(sep).join("/");
    return guest ? `/${guest}` : "/";
  };

  return Object.freeze({
    mode(memory, pathPointer) {
      try {
        return Number(lstatSync(lstatPath(cstring(memory, pathPointer))).mode);
      } catch (error) {
        return errorCode(error);
      }
    },

    size(memory, pathPointer) {
      try {
        return BigInt(lstatSync(lstatPath(cstring(memory, pathPointer))).size);
      } catch (error) {
        return BigInt(errorCode(error));
      }
    },

    read(memory, pathPointer, offsetValue, bufferPointer, countValue) {
      let descriptor;
      try {
        const path = finalPath(cstring(memory, pathPointer));
        const offset = Number(offsetValue);
        const count = Number(countValue);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0) {
          return ERRNO.EIO;
        }
        descriptor = openSync(path, "r");
        const target = new Uint8Array(memory.buffer, Number(bufferPointer), count);
        return readSync(descriptor, target, 0, count, offset);
      } catch (error) {
        return errorCode(error);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },

    readdir(memory, pathPointer, indexValue, bufferPointer, countValue) {
      try {
        const path = finalPath(cstring(memory, pathPointer));
        const index = Number(indexValue);
        const entries = readdirSync(path, { encoding: "utf8" })
          .filter((name) => name !== ".thistle-meta.json" && name !== ".thistle-meta.json.tmp")
          .sort();
        if (!Number.isSafeInteger(index) || index < 0) return ERRNO.EIO;
        if (index >= entries.length) return 0;
        return writeBytes(
          memory,
          Number(bufferPointer),
          Number(countValue),
          encoder.encode(entries[index]),
        );
      } catch (error) {
        return errorCode(error);
      }
    },

    readlink(memory, pathPointer, bufferPointer, countValue) {
      try {
        const path = lstatPath(cstring(memory, pathPointer));
        const target = guestLink(path, readlinkSync(path, "utf8"));
        return writeBytes(
          memory,
          Number(bufferPointer),
          Number(countValue),
          encoder.encode(target),
        );
      } catch (error) {
        return errorCode(error);
      }
    },
  });
}
