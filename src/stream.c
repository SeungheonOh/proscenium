/*
 * The remote access thread: one poll loop serving HTTP, HTTPS and WebSocket
 * viewers, and the H.264 encoder they share. Everything but the public
 * functions at the end runs on the thread; those only swap buffers and queue
 * events under a short lock.
 *
 * Viewer protocol, over the WebSocket at /ws:
 *   server -> viewer, text:   {"type":"config","codec":"avc1.PPCCLL","width":W,"height":H,"encoder":NAME}
 *                             before the first keyframe of each configuration;
 *                             {"type":"cursor","name":CSS} as the pointer's shape changes
 *   server -> viewer, binary: [1][key][0][0][float64 ms] then one access unit in Annex B
 *   viewer -> server, binary: [type][flag][fingers][0] then 32-bit little-endian fields:
 *                             1 motion (x, y floats 0..1), 2 button (flag down, evdev code),
 *                             3 scroll (flag notches, dx, dy floats), 4 key (flag down,
 *                             evdev code), 5 release all, 6 keyframe wanted,
 *                             7 swipe (flag phase, dx, dy), 8 pinch (flag phase, scale,
 *                             rotation, dx, dy)
 */
#define _GNU_SOURCE
#include "stream.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <math.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/eventfd.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <arpa/inet.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <wlr/util/log.h>

#include "remote-page.h"

#define MAX_CLIENTS 16
/* Longest HTTP request head, and largest message a viewer may send. */
#define MAX_REQUEST 16384
#define MAX_MESSAGE 4096
/* Unsent bytes the kernel may hold per viewer: more would add latency the backlog check cannot see. */
#define UNSENT_LIMIT (64 * 1024)
/* Shortest time between keyframes asked for by viewers that fell behind. */
#define KEY_INTERVAL 0.5
/* Seconds of video a viewer may have queued before it skips to the next keyframe. */
#define BACKLOG_SECONDS 0.15

enum message_type {
    INPUT_MOTION = 1, INPUT_BUTTON, INPUT_SCROLL, INPUT_KEY, INPUT_RELEASE, INPUT_KEYFRAME,
    INPUT_SWIPE, INPUT_PINCH,
};

struct bytes {
    uint8_t *data;
    size_t length, offset, capacity;
};

static void bytes_append(struct bytes *b, const void *data, size_t length) {
    if (b->offset && b->offset == b->length) b->offset = b->length = 0;
    if (b->length + length > b->capacity) {
        /* Reclaim what was sent before growing. */
        if (b->offset) {
            memmove(b->data, b->data + b->offset, b->length - b->offset);
            b->length -= b->offset;
            b->offset = 0;
        }
        if (b->length + length > b->capacity) {
            b->capacity = MAX(b->length + length, b->capacity * 2);
            b->data = xrealloc(b->data, b->capacity);
        }
    }
    memcpy(b->data + b->length, data, length);
    b->length += length;
}

static size_t bytes_pending(const struct bytes *b) {
    return b->length - b->offset;
}

static void bytes_consume(struct bytes *b, size_t length) {
    b->offset += length;
    if (b->offset == b->length) b->offset = b->length = 0;
}

enum client_state { CLIENT_NEW, CLIENT_HTTP, CLIENT_SOCKET };

struct client {
    int fd;
    SSL *ssl;
    enum client_state state;
    struct bytes in, out;
    /* A TLS read wants the socket writable before it can go on. */
    bool read_wants_write;
    bool close_after_flush, dead;
    /* The configuration the viewer decodes with; it takes no frame until its keyframe. */
    int generation;
    bool needs_key;
};

struct encoder {
    const char *name;
    AVCodecContext *context;
    AVBufferRef *device, *frames;
    AVFrame *frame, *hardware;
    AVPacket *packet;
    /* Into the encoder's format from `input`, unless they are the same. */
    struct SwsContext *scale;
    enum stream_format input;
    int width, height;
    int64_t last_pts;
    /* The newest parameter sets, Annex B, put before keyframes that come without them. */
    uint8_t headers[512];
    size_t headers_length;
    char codec[32];
};

struct stream {
    pthread_t thread;
    int listen_fd, wake_fd, event_fd;
    SSL_CTX *tls;
    int port, bitrate, fps;
    char url[64];

    pthread_mutex_t lock;
    /* Under the lock: the newest frame not yet taken, a spare buffer, events for the owner. */
    uint8_t *pending, *spare;
    int pending_width, pending_height;
    enum stream_format pending_format;
    size_t pending_size;
    size_t spare_size;
    struct stream_event *events;
    size_t event_count, event_capacity;
    char cursor[32];
    bool cursor_changed, quit;

    /* The thread's own. */
    struct client clients[MAX_CLIENTS];
    int client_count, viewers;
    uint8_t *work;
    int work_width, work_height;
    enum stream_format work_format;
    size_t work_size;
    bool have_frame;
    struct encoder *encoder;
    /* Encoders that failed to open or encode, by index in `candidates`. */
    uint32_t failed;
    int generation;
    char config[256];
    /* A keyframe is wanted, and when the last forced one was. */
    bool key_wanted;
    double key_at;
    char cursor_shown[32];
    double started_at;
};

/* Events for the owner. */

static void post(struct stream *stream, const struct stream_event *event) {
    pthread_mutex_lock(&stream->lock);
    if (stream->event_count == stream->event_capacity) {
        stream->event_capacity = MAX(16, stream->event_capacity * 2);
        stream->events = xrealloc(stream->events, stream->event_capacity * sizeof *stream->events);
    }
    stream->events[stream->event_count++] = *event;
    pthread_mutex_unlock(&stream->lock);
    uint64_t one = 1;
    if (write(stream->event_fd, &one, sizeof one) < 0) {
        /* The counter only saturates; the owner drains it. */
    }
}

/* TLS: a self-signed certificate made once and kept. */

