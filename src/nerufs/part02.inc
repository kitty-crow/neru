static int append_kernel_local_entries(Snapshot *next) {
  static const char *const paths[] = {"/dev", "/proc", "/run", "/sys", "/tmp"};
  size_t missing = 0;
  for (size_t k = 0; k < sizeof(paths) / sizeof(paths[0]); ++k) {
    int found = 0;
    for (size_t i = 0; i < next->count; ++i) if (!strcmp(next->entries[i].path, paths[k])) { found = 1; break; }
    if (!found) ++missing;
  }
  if (!missing) return 0;
  Entry *entries = realloc(next->entries, (next->count + missing) * sizeof(*entries));
  if (!entries) return -ENOMEM;
  next->entries = entries;
  size_t added = 0;
  for (size_t k = 0; k < sizeof(paths) / sizeof(paths[0]); ++k) {
    int found = 0;
    for (size_t i = 0; i < next->count; ++i) if (!strcmp(next->entries[i].path, paths[k])) { found = 1; break; }
    if (found) continue;
    Entry *entry = &next->entries[next->count + added]; memset(entry, 0, sizeof(*entry));
    entry->ino = UINT64_C(0x7fffffffffffff00) + k;
    entry->version = 1; entry->mode = !strcmp(paths[k], "/tmp") ? 01777u : 0755u;
    entry->uid = 0; entry->gid = 0; entry->nlink = 2; entry->kind = K_DIR;
    entry->path = strdup(paths[k]); entry->target = strdup(""); entry->data = malloc(1);
    if (!entry->path || !entry->target || !entry->data) {
      free(entry->path); free(entry->target); free(entry->data);
      for (size_t j = 0; j < added; ++j) {
        Entry *prior = &next->entries[next->count + j]; free(prior->path); free(prior->target); free(prior->data);
      }
      return -ENOMEM;
    }
    ++added;
  }
  next->count += added;
  return 0;
}

static int refresh_snapshot(void) {
  Buffer request = request_begin(BR_SNAPSHOT);
  uint8_t *response = NULL; size_t response_size = 0;
  int status = bridge_call(&request, &response, &response_size); free(request.data);
  if (status < 0) return status;
  Reader reader = {response, response_size, 0};
  uint32_t magic = reader_u32(&reader);
  if (magic == NFE1) { status = parse_error(&reader); free(response); return status; }
  if (magic != NFS1) { free(response); return -EPROTO; }
  Snapshot next = {0};
  next.generation = reader_u64(&reader); next.image_generation = reader_u64(&reader);
  next.count = reader_u32(&reader);
  if (next.count > 1000000u) { free(response); return -E2BIG; }
  next.entries = calloc(next.count ? next.count : 1u, sizeof(*next.entries));
  if (!next.entries) { free(response); return -ENOMEM; }
  for (size_t i = 0; i < next.count; ++i) {
    Entry *entry = &next.entries[i];
    entry->ino = reader_u64(&reader); entry->version = reader_u64(&reader);
    entry->atime_ms = reader_u64(&reader); entry->mtime_ms = reader_u64(&reader); entry->ctime_ms = reader_u64(&reader);
    entry->mode = reader_u32(&reader); entry->uid = reader_u32(&reader); entry->gid = reader_u32(&reader);
    entry->nlink = reader_u32(&reader); entry->kind = reader_u32(&reader);
    entry->path = reader_text(&reader); entry->target = reader_text(&reader); entry->data = reader_blob(&reader, &entry->data_len);
    if (!entry->ino || entry->kind < K_FILE || entry->kind > K_SYMLINK || entry->path[0] != '/') {
      free(response); Snapshot old = snapshot; snapshot = next; free_snapshot(); snapshot = old; return -EPROTO;
    }
  }
  if (reader.at != reader.size) { free(response); Snapshot old = snapshot; snapshot = next; free_snapshot(); snapshot = old; return -EPROTO; }
  status = append_kernel_local_entries(&next);
  if (status < 0) { free(response); Snapshot old = snapshot; snapshot = next; free_snapshot(); snapshot = old; return status; }
  free(response); free_snapshot(); snapshot = next; return 0;
}

static int commit_request(Buffer *request) {
  uint8_t *response = NULL; size_t response_size = 0;
  int status = bridge_call(request, &response, &response_size);
  if (status < 0) return status;
  Reader reader = {response, response_size, 0}; uint32_t magic = reader_u32(&reader);
  if (magic == NFE1) status = parse_error(&reader);
  else if (magic != NFC1) status = -EPROTO;
  else { (void)reader_u64(&reader); status = 0; }
  free(response);
  if (status == 0) status = refresh_snapshot();
  return status;
}

