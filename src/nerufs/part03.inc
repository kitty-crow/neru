}
static int mutate_chown(const Entry *entry, uint32_t uid, uint32_t gid) {
  Buffer request = request_begin(BR_CHOWN);
  buffer_u64(&request, entry->version);
  buffer_u32(&request, uid);
  buffer_u32(&request, gid);
  buffer_text(&request, entry->path);
  int status = commit_request(&request);
  free(request.data);
  return status;
}
static int mutate_rename(const Entry *entry, const char *to) {
  Entry *target = by_path(to);
  Buffer request = request_begin(BR_RENAME);
  buffer_u64(&request, entry->version);
  buffer_u64(&request, target ? target->version : NULL_VERSION);
  buffer_text(&request, entry->path);
  buffer_text(&request, to);
  int status = commit_request(&request);
  free(request.data);
  return status;
}
static int mutate_link(const Entry *entry, const char *to) {
  Buffer request = request_begin(BR_LINK);
  buffer_u64(&request, entry->version);
  buffer_text(&request, entry->path);
  buffer_text(&request, to);
  int status = commit_request(&request);
  free(request.data);
  return status;
}

static LockRecord *find_lock(uint64_t ino, uint64_t owner) {
  for (LockRecord *record = locks; record; record = record->next) {
    if (record->ino == ino && record->owner == owner) return record;
  }
  return NULL;
}

static LockRecord *conflicting_local_lock(uint64_t ino, uint64_t owner, uint32_t exclusive) {
  for (LockRecord *record = locks; record; record = record->next) {
    if (record->ino != ino || record->owner == owner) continue;
    if (record->exclusive || exclusive) return record;
  }
  return NULL;
}

static int remote_unlock(const char *lock_id) {
  Buffer request = request_begin(BR_UNLOCK);
  buffer_text(&request, lock_id);
  uint8_t *response = NULL;
  size_t response_size = 0;
  int status = bridge_call(&request, &response, &response_size);
  free(request.data);
  if (status < 0) return status;
  Reader reader = {response, response_size, 0};
  uint32_t magic = reader_u32(&reader);
  if (magic == NFE1) status = parse_error(&reader);
  else if (magic != NFC1) status = -EPROTO;
  else { (void)reader_u64(&reader); status = 0; }
  free(response);
  return status;
}

static int remote_lock(const Entry *entry, uint64_t owner, uint32_t exclusive, char **lock_id) {
  char owner_text[64];
  snprintf(owner_text, sizeof(owner_text), "linux:%" PRIu64, owner);
  Buffer request = request_begin(BR_LOCK);
  buffer_u32(&request, exclusive);
  buffer_u32(&request, 300000u);
  buffer_text(&request, entry->path);
  buffer_text(&request, owner_text);
  uint8_t *response = NULL;
  size_t response_size = 0;
  int status = bridge_call(&request, &response, &response_size);
  free(request.data);
  if (status < 0) return status;
  Reader reader = {response, response_size, 0};
  uint32_t magic = reader_u32(&reader);
  if (magic == NFE1) status = parse_error(&reader);
  else if (magic != NFL1) status = -EPROTO;
  else {
    *lock_id = reader_text(&reader);
    (void)reader_u64(&reader);
    status = 0;
  }
  free(response);
  return status;
}

static int release_file_lock(uint64_t ino, uint64_t owner) {
  LockRecord **link = &locks;
  while (*link) {
    LockRecord *record = *link;
    if (record->ino == ino && record->owner == owner) {
      int status = remote_unlock(record->lock_id);
      if (status < 0 && status != -ESTALE && status != -ENOENT) return status;
      *link = record->next;
      free(record->lock_id);
      free(record);
      return 0;
    }
    link = &record->next;
  }
  return 0;
}