static char *certificate_path(void) {
    const char *state = getenv("XDG_STATE_HOME");
    const char *home = getenv("HOME");
    char directory[1024];
    if (state && *state) snprintf(directory, sizeof directory, "%s/proscenium", state);
    else if (home && *home) snprintf(directory, sizeof directory, "%s/.local/state/proscenium", home);
    else return NULL;
    /* Make each level; existing ones are fine. */
    for (char *slash = strchr(directory + 1, '/'); slash; slash = strchr(slash + 1, '/')) {
        *slash = '\0';
        mkdir(directory, 0700);
        *slash = '/';
    }
    mkdir(directory, 0700);
    char *path;
    return asprintf(&path, "%s/remote.pem", directory) < 0 ? NULL : path;
}

static bool make_certificate(const char *path) {
    EVP_PKEY *key = EVP_EC_gen("P-256");
    X509 *cert = X509_new();
    bool made = false;
    if (!key || !cert) goto done;
    X509_set_version(cert, 2);
    uint64_t serial;
    RAND_bytes((unsigned char *)&serial, sizeof serial);
    ASN1_INTEGER_set_uint64(X509_get_serialNumber(cert), serial >> 1);
    X509_gmtime_adj(X509_getm_notBefore(cert), -3600);
    X509_gmtime_adj(X509_getm_notAfter(cert), 10L * 365 * 24 * 3600);
    X509_set_pubkey(cert, key);
    X509_NAME *name = X509_get_subject_name(cert);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, (const unsigned char *)"proscenium", -1,
                               -1, 0);
    X509_set_issuer_name(cert, name);
    X509V3_CTX v3;
    X509V3_set_ctx_nodb(&v3);
    X509V3_set_ctx(&v3, cert, cert, NULL, NULL, 0);
    X509_EXTENSION *alt =
        X509V3_EXT_conf_nid(NULL, &v3, NID_subject_alt_name, "DNS:localhost,IP:127.0.0.1");
    if (alt) {
        X509_add_ext(cert, alt, -1);
        X509_EXTENSION_free(alt);
    }
    if (!X509_sign(cert, key, EVP_sha256())) goto done;
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) goto done;
    FILE *file = fdopen(fd, "w");
    if (!file) {
        close(fd);
        goto done;
    }
    made = PEM_write_PrivateKey(file, key, NULL, NULL, 0, NULL, NULL) && PEM_write_X509(file, cert);
    made = fclose(file) == 0 && made;
done:
    X509_free(cert);
    EVP_PKEY_free(key);
    return made;
}