static Entry *by_ino(uint64_t ino) {
  for (size_t i = 0; i < snapshot.count; ++i) if (snapshot.entries[i].ino == ino) return &snapshot.entries[i];
  return NULL;
}
static Entry *by_path(const char *path) {
  for (size_t i = 0; i < snapshot.count; ++i) if (!strcmp(snapshot.entries[i].path, path)) return &snapshot.entries[i];
  return NULL;
}
static char *join_path(const Entry *parent, const char *name) {
  if (!parent || parent->kind != K_DIR || strchr(name, '/')) return NULL;
  size_t a = strlen(parent->path), b = strlen(name); size_t size = a + b + 2u;
  char *path = malloc(size); if (!path) return NULL;
  if (!strcmp(parent->path, "/")) snprintf(path, size, "/%s", name);
  else snprintf(path, size, "%s/%s", parent->path, name);
  return path;
}
static uint32_t file_type(const Entry *entry) {
  return entry->kind == K_DIR ? S_IFDIR : entry->kind == K_SYMLINK ? S_IFLNK : S_IFREG;
}
static void fill_attr(const Entry *entry, struct fuse_attr *attr) {
  memset(attr, 0, sizeof(*attr)); attr->ino = entry->ino; attr->size = entry->kind == K_FILE ? entry->data_len : 0;
  attr->blocks = (attr->size + 511u) / 512u; attr->atime = entry->atime_ms / 1000u; attr->mtime = entry->mtime_ms / 1000u; attr->ctime = entry->ctime_ms / 1000u;
  attr->atimensec = (uint32_t)(entry->atime_ms % 1000u) * 1000000u; attr->mtimensec = (uint32_t)(entry->mtime_ms % 1000u) * 1000000u; attr->ctimensec = (uint32_t)(entry->ctime_ms % 1000u) * 1000000u;
  attr->mode = file_type(entry) | (entry->mode & 07777u); attr->nlink = entry->nlink; attr->uid = entry->uid; attr->gid = entry->gid; attr->blksize = 4096;
}
static void fill_entry(const Entry *entry, struct fuse_entry_out *out) {
  memset(out, 0, sizeof(*out)); out->nodeid = entry->ino; out->generation = entry->version; fill_attr(entry, &out->attr);
}

static int reply_raw(const struct fuse_in_header *in, int error, const void *payload, size_t size) {
  struct fuse_out_header out = { .len = (uint32_t)(sizeof(out) + size), .error = error ? -abs(error) : 0, .unique = in->unique };
  struct iovec parts[2] = {{&out, sizeof(out)}, {(void *)payload, size}};
  ssize_t written = writev(fuse_fd, parts, size ? 2 : 1);
  return written < 0 ? -errno : 0;
}
static int reply_entry(const struct fuse_in_header *in, Entry *entry) {
  if (!entry) return reply_raw(in, ENOENT, NULL, 0); struct fuse_entry_out out; fill_entry(entry, &out); return reply_raw(in, 0, &out, sizeof(out));
}
static int reply_attr(const struct fuse_in_header *in, Entry *entry) {
  if (!entry) return reply_raw(in, ENOENT, NULL, 0); struct fuse_attr_out out = {0}; fill_attr(entry, &out.attr); return reply_raw(in, 0, &out, sizeof(out));
}

static int mutate_create(const char *path, uint32_t kind, uint32_t mode, uint32_t uid, uint32_t gid, const void *data, size_t size, const char *target) {
  Buffer request = request_begin(BR_CREATE); buffer_u32(&request, kind); buffer_u32(&request, mode); buffer_u32(&request, uid); buffer_u32(&request, gid); buffer_text(&request, path); buffer_blob(&request, data, size); buffer_text(&request, target ? target : "");
  int status = commit_request(&request); free(request.data); return status;
}
static int mutate_simple(uint32_t opcode, const Entry *entry, const char *path) {
  Buffer request = request_begin(opcode); buffer_u64(&request, entry ? entry->version : NONE_VERSION); buffer_text(&request, path); int status = commit_request(&request); free(request.data); return status;
}
static int mutate_write(const Entry *entry, uint64_t offset, const void *data, size_t size, int truncate) {
  Buffer request = request_begin(BR_WRITE); buffer_u64(&request, entry->version); buffer_u64(&request, offset); buffer_u32(&request, truncate != 0); buffer_text(&request, entry->path); buffer_blob(&request, data, size); int status = commit_request(&request); free(request.data); return status;
}
static int mutate_truncate(const Entry *entry, uint64_t size) {
  Buffer request = request_begin(BR_TRUNCATE); buffer_u64(&request, entry->version); buffer_u64(&request, size); buffer_text(&request, entry->path); int status = commit_request(&request); free(request.data); return status;
}
static int mutate_chmod(const Entry *entry, uint32_t mode) {
  Buffer request = request_begin(BR_CHMOD); buffer_u64(&request, entry->version); buffer_u32(&request, mode); buffer_text(&request, entry->path); int status = commit_request(&request); free(request.data); return status;
}