static int acquire_file_lock(const Entry *entry, uint64_t owner, uint32_t exclusive, int wait) {
  LockRecord *current = find_lock(entry->ino, owner);
  if (current && current->exclusive == exclusive) return 0;
  if (current) {
    int released = release_file_lock(entry->ino, owner);
    if (released < 0) return released;
  }
  for (;;) {
    if (conflicting_local_lock(entry->ino, owner, exclusive)) {
      if (!wait) return -EAGAIN;
      usleep(50000);
      continue;
    }
    char *lock_id = NULL;
    int status = remote_lock(entry, owner, exclusive, &lock_id);
    if (status == -EAGAIN && wait) {
      usleep(50000);
      continue;
    }
    if (status < 0) return status;
    LockRecord *record = calloc(1, sizeof(*record));
    if (!record) {
      (void)remote_unlock(lock_id);
      free(lock_id);
      return -ENOMEM;
    }
    record->ino = entry->ino;
    record->owner = owner;
    record->exclusive = exclusive;
    record->lock_id = lock_id;
    record->next = locks;
    locks = record;
    return 0;
  }
}

static int probe_file_lock(const Entry *entry, uint64_t owner, uint32_t exclusive) {
  if (conflicting_local_lock(entry->ino, owner, exclusive)) return -EAGAIN;
  char *lock_id = NULL;
  int status = remote_lock(entry, owner, exclusive, &lock_id);
  if (status < 0) return status;
  int unlocked = remote_unlock(lock_id);
  free(lock_id);
  return unlocked;
}

static void free_locks(void) {
  while (locks) {
    LockRecord *record = locks;
    locks = record->next;
    (void)remote_unlock(record->lock_id);
    free(record->lock_id);
    free(record);
  }
}

static int add_dirent(uint8_t *output, size_t capacity, size_t *used, uint64_t ino, uint64_t off, uint32_t type, const char *name) {
  size_t namelen = strlen(name);
  size_t record = FUSE_DIRENT_ALIGN(FUSE_NAME_OFFSET + namelen);
  if (record > capacity - *used) return 0;
  struct fuse_dirent *entry = (struct fuse_dirent *)(output + *used);
  memset(entry, 0, record);
  entry->ino = ino;
  entry->off = off;
  entry->namelen = (uint32_t)namelen;
  entry->type = type;
  memcpy(entry->name, name, namelen);
  *used += record;
  return 1;
}
static int child_of(const char *parent, const char *path, const char **name) {
  if (!strcmp(parent, "/")) {
    if (path[0] != '/' || !path[1] || strchr(path + 1, '/')) return 0;
    *name = path + 1;
    return 1;
  }
  size_t n = strlen(parent);
  if (strncmp(parent, path, n) || path[n] != '/' || !path[n + 1] || strchr(path + n + 1, '/')) return 0;
  *name = path + n + 1;
  return 1;
}
static uint32_t dt_type(const Entry *entry) {
  return entry->kind == K_DIR ? DT_DIR : entry->kind == K_SYMLINK ? DT_LNK : DT_REG;
}
static Entry *parent_entry(const Entry *entry) {
  if (!entry || !strcmp(entry->path, "/")) return by_path("/");
  char path[PATH_MAX];
  if (snprintf(path, sizeof(path), "%s", entry->path) >= (int)sizeof(path)) return NULL;
  char *slash = strrchr(path, '/');
  if (!slash) return NULL;
  if (slash == path) slash[1] = 0;
  else *slash = 0;
  return by_path(path);
}