static SSL_CTX *make_tls(void) {
    char *path = certificate_path();
    if (!path) return NULL;
    if (access(path, R_OK) != 0 && !make_certificate(path)) {
        wlr_log(WLR_ERROR, "remote: cannot make a certificate at %s; https is off", path);
        free(path);
        return NULL;
    }
    SSL_CTX *tls = SSL_CTX_new(TLS_server_method());
    if (tls && SSL_CTX_use_certificate_chain_file(tls, path) == 1 &&
        SSL_CTX_use_PrivateKey_file(tls, path, SSL_FILETYPE_PEM) == 1) {
        SSL_CTX_set_min_proto_version(tls, TLS1_2_VERSION);
        SSL_CTX_set_mode(tls, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
        free(path);
        return tls;
    }
    wlr_log(WLR_ERROR, "remote: cannot load the certificate at %s; https is off", path);
    SSL_CTX_free(tls);
    free(path);
    return NULL;
}

/* Viewer connections. */

/* > 0 bytes, 0 at the end, -1 to wait, -2 on error. */
static ssize_t client_read(struct client *c, void *buffer, size_t size) {
    if (c->ssl) {
        int n = SSL_read(c->ssl, buffer, (int)MIN(size, (size_t)INT32_MAX));
        if (n > 0) return n;
        switch (SSL_get_error(c->ssl, n)) {
        case SSL_ERROR_WANT_READ: return -1;
        case SSL_ERROR_WANT_WRITE: c->read_wants_write = true; return -1;
        case SSL_ERROR_ZERO_RETURN: return 0;
        default: ERR_clear_error(); return -2;
        }
    }
    ssize_t n = recv(c->fd, buffer, size, 0);
    if (n >= 0) return n;
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR ? -1 : -2;
}

static ssize_t client_write(struct client *c, const void *data, size_t size) {
    if (c->ssl) {
        int n = SSL_write(c->ssl, data, (int)MIN(size, (size_t)INT32_MAX));
        if (n > 0) return n;
        switch (SSL_get_error(c->ssl, n)) {
        case SSL_ERROR_WANT_READ:
        case SSL_ERROR_WANT_WRITE: return -1;
        default: ERR_clear_error(); return -2;
        }
    }
    ssize_t n = send(c->fd, data, size, MSG_NOSIGNAL);
    if (n >= 0) return n;
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR ? -1 : -2;
}

static void flush(struct client *c) {
    if (c->dead) return;
    while (bytes_pending(&c->out)) {
        ssize_t n = client_write(c, c->out.data + c->out.offset, bytes_pending(&c->out));
        if (n == -1) return;
        if (n < 0) {
            c->dead = true;
            return;
        }
        bytes_consume(&c->out, (size_t)n);
    }
    if (c->close_after_flush) c->dead = true;
}

static void send_frame(struct client *c, uint8_t opcode, const void *data, size_t length) {
    uint8_t head[10];
    size_t size;
    head[0] = 0x80 | opcode;
    if (length < 126) {
        head[1] = (uint8_t)length;
        size = 2;
    } else if (length < 65536) {
        head[1] = 126;
        head[2] = (uint8_t)(length >> 8);
        head[3] = (uint8_t)length;
        size = 4;
    } else {
        head[1] = 127;
        for (int i = 0; i < 8; i++) head[2 + i] = (uint8_t)((uint64_t)length >> (56 - 8 * i));
        size = 10;
    }
    bytes_append(&c->out, head, size);
    bytes_append(&c->out, data, length);
}

static void send_text(struct client *c, const char *text) {
    send_frame(c, 0x1, text, strlen(text));
}

static void respond(struct client *c, const char *status, const char *type, const char *body,
                    size_t length) {
    char head[512];
    int n = snprintf(head, sizeof head,
                     "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
                     "Cache-Control: no-store\r\nConnection: close\r\n\r\n",
                     status, type, length);
    bytes_append(&c->out, head, (size_t)n);
    bytes_append(&c->out, body, length);
    c->close_after_flush = true;
}

/* The value of header NAME in the request head, without surrounding blanks, in OUT. */
static bool header(const char *head, const char *name, char *out, size_t size) {
    size_t name_length = strlen(name);
    for (const char *line = strstr(head, "\r\n"); line; line = strstr(line, "\r\n")) {
        line += 2;
        if (strncasecmp(line, name, name_length) || line[name_length] != ':') continue;
        const char *value = line + name_length + 1;
        while (*value == ' ' || *value == '\t') value++;
        const char *end = strstr(value, "\r\n");
        if (!end) return false;
        while (end > value && (end[-1] == ' ' || end[-1] == '\t')) end--;
        size_t length = MIN((size_t)(end - value), size - 1);
        memcpy(out, value, length);
        out[length] = '\0';
        return true;
    }
    return false;
}

static bool contains_token(const char *list, const char *token) {
    size_t length = strlen(token);
    for (const char *p = list; (p = strcasestr(p, token)); p += length) {
        bool starts = p == list || p[-1] == ',' || p[-1] == ' ';
        bool ends = !p[length] || p[length] == ',' || p[length] == ' ';
        if (starts && ends) return true;
    }
    return false;
}

/* Ask for a keyframe: at once for a viewer that just joined, else no sooner than KEY_INTERVAL
 * after the last, so a viewer that keeps falling behind cannot flood the link with them. */
static void request_key(struct stream *stream, bool now) {
    stream->key_wanted = true;
    if (now) stream->key_at = -INFINITY;
}

static bool key_due(const struct stream *stream) {
    return stream->key_wanted && now_seconds() - stream->key_at >= KEY_INTERVAL;
}

static void upgraded(struct stream *stream, struct client *c) {
    c->state = CLIENT_SOCKET;
    c->generation = -1;
    c->needs_key = true;
    stream->viewers++;
    post(stream, &(struct stream_event){.type = STREAM_EVENT_VIEWERS, .viewers = stream->viewers});
    if (stream->cursor_shown[0]) {
        char text[96];
        snprintf(text, sizeof text, "{\"type\":\"cursor\",\"name\":\"%s\"}", stream->cursor_shown);
        send_text(c, text);
    }
    request_key(stream, true);
    wlr_log(WLR_INFO, "remote: a viewer joined (%d watching)", stream->viewers);
}

static void handle_request(struct stream *stream, struct client *c, char *head) {
    char method[8], path[256];
    if (sscanf(head, "%7s %255s", method, path) != 2 || strcmp(method, "GET")) {
        respond(c, "405 Method Not Allowed", "text/plain", "", 0);
        return;
    }
    char *query = strchr(path, '?');
    if (query) *query = '\0';
    if (!strcmp(path, "/ws")) {
        char upgrade[64], connection[128], key[64];
        if (!header(head, "Upgrade", upgrade, sizeof upgrade) ||
            strcasecmp(upgrade, "websocket") ||
            !header(head, "Connection", connection, sizeof connection) ||
            !contains_token(connection, "upgrade") ||
            !header(head, "Sec-WebSocket-Key", key, sizeof key)) {
            respond(c, "400 Bad Request", "text/plain", "", 0);
            return;
        }
        char joined[128];
        int n = snprintf(joined, sizeof joined, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
        unsigned char digest[SHA_DIGEST_LENGTH];
        SHA1((const unsigned char *)joined, (size_t)n, digest);
        char accept[64];
        EVP_EncodeBlock((unsigned char *)accept, digest, SHA_DIGEST_LENGTH);
        char response[256];
        n = snprintf(response, sizeof response,
                     "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                     "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
                     accept);
        bytes_append(&c->out, response, (size_t)n);
        upgraded(stream, c);
        return;
    }
    if (!strcmp(path, "/") || !strcmp(path, "/index.html")) {
        respond(c, "200 OK", "text/html; charset=utf-8", remote_page, sizeof remote_page - 1);
        return;
    }
    respond(c, "404 Not Found", "text/plain", "", 0);
}

static float read_float(const uint8_t *p) {
    uint32_t bits = (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
    float value;
    memcpy(&value, &bits, sizeof value);
    return isfinite(value) ? value : 0;
}

static uint32_t read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void handle_input(struct stream *stream, const uint8_t *m, size_t length) {
    if (length < 12) return;
    struct stream_event event = {0};
    switch (m[0]) {
    case INPUT_MOTION:
        event.type = STREAM_EVENT_MOTION;
        event.x = CLAMP(read_float(m + 4), 0, 1);
        event.y = CLAMP(read_float(m + 8), 0, 1);
        break;
    case INPUT_BUTTON:
        event.type = STREAM_EVENT_BUTTON;
        event.code = read_u32(m + 4);
        event.pressed = m[1];
        /* BTN_MOUSE to BTN_TASK. */
        if (event.code < 0x110 || event.code > 0x117) return;
        break;
    case INPUT_SCROLL:
        event.type = STREAM_EVENT_SCROLL;
        event.discrete = m[1];
        event.dx = CLAMP(read_float(m + 4), -10000, 10000);
        event.dy = CLAMP(read_float(m + 8), -10000, 10000);
        break;
    case INPUT_KEY:
        event.type = STREAM_EVENT_KEY;
        event.code = read_u32(m + 4);
        event.pressed = m[1];
        /* Keys, not buttons: below BTN_MISC, or KEY_OK and above. */
        if (event.code == 0 || (event.code >= 0x100 && event.code < 0x160) || event.code > 0x2ff)
            return;
        break;
    case INPUT_RELEASE: event.type = STREAM_EVENT_RELEASE; break;
    case INPUT_SWIPE:
    case INPUT_PINCH:
        if (m[1] > STREAM_CANCEL || m[2] < 2 || m[2] > 5) return;
        event.phase = m[1];
        event.fingers = m[2];
        if (m[0] == INPUT_SWIPE) {
            event.type = STREAM_EVENT_SWIPE;
            event.dx = CLAMP(read_float(m + 4), -10000, 10000);
            event.dy = CLAMP(read_float(m + 8), -10000, 10000);
        } else {
            if (length < 20) return;
            event.type = STREAM_EVENT_PINCH;
            event.scale = CLAMP(read_float(m + 4), 0.01, 100);
            event.rotation = CLAMP(read_float(m + 8), -360, 360);
            event.dx = CLAMP(read_float(m + 12), -10000, 10000);
            event.dy = CLAMP(read_float(m + 16), -10000, 10000);
        }
        break;
    case INPUT_KEYFRAME: request_key(stream, false); return;
    default: return;
    }
    post(stream, &event);
}

/* Take whole WebSocket messages from the viewer's input. */
static void read_messages(struct stream *stream, struct client *c) {
    for (;;) {
        const uint8_t *p = c->in.data + c->in.offset;
        size_t available = bytes_pending(&c->in);
        if (available < 2) return;
        uint8_t opcode = p[0] & 0x0f;
        bool masked = p[1] & 0x80;
        uint64_t length = p[1] & 0x7f;
        size_t head = 2;
        if (length == 126) {
            if (available < 4) return;
            length = (uint64_t)p[2] << 8 | p[3];
            head = 4;
        } else if (length == 127) {
            if (available < 10) return;
            length = 0;
            for (int i = 0; i < 8; i++) length = length << 8 | p[2 + i];
            head = 10;
        }
        /* Viewers mask what they send, and send nothing large. */
        if (!masked || length > MAX_MESSAGE) {
            c->dead = true;
            return;
        }
        if (available < head + 4 + length) return;
        uint8_t message[MAX_MESSAGE];
        const uint8_t *mask = p + head;
        for (size_t i = 0; i < length; i++) message[i] = p[head + 4 + i] ^ mask[i & 3];
        bytes_consume(&c->in, head + 4 + (size_t)length);
        switch (opcode) {
        case 0x2: handle_input(stream, message, (size_t)length); break;
        case 0x8:
            send_frame(c, 0x8, message, MIN((size_t)length, 2));
            c->close_after_flush = true;
            return;
        case 0x9: send_frame(c, 0xA, message, (size_t)length); break;
        default: break;
        }
    }
}

static void client_readable(struct stream *stream, struct client *c) {
    if (c->state == CLIENT_NEW) {
        /* A TLS handshake starts with a handshake record; anything else is plain HTTP. */
        uint8_t first;
        ssize_t n = recv(c->fd, &first, 1, MSG_PEEK);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
            c->dead = true;
            return;
        }
        if (n < 0) return;
        if (first == 0x16) {
            if (!stream->tls || !(c->ssl = SSL_new(stream->tls))) {
                c->dead = true;
                return;
            }
            SSL_set_fd(c->ssl, c->fd);
            SSL_set_accept_state(c->ssl);
        }
        c->state = CLIENT_HTTP;
    }
    uint8_t buffer[16384];
    for (;;) {
        ssize_t n = client_read(c, buffer, sizeof buffer);
        if (n == -1) break;
        if (n <= 0) {
            c->dead = true;
            return;
        }
        if (c->close_after_flush) continue;
        bytes_append(&c->in, buffer, (size_t)n);
        if (c->state == CLIENT_HTTP) {
            if (bytes_pending(&c->in) > MAX_REQUEST) {
                c->dead = true;
                return;
            }
            uint8_t zero = 0;
            bytes_append(&c->in, &zero, 1);
            c->in.length--;
            char *head = (char *)c->in.data + c->in.offset;
            char *end = strstr(head, "\r\n\r\n");
            if (!end) continue;
            end[2] = '\0';
            size_t used = (size_t)(end + 4 - head);
            handle_request(stream, c, head);
            bytes_consume(&c->in, used);
        }
        if (c->state == CLIENT_SOCKET) read_messages(stream, c);
        if (c->dead) return;
    }
}

static void drop(struct stream *stream, struct client *c) {
    if (c->state == CLIENT_SOCKET) {
        stream->viewers--;
        post(stream, &(struct stream_event){.type = STREAM_EVENT_RELEASE});
        post(stream,
             &(struct stream_event){.type = STREAM_EVENT_VIEWERS, .viewers = stream->viewers});
        wlr_log(WLR_INFO, "remote: a viewer left (%d watching)", stream->viewers);
    }
    if (c->ssl) SSL_free(c->ssl);
    close(c->fd);
    free(c->in.data);
    free(c->out.data);
    *c = stream->clients[--stream->client_count];
    stream->clients[stream->client_count] = (struct client){0};
}

static void accept_clients(struct stream *stream) {
    for (;;) {
        int fd = accept4(stream->listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (fd < 0) return;
        if (stream->client_count == MAX_CLIENTS) {
            close(fd);
            continue;
        }
        int one = 1, unsent = UNSENT_LIMIT;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        setsockopt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, &unsent, sizeof unsent);
        stream->clients[stream->client_count++] = (struct client){.fd = fd};
    }
}

/* Encoding. */

static const char *const candidates[] = {
    "h264_vaapi", "h264_nvenc", "h264_v4l2m2m", "libx264", "libopenh264",
};
#define CANDIDATES (int)(sizeof candidates / sizeof *candidates)

static void close_encoder(struct encoder *e) {
    if (!e) return;
    avcodec_free_context(&e->context);
    av_buffer_unref(&e->frames);
    av_buffer_unref(&e->device);
    av_frame_free(&e->frame);
    av_frame_free(&e->hardware);
    av_packet_free(&e->packet);
    sws_freeContext(e->scale);
    free(e);
}

/* The software format NAME takes frames in: NV12 if it can, else planar 4:2:0. */
static enum AVPixelFormat input_format(const AVCodec *codec) {
    const void *formats = NULL;
    int count = 0;
    if (avcodec_get_supported_config(NULL, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0, &formats, &count) <
            0 ||
        !formats)
        return AV_PIX_FMT_YUV420P;
    const enum AVPixelFormat *list = formats;
    for (int i = 0; i < count; i++) {
        if (list[i] == AV_PIX_FMT_NV12) return AV_PIX_FMT_NV12;
    }
    return AV_PIX_FMT_YUV420P;
}

static struct encoder *open_encoder(struct stream *stream, int index, int width, int height) {
    const char *name = candidates[index];
    const AVCodec *codec = avcodec_find_encoder_by_name(name);
    if (!codec) return NULL;
    struct encoder *e = xcalloc(1, sizeof *e);
    e->name = name;
    e->width = width;
    e->height = height;
    e->last_pts = -1;
    AVCodecContext *c = e->context = avcodec_alloc_context3(codec);
    int bitrate = stream->bitrate > 0 ? stream->bitrate * 1000
                                      : (int)CLAMP((double)width * height * stream->fps / 12, 2e6, 4e7);
    c->width = width;
    c->height = height;
    c->time_base = (AVRational){1, 1000};
    c->framerate = (AVRational){stream->fps, 1};
    /* Keyframes when a viewer needs one; between, one every ten seconds. */
    c->gop_size = stream->fps * 10;
    c->max_b_frames = 0;
    c->flags |= AV_CODEC_FLAG_LOW_DELAY;
    c->bit_rate = bitrate;
    c->rc_max_rate = bitrate;
    c->rc_buffer_size = bitrate / 2;
    c->color_range = AVCOL_RANGE_MPEG;
    c->colorspace = AVCOL_SPC_BT709;
    c->color_primaries = AVCOL_PRI_BT709;
    c->color_trc = AVCOL_TRC_BT709;
    enum AVPixelFormat software = input_format(codec);
    AVDictionary *options = NULL;
    bool vaapi = !strcmp(name, "h264_vaapi");
    if (vaapi) {
        software = AV_PIX_FMT_NV12;
        if (av_hwdevice_ctx_create(&e->device, AV_HWDEVICE_TYPE_VAAPI, NULL, NULL, 0) < 0) {
            wlr_log(WLR_INFO, "remote: no VA-API device for %s", name);
            goto fail;
        }
        e->frames = av_hwframe_ctx_alloc(e->device);
        AVHWFramesContext *frames = (AVHWFramesContext *)e->frames->data;
        frames->format = AV_PIX_FMT_VAAPI;
        frames->sw_format = AV_PIX_FMT_NV12;
        frames->width = width;
        frames->height = height;
        frames->initial_pool_size = 4;
        if (av_hwframe_ctx_init(e->frames) < 0) goto fail;
        c->hw_frames_ctx = av_buffer_ref(e->frames);
        c->pix_fmt = AV_PIX_FMT_VAAPI;
        av_dict_set(&options, "async_depth", "1", 0);
        av_dict_set(&options, "rc_mode", "CBR", 0);
    } else {
        c->pix_fmt = software;
    }
    if (!strcmp(name, "h264_nvenc")) {
        av_dict_set(&options, "preset", "p1", 0);
        av_dict_set(&options, "tune", "ull", 0);
        av_dict_set(&options, "zerolatency", "1", 0);
        av_dict_set(&options, "rc", "cbr", 0);
        av_dict_set(&options, "delay", "0", 0);
    } else if (!strcmp(name, "libx264")) {
        av_dict_set(&options, "preset", "ultrafast", 0);
        av_dict_set(&options, "tune", "zerolatency", 0);
        /* Slices on half the cores: the compositor and its render thread keep the rest. */
        long cores = sysconf(_SC_NPROCESSORS_ONLN);
        c->thread_count = (int)CLAMP(cores / 2, 1, 8);
    } else if (!strcmp(name, "h264_v4l2m2m")) {
        av_dict_set(&options, "num_output_buffers", "2", 0);
        av_dict_set(&options, "num_capture_buffers", "4", 0);
    }
    int error = avcodec_open2(c, codec, &options);
    av_dict_free(&options);
    if (error < 0) {
        char reason[128];
        av_strerror(error, reason, sizeof reason);
        wlr_log(WLR_INFO, "remote: %s cannot encode %dx%d: %s", name, width, height, reason);
        goto fail;
    }
    e->frame = av_frame_alloc();
    e->frame->format = software;
    e->frame->width = width;
    e->frame->height = height;
    e->frame->color_range = AVCOL_RANGE_MPEG;
    e->frame->colorspace = AVCOL_SPC_BT709;
    e->frame->color_primaries = AVCOL_PRI_BT709;
    e->frame->color_trc = AVCOL_TRC_BT709;
    if (av_frame_get_buffer(e->frame, 0) < 0) goto fail;
    if (vaapi) e->hardware = av_frame_alloc();
    e->packet = av_packet_alloc();
    e->input = -1;
    if (c->extradata_size > 0 && (size_t)c->extradata_size <= sizeof e->headers &&
        c->extradata[0] == 0) {
        memcpy(e->headers, c->extradata, (size_t)c->extradata_size);
        e->headers_length = (size_t)c->extradata_size;
    }
    return e;
fail:
    close_encoder(e);
    return NULL;
}

/* Start codes and NAL units in Annex B. */
static const uint8_t *next_nal(const uint8_t *p, const uint8_t *end, size_t *code_length) {
    for (; p + 3 <= end; p++) {
        if (p[0] == 0 && p[1] == 0) {
            if (p[2] == 1) {
                *code_length = 3;
                return p;
            }
            if (p + 4 <= end && p[2] == 0 && p[3] == 1) {
                *code_length = 4;
                return p;
            }
        }
    }
    return end;
}

/* Note parameter sets in DATA; whether it holds an SPS and an IDR slice. */
static void scan_packet(struct encoder *e, const uint8_t *data, size_t length, bool *has_sps,
                        bool *has_idr) {
    const uint8_t *end = data + length;
    size_t code;
    const uint8_t *nal = next_nal(data, end, &code);
    size_t headers = 0;
    uint8_t found[sizeof e->headers];
    *has_sps = *has_idr = false;
    while (nal < end) {
        const uint8_t *body = nal + code;
        size_t next_code;
        const uint8_t *next = next_nal(body, end, &next_code);
        int type = body < end ? body[0] & 0x1f : 0;
        if (type == 5) *has_idr = true;
        if (type == 7 || type == 8) {
            if (type == 7) {
                *has_sps = true;
                if (body + 4 <= end)
                    snprintf(e->codec, sizeof e->codec, "avc1.%02x%02x%02x", body[1], body[2],
                             body[3]);
            }
            size_t size = (size_t)(next - nal);
            if (headers + size <= sizeof found) {
                memcpy(found + headers, nal, size);
                headers += size;
            }
        }
        nal = next;
        code = next_code;
    }
    if (*has_sps && headers) {
        memcpy(e->headers, found, headers);
        e->headers_length = headers;
    }
}

static void deliver(struct stream *stream, struct encoder *e, const AVPacket *packet) {
    bool has_sps, has_idr;
    scan_packet(e, packet->data, (size_t)packet->size, &has_sps, &has_idr);
    bool key = (packet->flags & AV_PKT_FLAG_KEY) || has_idr;
    if (!e->codec[0] && e->headers_length) {
        bool ignored_sps, ignored_idr;
        scan_packet(e, e->headers, e->headers_length, &ignored_sps, &ignored_idr);
    }
    if (key && e->codec[0]) {
        char config[256];
        snprintf(config, sizeof config,
                 "{\"type\":\"config\",\"codec\":\"%s\",\"width\":%d,\"height\":%d,"
                 "\"encoder\":\"%s\"}",
                 e->codec, e->width, e->height, e->name);
        if (strcmp(config, stream->config)) {
            stream->generation++;
            snprintf(stream->config, sizeof stream->config, "%s", config);
        }
    }
    bool prepend = key && !has_sps && e->headers_length;
    size_t length = 12 + (prepend ? e->headers_length : 0) + (size_t)packet->size;
    uint8_t *message = xmalloc(length);
    message[0] = 1;
    message[1] = key;
    message[2] = message[3] = 0;
    double ms = 1000 * (now_seconds() - stream->started_at);
    memcpy(message + 4, &ms, sizeof ms);
    size_t at = 12;
    if (prepend) {
        memcpy(message + at, e->headers, e->headers_length);
        at += e->headers_length;
    }
    memcpy(message + at, packet->data, (size_t)packet->size);
    /* BACKLOG_SECONDS of video at the target rate, in bytes: how much a viewer may have queued. */
    size_t backlog = (size_t)(BACKLOG_SECONDS * e->context->bit_rate / 8);
    for (int i = 0; i < stream->client_count; i++) {
        struct client *c = &stream->clients[i];
        if (c->state != CLIENT_SOCKET || c->dead || c->close_after_flush) continue;
        size_t queued = bytes_pending(&c->out);
        if (!key) {
            if (c->needs_key || c->generation != stream->generation) continue;
            if (queued > backlog) {
                /* Behind: skip to the next keyframe rather than fall further back. */
                c->needs_key = true;
                request_key(stream, false);
                continue;
            }
        } else {
            if (queued > backlog + length) {
                c->needs_key = true;
                request_key(stream, false);
                continue;
            }
            if (c->generation != stream->generation) {
                send_text(c, stream->config);
                c->generation = stream->generation;
            }
            c->needs_key = false;
        }
        send_frame(c, 0x2, message, length);
    }
    free(message);
}

/* Put the work frame, in whatever format it came, into the encoder's input frame. */
static bool fill_frame(struct stream *stream, struct encoder *e) {
    enum stream_format input = stream->work_format;
    int width = e->width, height = e->height;
    const uint8_t *source[4] = {0};
    int stride[4] = {0};
    if (input == STREAM_I420) {
        source[0] = stream->work;
        source[1] = source[0] + (size_t)width * height;
        source[2] = source[1] + (size_t)width * height / 4;
        stride[0] = width;
        stride[1] = stride[2] = width / 2;
    } else {
        source[0] = stream->work;
        stride[0] = width * 4;
    }
    enum AVPixelFormat from = input == STREAM_I420 ? AV_PIX_FMT_YUV420P : AV_PIX_FMT_RGBA;
    if (from == e->frame->format) {
        av_image_copy2(e->frame->data, e->frame->linesize, (uint8_t *const *)source, stride, from,
                       width, height);
        return true;
    }
    if (e->input != input) {
        sws_freeContext(e->scale);
        e->scale = sws_getContext(width, height, from, width, height, e->frame->format, SWS_POINT,
                                  NULL, NULL, NULL);
        if (!e->scale) return false;
        /* Limited-range BT.709, as the stream says. */
        const int *bt709 = sws_getCoefficients(SWS_CS_ITU709);
        sws_setColorspaceDetails(e->scale, bt709, input == STREAM_RGBA, bt709, 0, 0, 1 << 16,
                                 1 << 16);
        e->input = input;
    }
    sws_scale(e->scale, source, stride, 0, height, e->frame->data, e->frame->linesize);
    return true;
}

static bool encode(struct stream *stream, bool force_key) {
    struct encoder *e = stream->encoder;
    if (av_frame_make_writable(e->frame) < 0 || !fill_frame(stream, e)) return false;
    int64_t pts = (int64_t)(1000 * (now_seconds() - stream->started_at));
    e->last_pts = pts = MAX(pts, e->last_pts + 1);
    AVFrame *frame = e->frame;
    if (e->hardware) {
        av_frame_unref(e->hardware);
        if (av_hwframe_get_buffer(e->frames, e->hardware, 0) < 0 ||
            av_hwframe_transfer_data(e->hardware, e->frame, 0) < 0)
            return false;
        frame = e->hardware;
    }
    frame->pts = pts;
    frame->pict_type = force_key ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    if (force_key) frame->flags |= AV_FRAME_FLAG_KEY;
    else frame->flags &= ~AV_FRAME_FLAG_KEY;
    int error = avcodec_send_frame(e->context, frame);
    if (error < 0) {
        char reason[128];
        av_strerror(error, reason, sizeof reason);
        wlr_log(WLR_ERROR, "remote: %s failed: %s", e->name, reason);
        return false;
    }
    while ((error = avcodec_receive_packet(e->context, e->packet)) == 0) {
        deliver(stream, e, e->packet);
        av_packet_unref(e->packet);
    }
    return error == AVERROR(EAGAIN) || error == AVERROR_EOF;
}

/* Encode the newest frame, opening an encoder for its size first if needed. */
static void encode_current(struct stream *stream) {
    if (!stream->have_frame || stream->viewers == 0) return;
    int width = stream->work_width, height = stream->work_height;
    struct encoder *e = stream->encoder;
    if (e && (e->width != width || e->height != height)) {
        close_encoder(e);
        stream->encoder = e = NULL;
    }
    const char *forced = getenv("PROSCENIUM_REMOTE_ENCODER");
    for (;;) {
        if (!stream->encoder) {
            for (int i = 0; i < CANDIDATES && !stream->encoder; i++) {
                if (stream->failed & (1u << i)) continue;
                if (forced && *forced && strcmp(forced, candidates[i])) continue;
                stream->encoder = open_encoder(stream, i, width, height);
                if (!stream->encoder) stream->failed |= 1u << i;
                else
                    wlr_log(WLR_INFO, "remote: encoding %dx%d with %s", width, height,
                            candidates[i]);
            }
            if (!stream->encoder) {
                if (!(stream->failed & (1u << 31)))
                    wlr_log(WLR_ERROR, "remote: no H.264 encoder works%s%s",
                            forced ? " of PROSCENIUM_REMOTE_ENCODER=" : "", forced ? forced : "");
                stream->failed |= 1u << 31;
                return;
            }
            /* A new encoder starts with a keyframe for everyone. */
            request_key(stream, true);
        }
        bool key = key_due(stream);
        if (key) {
            stream->key_wanted = false;
            stream->key_at = now_seconds();
        }
        if (encode(stream, key)) return;
        /* It broke while encoding: the next one takes over. */
        for (int i = 0; i < CANDIDATES; i++) {
            if (candidates[i] == stream->encoder->name) stream->failed |= 1u << i;
        }
        close_encoder(stream->encoder);
        stream->encoder = NULL;
    }
}

static bool take_frame(struct stream *stream) {
    pthread_mutex_lock(&stream->lock);
    bool taken = stream->pending != NULL;
    if (taken) {
        size_t size = stream->pending_size;
        if (stream->work) {
            free(stream->spare);
            stream->spare = stream->work;
            stream->spare_size = stream->work_size;
        }
        stream->work = stream->pending;
        stream->work_size = size;
        stream->work_width = stream->pending_width;
        stream->work_height = stream->pending_height;
        stream->work_format = stream->pending_format;
        stream->pending = NULL;
        stream->have_frame = true;
    }
    pthread_mutex_unlock(&stream->lock);
    return taken;
}

static void update_cursor(struct stream *stream) {
    pthread_mutex_lock(&stream->lock);
    bool changed = stream->cursor_changed;
    if (changed) snprintf(stream->cursor_shown, sizeof stream->cursor_shown, "%s", stream->cursor);
    stream->cursor_changed = false;
    pthread_mutex_unlock(&stream->lock);
    if (!changed) return;
    char text[96];
    snprintf(text, sizeof text, "{\"type\":\"cursor\",\"name\":\"%s\"}", stream->cursor_shown);
    for (int i = 0; i < stream->client_count; i++) {
        if (stream->clients[i].state == CLIENT_SOCKET) send_text(&stream->clients[i], text);
    }
}

static void *run(void *data) {
    struct stream *stream = data;
    /* Encoding yields to the compositor: this thread and the encoder's, which inherit it,
     * run at a lower priority, so a busy encoder never makes the session itself stutter. */
    setpriority(PRIO_PROCESS, (id_t)gettid(), 5);
    struct pollfd fds[2 + MAX_CLIENTS];
    for (;;) {
        fds[0] = (struct pollfd){.fd = stream->wake_fd, .events = POLLIN};
        fds[1] = (struct pollfd){.fd = stream->listen_fd, .events = POLLIN};
        for (int i = 0; i < stream->client_count; i++) {
            struct client *c = &stream->clients[i];
            short events = POLLIN;
            if (bytes_pending(&c->out) || c->read_wants_write) events |= POLLOUT;
            fds[2 + i] = (struct pollfd){.fd = c->fd, .events = events};
        }
        int count = 2 + stream->client_count;
        /* A keyframe asked for by a viewer that fell behind waits out the interval. */
        int timeout = -1;
        if (stream->key_wanted && stream->have_frame && stream->viewers)
            timeout = MAX(0, (int)ceil(1000 * (stream->key_at + KEY_INTERVAL - now_seconds())));
        if (poll(fds, (nfds_t)count, timeout) < 0 && errno != EINTR) break;
        if (fds[0].revents & POLLIN) {
            uint64_t value;
            if (read(stream->wake_fd, &value, sizeof value) < 0) {
                /* Nothing was written since the last read. */
            }
        }
        pthread_mutex_lock(&stream->lock);
        bool quit = stream->quit;
        pthread_mutex_unlock(&stream->lock);
        if (quit) break;
        if (fds[1].revents & POLLIN) accept_clients(stream);
        int polled = count - 2;
        for (int i = 0; i < polled && i < stream->client_count; i++) {
            struct client *c = &stream->clients[i];
            short revents = fds[2 + i].revents;
            if (revents & (POLLIN | POLLHUP | POLLERR)) client_readable(stream, c);
            /* A TLS read that waited for the socket to drain may go on now too. */
            if ((revents & POLLOUT) && c->read_wants_write) {
                c->read_wants_write = false;
                client_readable(stream, c);
            }
        }
        update_cursor(stream);
        /* A new frame, or the last again as the keyframe a viewer waits for on a still screen. */
        if (take_frame(stream) || (key_due(stream) && stream->have_frame)) encode_current(stream);
        for (int i = 0; i < stream->client_count; i++) flush(&stream->clients[i]);
        for (int i = stream->client_count - 1; i >= 0; i--) {
            if (stream->clients[i].dead) drop(stream, &stream->clients[i]);
        }
        /* With nobody watching the encoder lets the GPU go. */
        if (stream->viewers == 0 && stream->encoder) {
            close_encoder(stream->encoder);
            stream->encoder = NULL;
            stream->config[0] = '\0';
        }
    }
    while (stream->client_count) {
        stream->clients[0].state = CLIENT_HTTP;
        drop(stream, &stream->clients[0]);
    }
    close_encoder(stream->encoder);
    stream->encoder = NULL;
    return NULL;
}

/* Listening. */

static int listen_on(const char *address, int port) {
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM,
                             .ai_flags = AI_PASSIVE | AI_NUMERICSERV};
    struct addrinfo *found;
    char service[16];
    snprintf(service, sizeof service, "%d", port);
    bool any = !address || !*address;
    if (any) hints.ai_family = AF_INET6;
    int error = getaddrinfo(any ? NULL : address, service, &hints, &found);
    if (error) {
        wlr_log(WLR_ERROR, "remote: cannot resolve %s: %s", address, gai_strerror(error));
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *a = found; a && fd < 0; a = a->ai_next) {
        fd = socket(a->ai_family, a->ai_socktype | SOCK_NONBLOCK | SOCK_CLOEXEC, a->ai_protocol);
        if (fd < 0) continue;
        int one = 1, zero = 0;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        /* Every interface means IPv4 too. */
        if (a->ai_family == AF_INET6 && any)
            setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero);
        if (bind(fd, a->ai_addr, a->ai_addrlen) < 0 || listen(fd, 16) < 0) {
            wlr_log_errno(WLR_ERROR, "remote: cannot listen on port %d", port);
            close(fd);
            fd = -1;
        }
    }
    freeaddrinfo(found);
    return fd;
}

