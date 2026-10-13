/*
 * The clipboard, for the director.
 *
 * Text a client copies is sent to the director, which keeps the history a menu
 * shows, and the director can set the clipboard, to text or to a file's data of
 * any type, such as a screenshot. Reads and writes are non-blocking pipe
 * transfers on the event loop, bounded in size and time; selections password
 * managers mark as secret are never read.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_primary_selection.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/util/log.h>

#include "json.h"
#include "link.h"
#include "server.h"
#include "stage.h"

/* The longest text read from a selection, and how long its owner may take. */
#define READ_LIMIT (256 * 1024)
#define TRANSFER_TIMEOUT 2000
#define WRITE_LIMIT (4 * 1024 * 1024)
#define FILE_LIMIT (64 * 1024 * 1024)
#define TRANSFERS_MAX 32

static const char *const TEXT_TYPES[] = {"text/plain;charset=utf-8", "text/plain;charset=UTF-8",
                                         "UTF8_STRING", "text/plain"};
static const char *const SECRET_TYPES[] = {"x-kde-passwordManagerHint",
                                           "application/x-kde-passwordManagerHint",
                                           "application/x-keepassxc"};

struct clipboard {
    struct server *server;
    struct wl_list reads;  /* struct selection_read */
    struct wl_list writes; /* struct text_transfer */
    struct wl_listener set_selection;
};

struct selection_read {
    struct wl_list link;
    struct clipboard *clipboard;
    int fd;
    struct wl_event_source *readable, *timer;
    struct strbuf bytes;
};

/* Data the compositor owns: the director's clipboard. */
struct text_source {
    struct wlr_data_source base;
    struct clipboard *clipboard;
    int references;
    char *text;
    size_t length;
};

struct text_transfer {
    struct wl_list link;
    struct text_source *source;
    int fd;
    size_t offset;
    struct wl_event_source *writable, *timer;
};

/* Reading a client's selection. */

static void finish_read(struct selection_read *read, bool complete) {
    struct clipboard *clipboard = read->clipboard;
    if (complete && read->bytes.length) {
        struct message message;
        message_begin(&message, "clipboard");
        json_key(&message.writer, "text");
        json_string_n(&message.writer, read->bytes.data, read->bytes.length);
        message_send(clipboard->server, &message, NULL);
    }
    wl_event_source_remove(read->readable);
    wl_event_source_remove(read->timer);
    close(read->fd);
    strbuf_finish(&read->bytes);
    wl_list_remove(&read->link);
    free(read);
}

static int read_ready(int fd, uint32_t mask, void *data) {
    struct selection_read *read_state = data;
    char buffer[16384];
    for (int i = 0; i < 4; i++) {
        ssize_t count = read(fd, buffer, sizeof buffer);
        if (count > 0) {
            if (read_state->bytes.length + (size_t)count > READ_LIMIT) {
                finish_read(read_state, false);
                return 0;
            }
            strbuf_append(&read_state->bytes, buffer, (size_t)count);
        } else if (count == 0) {
            finish_read(read_state, true);
            return 0;
        } else {
            if (errno != EAGAIN && errno != EINTR) finish_read(read_state, false);
            return 0;
        }
    }
    return 0;
}

static int read_timeout(void *data) {
    finish_read(data, false);
    return 0;
}

static bool has_type(struct wlr_data_source *source, const char *type) {
    char **mime;
    wl_array_for_each(mime, &source->mime_types) {
        if (!strcmp(*mime, type)) return true;
    }
    return false;
}

static const struct wlr_data_source_impl text_impl;

