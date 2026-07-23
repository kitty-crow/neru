#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include <linux/fuse.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__GNUC__)
#pragma GCC diagnostic ignored "-Wmisleading-indentation"
#endif

#if defined(__wasm__)
__attribute__((import_module("env"), import_name("__neru_fs_call")))
extern int __neru_fs_call(const void *input, size_t input_size, void *output, size_t output_size);
#else
extern int __neru_fs_call(const void *input, size_t input_size, void *output, size_t output_size);
#endif

#define NFQ1 UINT32_C(0x3151464e)
#define NFS1 UINT32_C(0x3153464e)
#define NFC1 UINT32_C(0x3143464e)
#define NFL1 UINT32_C(0x314c464e)
#define NFE1 UINT32_C(0x3145464e)
#define NONE_VERSION UINT64_MAX
#define NULL_VERSION (UINT64_MAX - 1u)
#define MAX_REQUEST (16u * 1024u * 1024u)
#define MAX_RESPONSE (256u * 1024u * 1024u)

enum bridge_opcode {
  BR_SNAPSHOT = 1, BR_CREATE = 2, BR_WRITE = 3, BR_TRUNCATE = 4,
  BR_RENAME = 5, BR_UNLINK = 6, BR_MKDIR = 7, BR_RMDIR = 8,
  BR_CHMOD = 9, BR_CHOWN = 10, BR_LINK = 11, BR_SYMLINK = 12,
  BR_FSYNC = 13, BR_LOCK = 14, BR_UNLOCK = 15,
};
enum entry_kind { K_FILE = 1, K_DIR = 2, K_SYMLINK = 3 };

typedef struct {
  uint8_t *data;
  size_t size;
  size_t cap;
} Buffer;

typedef struct {
  const uint8_t *data;
  size_t size;
  size_t at;
} Reader;

typedef struct {
  uint64_t ino;
  uint64_t version;
  uint64_t atime_ms, mtime_ms, ctime_ms;
  uint32_t mode, uid, gid, nlink, kind;
  char *path;
  char *target;
  uint8_t *data;
  uint32_t data_len;
} Entry;

typedef struct {
  uint64_t generation;
  uint64_t image_generation;
  Entry *entries;
  size_t count;
} Snapshot;

typedef struct LockRecord {
  uint64_t ino;
  uint64_t owner;
  uint32_t exclusive;
  char *lock_id;
  struct LockRecord *next;
} LockRecord;

static Snapshot snapshot;
static LockRecord *locks;
static int fuse_fd = -1;
static int running = 1;

static void die(const char *message) {
  fprintf(stderr, "nerufs: %s: %s\n", message, strerror(errno));
  exit(1);
}

static uint32_t rd32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static uint64_t rd64(const uint8_t *p) {
  uint64_t value = 0;
  for (unsigned i = 0; i < 8; ++i) value |= (uint64_t)p[i] << (i * 8u);
  return value;
}
static void wr32(uint8_t *p, uint32_t value) {
  for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(value >> (i * 8u));
}
static void wr64(uint8_t *p, uint64_t value) {
  for (unsigned i = 0; i < 8; ++i) p[i] = (uint8_t)(value >> (i * 8u));
}
static void buffer_need(Buffer *buffer, size_t extra) {