/* Name in the log where viewers on other machines can connect. */
static void log_addresses(int port) {
    struct ifaddrs *list;
    if (getifaddrs(&list) < 0) return;
    for (struct ifaddrs *a = list; a; a = a->ifa_next) {
        if (!a->ifa_addr || a->ifa_addr->sa_family != AF_INET) continue;
        char text[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &((struct sockaddr_in *)a->ifa_addr)->sin_addr, text, sizeof text);
        if (!strncmp(text, "127.", 4)) continue;
        wlr_log(WLR_INFO, "remote: viewers on %s open https://%s:%d/", a->ifa_name, text, port);
    }
    freeifaddrs(list);
}

struct stream *stream_create(const struct stream_options *options) {
    int fd = listen_on(options->address, options->port);
    if (fd < 0) return NULL;
    struct stream *stream = xcalloc(1, sizeof *stream);
    stream->listen_fd = fd;
    stream->port = options->port;
    stream->bitrate = options->bitrate;
    stream->fps = CLAMP(options->fps > 0 ? options->fps : 60, 1, 240);
    stream->started_at = now_seconds();
    snprintf(stream->url, sizeof stream->url, "http://localhost:%d/", options->port);
    pthread_mutex_init(&stream->lock, NULL);
    stream->wake_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    stream->event_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    stream->tls = make_tls();
    if (stream->wake_fd < 0 || stream->event_fd < 0 ||
        pthread_create(&stream->thread, NULL, run, stream) != 0) {
        wlr_log(WLR_ERROR, "remote: cannot start its thread");
        if (stream->wake_fd >= 0) close(stream->wake_fd);
        if (stream->event_fd >= 0) close(stream->event_fd);
        SSL_CTX_free(stream->tls);
        close(fd);
        pthread_mutex_destroy(&stream->lock);
        free(stream);
        return NULL;
    }
    if (stream->tls) log_addresses(options->port);
    return stream;
}