static void handle_set_selection(struct wl_listener *listener, void *data) {
    struct clipboard *clipboard = wl_container_of(listener, clipboard, set_selection);
    struct server *server = clipboard->server;
    struct wlr_data_source *source = server->seat->selection_source;
    /* Older selections still arriving are stale now. */
    struct selection_read *read, *next;
    wl_list_for_each_safe(read, next, &clipboard->reads, link) finish_read(read, false);
    /* Text the director set itself is already in its history. */
    if (!source || source->impl == &text_impl || !link_connected(server)) return;
    const char *mime = NULL;
    for (size_t i = 0; i < ARRAY_LENGTH(TEXT_TYPES) && !mime; i++) {
        if (has_type(source, TEXT_TYPES[i])) mime = TEXT_TYPES[i];
    }
    for (size_t i = 0; i < ARRAY_LENGTH(SECRET_TYPES); i++) {
        if (has_type(source, SECRET_TYPES[i])) return;
    }
    int fds[2];
    if (!mime || pipe2(fds, O_CLOEXEC | O_NONBLOCK) < 0) return;
    read = xcalloc(1, sizeof *read);
    read->clipboard = clipboard;
    read->fd = fds[0];
    strbuf_init(&read->bytes);
    read->readable =
        wl_event_loop_add_fd(server->loop, fds[0], WL_EVENT_READABLE, read_ready, read);
    read->timer = wl_event_loop_add_timer(server->loop, read_timeout, read);
    wl_event_source_timer_update(read->timer, TRANSFER_TIMEOUT);
    wl_list_insert(&clipboard->reads, &read->link);
    /* The owner writes into, and wlroots closes, the write end. */
    wlr_data_source_send(source, mime, fds[1]);
}

/* Offering the director's text. */

static void source_release(struct text_source *source) {
    if (--source->references > 0) return;
    free(source->text);
    free(source);
}

static void finish_transfer(struct text_transfer *transfer) {
    wl_event_source_remove(transfer->writable);
    wl_event_source_remove(transfer->timer);
    close(transfer->fd);
    source_release(transfer->source);
    wl_list_remove(&transfer->link);
    free(transfer);
}

static int write_ready(int fd, uint32_t mask, void *data) {
    struct text_transfer *transfer = data;
    if (mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR)) {
        finish_transfer(transfer);
        return 0;
    }
    size_t remaining = MIN(transfer->source->length - transfer->offset, (size_t)65536);
    ssize_t written = write(fd, transfer->source->text + transfer->offset, remaining);
    if (written > 0) transfer->offset += (size_t)written;
    if (transfer->offset == transfer->source->length ||
        (written < 0 && errno != EAGAIN && errno != EINTR))
        finish_transfer(transfer);
    return 0;
}

static int write_timeout(void *data) {
    finish_transfer(data);
    return 0;
}

static void text_send(struct wlr_data_source *base, const char *mime, int32_t fd) {
    struct text_source *source = wl_container_of(base, source, base);
    struct clipboard *clipboard = source->clipboard;
    if (wl_list_length(&clipboard->writes) >= TRANSFERS_MAX ||
        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) < 0) {
        close(fd);
        return;
    }
    struct text_transfer *transfer = xcalloc(1, sizeof *transfer);
    transfer->source = source;
    source->references++;
    transfer->fd = fd;
    struct wl_event_loop *loop = clipboard->server->loop;
    transfer->writable = wl_event_loop_add_fd(loop, fd, WL_EVENT_WRITABLE, write_ready, transfer);
    transfer->timer = wl_event_loop_add_timer(loop, write_timeout, transfer);
    wl_event_source_timer_update(transfer->timer, TRANSFER_TIMEOUT);
    wl_list_insert(&clipboard->writes, &transfer->link);
}

static void text_destroy(struct wlr_data_source *base) {
    struct text_source *source = wl_container_of(base, source, base);
    source_release(source);
}

static const struct wlr_data_source_impl text_impl = {.send = text_send, .destroy = text_destroy};

/* Own the first seat's selection with LENGTH bytes of DATA, taken over, offered as TYPES. */
static void offer(struct server *server, char *data, size_t length, const char *const *types,
                  size_t type_count) {
    struct text_source *source = xcalloc(1, sizeof *source);
    source->clipboard = server->clipboard;
    source->references = 1;
    source->text = data;
    source->length = length;
    wlr_data_source_init(&source->base, &text_impl);
    for (size_t i = 0; i < type_count; i++) {
        char **entry = wl_array_add(&source->base.mime_types, sizeof *entry);
        *entry = xstrdup(types[i]);
    }
    wlr_seat_set_selection(server->seat, &source->base, wl_display_next_serial(server->wl_display));
}

