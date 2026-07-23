      return reply_attr(in, node);
    }
    case FUSE_GETLK:
    case FUSE_SETLK:
    case FUSE_SETLKW: {
      if (!node || node->kind != K_FILE || payload_size < sizeof(struct fuse_lk_in)) {
        return reply_raw(in, node && node->kind == K_DIR ? EISDIR : ENOENT, NULL, 0);
      }
      struct fuse_lk_in *request = (struct fuse_lk_in *)payload;
      uint32_t exclusive = request->lk.type == F_WRLCK;
      if (request->lk.type != F_RDLCK && request->lk.type != F_WRLCK && request->lk.type != F_UNLCK) {
        return reply_raw(in, EINVAL, NULL, 0);
      }
      if (in->opcode == FUSE_GETLK) {
        struct fuse_lk_out out = {0};
        out.lk = request->lk;
        if (request->lk.type == F_UNLCK || find_lock(node->ino, request->owner)) {
          out.lk.type = F_UNLCK;
        } else {
          int status = probe_file_lock(node, request->owner, exclusive);
          if (status == 0) out.lk.type = F_UNLCK;
          else if (status == -EAGAIN) {
            out.lk.type = exclusive ? F_WRLCK : F_RDLCK;
            out.lk.pid = 0;
          } else {
            return reply_raw(in, -status, NULL, 0);
          }
        }
        return reply_raw(in, 0, &out, sizeof(out));
      }
      if (request->lk.type == F_UNLCK) {
        int status = release_file_lock(node->ino, request->owner);
        return reply_raw(in, status < 0 ? -status : 0, NULL, 0);
      }
      int status = acquire_file_lock(node, request->owner, exclusive, in->opcode == FUSE_SETLKW);
      return reply_raw(in, status < 0 ? -status : 0, NULL, 0);
    }
    case FUSE_FSYNC:
    case FUSE_FSYNCDIR: {
      if (!node) return reply_raw(in, ENOENT, NULL, 0);
      int status = mutate_simple(BR_FSYNC, node, node->path);
      return reply_raw(in, status < 0 ? -status : 0, NULL, 0);
    }
    case FUSE_ACCESS:
      return node ? reply_raw(in, 0, NULL, 0) : reply_raw(in, ENOENT, NULL, 0);
    case FUSE_STATFS: {
      struct fuse_statfs_out out = {0};
      out.st.blocks = 1ull << 40;
      out.st.bfree = out.st.bavail = 1ull << 39;
      out.st.files = snapshot.count + 1024u;
      out.st.ffree = 1ull << 32;
      out.st.bsize = out.st.frsize = 4096;
      out.st.namelen = 255;
      return reply_raw(in, 0, &out, sizeof(out));
    }
    case FUSE_DESTROY:
      running = 0;
      return reply_raw(in, 0, NULL, 0);
    default:
      return reply_raw(in, ENOSYS, NULL, 0);
  }
}

static int mount_nerufs(const char *mountpoint) {
  fuse_fd = open("/dev/fuse", O_RDWR | O_CLOEXEC);
  if (fuse_fd < 0) return -errno;
  char options[256];
  snprintf(options, sizeof(options), "fd=%d,rootmode=40000,user_id=0,group_id=0,default_permissions", fuse_fd);
  if (mount("nerufs", mountpoint, "fuse", MS_NOSUID | MS_NODEV, options) < 0) {
    int error = errno;
    close(fuse_fd);
    fuse_fd = -1;
    return -error;
  }
  return 0;
}

int main(int argc, char **argv) {
  const char *mountpoint = argc > 1 ? argv[1] : "/mikuos";
  if (mkdir(mountpoint, 0755) < 0 && errno != EEXIST) die("create mountpoint");
  int status = refresh_snapshot();
  if (status < 0) {
    fprintf(stderr, "nerufs: authoritative userspace unavailable (%s)\n", strerror(-status));
    return 1;
  }
  status = mount_nerufs(mountpoint);
  if (status < 0) {
    fprintf(stderr, "nerufs: mount %s: %s\n", mountpoint, strerror(-status));
    return 1;
  }
  uint8_t *buffer = malloc(MAX_REQUEST);
  if (!buffer) die("allocate FUSE buffer");
  while (running) {
    ssize_t count = read(fuse_fd, buffer, MAX_REQUEST);
    if (count < 0) {
      if (errno == EINTR) continue;
      if (errno == ENODEV) break;
      die("read /dev/fuse");
    }
    if (count == 0) break;
    if (handle_request(buffer, (size_t)count) < 0) {
      fprintf(stderr, "nerufs: invalid FUSE request\n");
      break;
    }
  }
  free(buffer);
  free_locks();
  free_snapshot();
  if (fuse_fd >= 0) close(fuse_fd);
  return 0;
}