static void wake(struct stream *stream) {
    uint64_t one = 1;
    if (write(stream->wake_fd, &one, sizeof one) < 0) {
        /* The counter only saturates; the thread drains it. */
    }
}

void stream_destroy(struct stream *stream) {
    if (!stream) return;
    pthread_mutex_lock(&stream->lock);
    stream->quit = true;
    pthread_mutex_unlock(&stream->lock);
    wake(stream);
    pthread_join(stream->thread, NULL);
    close(stream->listen_fd);
    close(stream->wake_fd);
    close(stream->event_fd);
    SSL_CTX_free(stream->tls);
    free(stream->pending);
    free(stream->spare);
    free(stream->work);
    free(stream->events);
    pthread_mutex_destroy(&stream->lock);
    free(stream);
}

int stream_get_fd(struct stream *stream) {
    return stream->event_fd;
}

bool stream_next_event(struct stream *stream, struct stream_event *event) {
    pthread_mutex_lock(&stream->lock);
    bool any = stream->event_count > 0;
    if (any) {
        *event = stream->events[0];
        memmove(stream->events, stream->events + 1, --stream->event_count * sizeof *event);
    } else {
        uint64_t value;
        if (read(stream->event_fd, &value, sizeof value) < 0) {
            /* Already drained. */
        }
    }
    pthread_mutex_unlock(&stream->lock);
    return any;
}