void clipboard_set_text(struct server *server, const char *text, size_t length) {
    if (!server->clipboard || length > WRITE_LIMIT) return;
    /* The text may hold NUL bytes: it is copied by length. */
    char *copy = xmalloc(length + 1);
    memcpy(copy, text, length);
    copy[length] = '\0';
    static const char *const offered[] = {"text/plain;charset=utf-8", "text/plain", "UTF8_STRING"};
    offer(server, copy, length, offered, ARRAY_LENGTH(offered));
}

bool clipboard_set_file(struct server *server, const char *mime, const char *path,
                        struct protocol_error *error) {
    /* Only files in the runtime directory, which the director writes for this. */
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    size_t prefix = runtime ? strlen(runtime) : 0;
    if (!prefix || strncmp(path, runtime, prefix) || path[prefix] != '/' || strstr(path, "/.."))
        return protocol_fail(error, "set-clipboard takes files in the runtime directory.");
    if (!*mime || strlen(mime) > 255 || strchr(mime, '\n'))
        return protocol_fail(error, "set-clipboard requires a mime type.");
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat info;
    if (fd < 0 || fstat(fd, &info) < 0 || !S_ISREG(info.st_mode) || info.st_size > FILE_LIMIT) {
        if (fd >= 0) close(fd);
        return protocol_fail(error, "set-clipboard could not read the file.");
    }
    size_t length = (size_t)info.st_size, done = 0;
    char *data = xmalloc(length + 1);
    while (done < length) {
        ssize_t count = read(fd, data + done, length - done);
        if (count <= 0 && !(count < 0 && errno == EINTR)) break;
        if (count > 0) done += (size_t)count;
    }
    close(fd);
    unlink(path);
    if (done < length) {
        free(data);
        return protocol_fail(error, "set-clipboard could not read the file.");
    }
    if (server->clipboard) offer(server, data, length, &mime, 1);
    else free(data);
    return true;
}

/* Client requests. */

static void handle_request_set_selection(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, request_set_selection);
    struct wlr_seat_request_set_selection_event *event = data;
    wlr_seat_set_selection(server->seat, event->source, event->serial);
}

static void handle_request_set_primary_selection(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, request_set_primary_selection);
    struct wlr_seat_request_set_primary_selection_event *event = data;
    wlr_seat_set_primary_selection(server->seat, event->source, event->serial);
}

void clipboard_init(struct server *server) {
    struct clipboard *clipboard = xcalloc(1, sizeof *clipboard);
    clipboard->server = server;
    wl_list_init(&clipboard->reads);
    wl_list_init(&clipboard->writes);
    server->clipboard = clipboard;
    server->request_set_selection.notify = handle_request_set_selection;
    wl_signal_add(&server->seat->events.request_set_selection, &server->request_set_selection);
    server->request_set_primary_selection.notify = handle_request_set_primary_selection;
    wl_signal_add(&server->seat->events.request_set_primary_selection,
                  &server->request_set_primary_selection);
    clipboard->set_selection.notify = handle_set_selection;
    wl_signal_add(&server->seat->events.set_selection, &clipboard->set_selection);
}

void clipboard_finish(struct server *server) {
    struct clipboard *clipboard = server->clipboard;
    if (!clipboard) return;
    struct selection_read *read, *next_read;
    wl_list_for_each_safe(read, next_read, &clipboard->reads, link) finish_read(read, false);
    struct text_transfer *transfer, *next_transfer;
    wl_list_for_each_safe(transfer, next_transfer, &clipboard->writes, link)
        finish_transfer(transfer);
    wl_list_remove(&clipboard->set_selection.link);
    wl_list_remove(&server->request_set_selection.link);
    wl_list_remove(&server->request_set_primary_selection.link);
    free(clipboard);
    server->clipboard = NULL;
}