static int handle_request(uint8_t *buffer, size_t size) {
  if (size < sizeof(struct fuse_in_header)) return -EPROTO;
  struct fuse_in_header *in = (struct fuse_in_header *)buffer;
  if (in->len > size || in->len < sizeof(*in)) return -EPROTO;
  uint8_t *payload = buffer + sizeof(*in);
  size_t payload_size = in->len - sizeof(*in);
  if (in->opcode != FUSE_INIT && in->opcode != FUSE_FORGET && in->opcode != FUSE_BATCH_FORGET) {
    int refreshed = refresh_snapshot();
    if (refreshed < 0) return reply_raw(in, -refreshed, NULL, 0);
  }
  Entry *node = by_ino(in->nodeid);
  switch (in->opcode) {
    case FUSE_INIT: {
      if (payload_size < sizeof(struct fuse_init_in)) return reply_raw(in, EPROTO, NULL, 0);
      struct fuse_init_in *request = (struct fuse_init_in *)payload;
      struct fuse_init_out out = {0};
      out.major = FUSE_KERNEL_VERSION;
      out.minor = request->minor < FUSE_KERNEL_MINOR_VERSION ? request->minor : FUSE_KERNEL_MINOR_VERSION;
      out.max_readahead = request->max_readahead;
      out.flags = FUSE_BIG_WRITES | FUSE_AUTO_INVAL_DATA | FUSE_DONT_MASK | FUSE_POSIX_LOCKS;
      out.max_background = 16;
      out.congestion_threshold = 12;
      out.max_write = 1024u * 1024u;
      out.time_gran = 1000000u;
      return reply_raw(in, 0, &out, sizeof(out));
    }
    case FUSE_FORGET:
    case FUSE_BATCH_FORGET:
      return 0;
    case FUSE_LOOKUP: {
      if (!node || node->kind != K_DIR || !payload_size || ((char *)payload)[payload_size - 1] != 0) return reply_raw(in, ENOENT, NULL, 0);
      char *path = join_path(node, (char *)payload);
      if (!path) return reply_raw(in, EINVAL, NULL, 0);
      Entry *found = by_path(path);
      free(path);
      return reply_entry(in, found);
    }
    case FUSE_GETATTR:
      return reply_attr(in, node);
    case FUSE_READLINK:
      return node && node->kind == K_SYMLINK
        ? reply_raw(in, 0, node->target, strlen(node->target))
        : reply_raw(in, EINVAL, NULL, 0);
    case FUSE_OPEN:
    case FUSE_OPENDIR: {
      if (!node) return reply_raw(in, ENOENT, NULL, 0);
      if ((in->opcode == FUSE_OPENDIR) != (node->kind == K_DIR)) return reply_raw(in, node->kind == K_DIR ? EISDIR : ENOTDIR, NULL, 0);
      if (in->opcode == FUSE_OPEN && payload_size >= sizeof(struct fuse_open_in)) {
        struct fuse_open_in *open_in = (struct fuse_open_in *)payload;
        if ((open_in->flags & O_TRUNC) && node->kind == K_FILE) {
          int status = mutate_truncate(node, 0);
          if (status < 0) return reply_raw(in, -status, NULL, 0);
          node = by_ino(in->nodeid);
        }
      }
      struct fuse_open_out out = {.fh = node->ino, .open_flags = FOPEN_DIRECT_IO};
      return reply_raw(in, 0, &out, sizeof(out));
    }
    case FUSE_RELEASE:
    case FUSE_RELEASEDIR:
    case FUSE_FLUSH:
      return reply_raw(in, 0, NULL, 0);
    case FUSE_READ: {
      if (!node || node->kind != K_FILE || payload_size < sizeof(struct fuse_read_in)) return reply_raw(in, node && node->kind == K_DIR ? EISDIR : ENOENT, NULL, 0);
      struct fuse_read_in *read_in = (struct fuse_read_in *)payload;
      if (read_in->offset >= node->data_len) return reply_raw(in, 0, NULL, 0);
      size_t length = node->data_len - (size_t)read_in->offset;
      if (length > read_in->size) length = read_in->size;
      return reply_raw(in, 0, node->data + read_in->offset, length);
    }
    case FUSE_WRITE: {
      if (!node || node->kind != K_FILE || payload_size < sizeof(struct fuse_write_in)) return reply_raw(in, node && node->kind == K_DIR ? EISDIR : ENOENT, NULL, 0);
      struct fuse_write_in *write_in = (struct fuse_write_in *)payload;
      if (write_in->size > payload_size - sizeof(*write_in)) return reply_raw(in, EPROTO, NULL, 0);
      int status = mutate_write(node, write_in->offset, payload + sizeof(*write_in), write_in->size, 0);
      if (status < 0) return reply_raw(in, -status, NULL, 0);
      struct fuse_write_out out = {.size = write_in->size};
      return reply_raw(in, 0, &out, sizeof(out));
    }
    case FUSE_READDIR: {
      if (!node || node->kind != K_DIR || payload_size < sizeof(struct fuse_read_in)) return reply_raw(in, ENOTDIR, NULL, 0);
      struct fuse_read_in *read_in = (struct fuse_read_in *)payload;
      uint8_t *out = calloc(read_in->size ? read_in->size : 1u, 1);
      if (!out) return reply_raw(in, ENOMEM, NULL, 0);
      size_t used = 0;
      uint64_t index = 0;
      if (read_in->offset <= index) add_dirent(out, read_in->size, &used, node->ino, ++index, DT_DIR, "."); else index++;
      Entry *parent = parent_entry(node);
      if (read_in->offset <= index) add_dirent(out, read_in->size, &used, parent ? parent->ino : FUSE_ROOT_ID, ++index, DT_DIR, ".."); else index++;
      for (size_t i = 0; i < snapshot.count; ++i) {
        const char *name;
        if (!child_of(node->path, snapshot.entries[i].path, &name)) continue;
        if (read_in->offset > index) { index++; continue; }
        if (!add_dirent(out, read_in->size, &used, snapshot.entries[i].ino, ++index, dt_type(&snapshot.entries[i]), name)) break;
      }
      int answer = reply_raw(in, 0, out, used);
      free(out);
      return answer;
    }
    case FUSE_MKDIR: {
      if (!node || node->kind != K_DIR || payload_size < sizeof(struct fuse_mkdir_in) + 1u) return reply_raw(in, ENOTDIR, NULL, 0);
      struct fuse_mkdir_in *mkdir_in = (struct fuse_mkdir_in *)payload;
      const char *name = (char *)(payload + sizeof(*mkdir_in));
      char *path = join_path(node, name);
      if (!path) return reply_raw(in, EINVAL, NULL, 0);
      int status = mutate_create(path, K_DIR, mkdir_in->mode, in->uid, in->gid, NULL, 0, NULL);
      Entry *created = status < 0 ? NULL : by_path(path);
      free(path);
      return status < 0 ? reply_raw(in, -status, NULL, 0) : reply_entry(in, created);
    }
    case FUSE_CREATE:
    case FUSE_MKNOD: {
      size_t header = in->opcode == FUSE_CREATE ? sizeof(struct fuse_create_in) : sizeof(struct fuse_mknod_in);
      if (!node || node->kind != K_DIR || payload_size < header + 1u) return reply_raw(in, ENOTDIR, NULL, 0);
      uint32_t mode = in->opcode == FUSE_CREATE ? ((struct fuse_create_in *)payload)->mode : ((struct fuse_mknod_in *)payload)->mode;
      const char *name = (char *)(payload + header);
      char *path = join_path(node, name);
      if (!path) return reply_raw(in, EINVAL, NULL, 0);
      int status = mutate_create(path, K_FILE, mode, in->uid, in->gid, NULL, 0, NULL);
      Entry *created = status < 0 ? NULL : by_path(path);
      if (status < 0) { free(path); return reply_raw(in, -status, NULL, 0); }
      if (in->opcode == FUSE_CREATE) {
        struct { struct fuse_entry_out entry; struct fuse_open_out open; } out = {0};
        fill_entry(created, &out.entry);
        out.open.fh = created->ino;
        out.open.open_flags = FOPEN_DIRECT_IO;
        free(path);
        return reply_raw(in, 0, &out, sizeof(out));
      }
      free(path);
      return reply_entry(in, created);
    }
    case FUSE_UNLINK:
    case FUSE_RMDIR: {
      if (!node || node->kind != K_DIR || !payload_size) return reply_raw(in, ENOTDIR, NULL, 0);
      char *path = join_path(node, (char *)payload);
      if (!path) return reply_raw(in, EINVAL, NULL, 0);
      Entry *target = by_path(path);
      int status = target ? mutate_simple(in->opcode == FUSE_UNLINK ? BR_UNLINK : BR_RMDIR, target, path) : -ENOENT;
      free(path);
      return reply_raw(in, status < 0 ? -status : 0, NULL, 0);
    }
    case FUSE_RENAME:
    case FUSE_RENAME2: {
      size_t header = in->opcode == FUSE_RENAME ? sizeof(struct fuse_rename_in) : sizeof(struct fuse_rename2_in);
      if (!node || payload_size < header + 3u) return reply_raw(in, EINVAL, NULL, 0);
      uint64_t newdir_ino = in->opcode == FUSE_RENAME ? ((struct fuse_rename_in *)payload)->newdir : ((struct fuse_rename2_in *)payload)->newdir;
      Entry *newdir = by_ino(newdir_ino);
      const char *oldname = (char *)(payload + header);
      size_t oldlen = strnlen(oldname, payload_size - header);
      if (oldlen == payload_size - header) return reply_raw(in, EPROTO, NULL, 0);
      const char *newname = oldname + oldlen + 1u;
      char *from = join_path(node, oldname);
      char *to = join_path(newdir, newname);
      if (!from || !to) { free(from); free(to); return reply_raw(in, EINVAL, NULL, 0); }
      Entry *source = by_path(from);
      int status = source ? mutate_rename(source, to) : -ENOENT;
      free(from);
      free(to);
      return reply_raw(in, status < 0 ? -status : 0, NULL, 0);
    }
    case FUSE_SYMLINK: {
      if (!node || node->kind != K_DIR || payload_size < 3u) return reply_raw(in, ENOTDIR, NULL, 0);
      const char *name = (char *)payload;
      size_t length = strnlen(name, payload_size);
      if (length == payload_size) return reply_raw(in, EPROTO, NULL, 0);
      const char *target = name + length + 1u;
      char *path = join_path(node, name);
      if (!path) return reply_raw(in, EINVAL, NULL, 0);
      int status = mutate_create(path, K_SYMLINK, 0777, in->uid, in->gid, NULL, 0, target);
      Entry *created = status < 0 ? NULL : by_path(path);
      free(path);
      return status < 0 ? reply_raw(in, -status, NULL, 0) : reply_entry(in, created);
    }
    case FUSE_LINK: {
      if (!node || node->kind != K_DIR || payload_size < sizeof(struct fuse_link_in) + 1u) return reply_raw(in, ENOTDIR, NULL, 0);
      struct fuse_link_in *link_in = (struct fuse_link_in *)payload;
      Entry *source = by_ino(link_in->oldnodeid);
      const char *name = (char *)(payload + sizeof(*link_in));
      char *path = join_path(node, name);
      if (!source || !path) { free(path); return reply_raw(in, ENOENT, NULL, 0); }
      int status = mutate_link(source, path);
      Entry *created = status < 0 ? NULL : by_path(path);
      free(path);
      return status < 0 ? reply_raw(in, -status, NULL, 0) : reply_entry(in, created);
    }
    case FUSE_SETATTR: {
      if (!node || payload_size < sizeof(struct fuse_setattr_in)) return reply_raw(in, ENOENT, NULL, 0);
      struct fuse_setattr_in *set = (struct fuse_setattr_in *)payload;
      int status = 0;
      if (set->valid & FATTR_SIZE) {
        status = mutate_truncate(node, set->size);
        if (status < 0) return reply_raw(in, -status, NULL, 0);
        node = by_ino(in->nodeid);
      }
      if (set->valid & FATTR_MODE) {
        status = mutate_chmod(node, set->mode);
        if (status < 0) return reply_raw(in, -status, NULL, 0);
        node = by_ino(in->nodeid);
      }
      if (set->valid & (FATTR_UID | FATTR_GID)) {
        status = mutate_chown(
          node,
          (set->valid & FATTR_UID) ? set->uid : node->uid,
          (set->valid & FATTR_GID) ? set->gid : node->gid
        );
        if (status < 0) return reply_raw(in, -status, NULL, 0);
        node = by_ino(in->nodeid);
      }