void stream_push_frame(struct stream *stream, uint8_t **pixels, enum stream_format format,
                       int width, int height) {
    size_t size = stream_frame_size(format, width, height);
    pthread_mutex_lock(&stream->lock);
    uint8_t *previous = stream->pending;
    size_t previous_size = stream->pending_size;
    stream->pending = *pixels;
    stream->pending_width = width;
    stream->pending_height = height;
    stream->pending_format = format;
    stream->pending_size = size;
    /* Back goes a buffer of the same size: the frame it replaced, or the spare. */
    uint8_t *back = NULL;
    if (previous && previous_size == size) back = previous;
    else free(previous);
    if (!back && stream->spare && stream->spare_size == size) {
        back = stream->spare;
        stream->spare = NULL;
    }
    pthread_mutex_unlock(&stream->lock);
    *pixels = back ? back : xmalloc(size);
    wake(stream);
}

void stream_set_cursor(struct stream *stream, const char *name) {
    pthread_mutex_lock(&stream->lock);
    if (strcmp(stream->cursor, name)) {
        snprintf(stream->cursor, sizeof stream->cursor, "%s", name);
        stream->cursor_changed = true;
    }
    bool changed = stream->cursor_changed;
    pthread_mutex_unlock(&stream->lock);
    if (changed) wake(stream);
}

const char *stream_local_url(struct stream *stream) {
    return stream->url;
}
