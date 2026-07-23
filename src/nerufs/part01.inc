  if (extra > SIZE_MAX - buffer->size) { errno = EOVERFLOW; die("request size overflow"); }
  size_t need = buffer->size + extra;
  if (need <= buffer->cap) return;
  size_t cap = buffer->cap ? buffer->cap : 256;
  while (cap < need) {
    if (cap > MAX_REQUEST / 2u) { cap = MAX_REQUEST; break; }
    cap *= 2u;
  }
  if (cap < need || cap > MAX_REQUEST) { errno = E2BIG; die("request is too large"); }
  uint8_t *next = realloc(buffer->data, cap);
  if (!next) die("allocate request");
  buffer->data = next; buffer->cap = cap;
}
static void buffer_bytes(Buffer *buffer, const void *data, size_t size) {
  buffer_need(buffer, size);
  memcpy(buffer->data + buffer->size, data, size);
  buffer->size += size;
}
static void buffer_u32(Buffer *buffer, uint32_t value) {
  uint8_t bytes[4]; wr32(bytes, value); buffer_bytes(buffer, bytes, sizeof(bytes));
}
static void buffer_u64(Buffer *buffer, uint64_t value) {
  uint8_t bytes[8]; wr64(bytes, value); buffer_bytes(buffer, bytes, sizeof(bytes));
}
static void buffer_blob(Buffer *buffer, const void *data, size_t size) {
  if (size > UINT32_MAX) { errno = E2BIG; die("bridge blob too large"); }
  buffer_u32(buffer, (uint32_t)size); buffer_bytes(buffer, data, size);
}
static void buffer_text(Buffer *buffer, const char *text) {
  buffer_blob(buffer, text, strlen(text));
}
static Buffer request_begin(uint32_t opcode) {
  Buffer request = {0};
  buffer_u32(&request, NFQ1);
  buffer_u32(&request, opcode);
  buffer_u64(&request, snapshot.generation);
  return request;
}
static void reader_need(Reader *reader, size_t size) {
  if (reader->at > reader->size || size > reader->size - reader->at) { errno = EPROTO; die("truncated bridge response"); }
}
static uint32_t reader_u32(Reader *reader) {
  reader_need(reader, 4); uint32_t value = rd32(reader->data + reader->at); reader->at += 4; return value;
}
static uint64_t reader_u64(Reader *reader) {
  reader_need(reader, 8); uint64_t value = rd64(reader->data + reader->at); reader->at += 8; return value;
}
static uint8_t *reader_blob(Reader *reader, uint32_t *size) {
  *size = reader_u32(reader); reader_need(reader, *size);
  uint8_t *value = malloc((size_t)*size + 1u); if (!value) die("allocate bridge value");
  memcpy(value, reader->data + reader->at, *size); value[*size] = 0; reader->at += *size; return value;
}
static char *reader_text(Reader *reader) { uint32_t size; return (char *)reader_blob(reader, &size); }

static int errno_code(const char *code) {
  if (!strcmp(code, "ENOENT")) return ENOENT;
  if (!strcmp(code, "EEXIST")) return EEXIST;
  if (!strcmp(code, "ENOTDIR")) return ENOTDIR;
  if (!strcmp(code, "EISDIR")) return EISDIR;
  if (!strcmp(code, "ENOTEMPTY")) return ENOTEMPTY;
  if (!strcmp(code, "ESTALE")) return ESTALE;
  if (!strcmp(code, "ELOCKED")) return EAGAIN;
  if (!strcmp(code, "EROFS")) return EROFS;
  if (!strcmp(code, "EINVAL")) return EINVAL;
  return EIO;
}

static int bridge_call(Buffer *request, uint8_t **output, size_t *output_size) {
  size_t cap = 65536;
  uint8_t *response = malloc(cap);
  if (!response) return -ENOMEM;
  for (;;) {
    int result = __neru_fs_call(request->data, request->size, response, cap);
    if (result < 0) { free(response); return result; }
    if ((size_t)result <= cap) {
      *output = response; *output_size = (size_t)result;
      return 0;
    }
    if ((size_t)result > MAX_RESPONSE) { free(response); return -E2BIG; }
    cap = (size_t)result;
    uint8_t *next = realloc(response, cap);
    if (!next) { free(response); return -ENOMEM; }
    response = next;
  }
}

static void free_snapshot(void) {
  for (size_t i = 0; i < snapshot.count; ++i) {
    free(snapshot.entries[i].path); free(snapshot.entries[i].target); free(snapshot.entries[i].data);
  }
  free(snapshot.entries); memset(&snapshot, 0, sizeof(snapshot));
}

static int parse_error(Reader *reader) {
  char *code = reader_text(reader); char *message = reader_text(reader);
  int error = errno_code(code);
  fprintf(stderr, "nerufs: authority: %s: %s\n", code, message);
  free(code); free(message); return -error;
}

