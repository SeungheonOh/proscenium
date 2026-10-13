#define _GNU_SOURCE
#include "link.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <wlr/util/log.h>

#include "content.h"
#include "display.h"
#include "input.h"
#include "server.h"
#include "stage.h"

#define MAX_MESSAGE_BYTES (8u << 20)
#define MAX_PENDING_OUTPUT (16u << 20)
/* About one frame: a drag or pan wakes the director at most at display rate. */
#define COALESCE_INTERVAL 0.016

struct coalesced {
    char key[64];
    struct strbuf message;
};

struct director {
    struct link *link;
    int fd;
    struct wl_event_source *source;
    struct strbuf input;
    /* Bytes of input already searched for a newline, so a long line is scanned once. */
    size_t scanned;
    struct strbuf output;
    bool writing, ready, closed;
    /* The director's scene replaces the fallback only after its first commit. */
    bool committed;
    struct vec pending; /* struct coalesced, in first-arrival order */
    struct wl_event_source *flush_idle, *flush_timer;
    bool flush_armed;
    double flushed_at;
    /* A closed director is freed once the loop is idle, as callers may still hold it. */
    struct wl_event_source *free_idle;
};

struct link {
    struct server *server;
    char *path;
    int fd;
    struct wl_event_source *source;
    struct director *director;
};

static void flush_director(struct director *director);
static void close_director(struct director *director);

const char *link_path(struct link *link) {
    return link->path;
}

/* True once a director completed its handshake. */
static bool link_ready(struct link *link) {
    return link && link->director && link->director->ready;
}

bool link_connected(struct server *server) {
    return link_ready(server->link);
}

bool link_scene_active(struct link *link) {
    return link && link->director && link->director->committed;
}

static void queue(struct director *director, const char *text, size_t length) {
    if (director->closed) return;
    strbuf_append(&director->output, text, length);
    strbuf_putc(&director->output, '\n');
}

static void watch_writable(struct director *director, bool writing) {
    if (writing == director->writing) return;
    director->writing = writing;
    wl_event_source_fd_update(director->source,
                              WL_EVENT_READABLE | (writing ? WL_EVENT_WRITABLE : 0));
}

static void flush_director(struct director *director) {
    while (director->output.length && !director->closed) {
        ssize_t sent = send(director->fd, director->output.data, director->output.length,
                            MSG_NOSIGNAL | MSG_DONTWAIT);
        if (sent < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            if (errno == EINTR) continue;
            close_director(director);
            return;
        }
        strbuf_consume(&director->output, (size_t)sent);
    }
    if (director->closed) return;
    if (director->output.length > MAX_PENDING_OUTPUT) {
        wlr_log(WLR_ERROR, "closing director: it stopped reading events");
        close_director(director);
        return;
    }
    watch_writable(director, director->output.length > 0);
}

static void flush_coalesced(struct director *director) {
    if (!director->pending.length) return;
    VEC_FOR(&director->pending, struct coalesced, entry) {
        queue(director, entry->message.data, entry->message.length);
        strbuf_finish(&entry->message);
    }
    vec_clear(&director->pending);
    director->flushed_at = now_seconds();
    flush_director(director);
}

static int flush_due(void *data) {
    struct director *director = data;
    director->flush_armed = false;
    if (!director->closed) flush_coalesced(director);
    return 0;
}

static void flush_idle(void *data) {
    struct director *director = data;
    director->flush_idle = NULL;
    flush_due(data);
}

static void schedule_coalesced(struct director *director) {
    if (director->flush_armed) return;
    director->flush_armed = true;
    double wait = director->flushed_at + COALESCE_INTERVAL - now_seconds();
    struct wl_event_loop *loop = director->link->server->loop;
    if (wait > 0) {
        if (!director->flush_timer)
            director->flush_timer = wl_event_loop_add_timer(loop, flush_due, director);
        wl_event_source_timer_update(director->flush_timer, MAX(1, (int)(wait * 1000 + 0.999)));
    } else {
        director->flush_idle = wl_event_loop_add_idle(loop, flush_idle, director);
    }
}

/* Queue an encoded message (without its newline) for the director, as message_send. */
static void link_send_message(struct link *link, const char *text, size_t length,
                              const char *coalesce) {
    struct director *director = link ? link->director : NULL;
    if (!director || !director->ready || director->closed) return;
    if (!coalesce) {
        flush_coalesced(director);
        queue(director, text, length);
        flush_director(director);
        return;
    }
    VEC_FOR(&director->pending, struct coalesced, entry) {
        if (!strcmp(entry->key, coalesce)) {
            strbuf_clear(&entry->message);
            strbuf_append(&entry->message, text, length);
            return;
        }
    }
    struct coalesced *entry = vec_push(&director->pending);
    snprintf(entry->key, sizeof entry->key, "%s", coalesce);
    strbuf_init(&entry->message);
    strbuf_append(&entry->message, text, length);
    schedule_coalesced(director);
}

/* Close MESSAGE and queue it for DIRECTOR alone. */
static void queue_message(struct director *director, struct message *message) {
    json_object_end(&message->writer);
    queue(director, message->text.data, message->text.length);
    strbuf_finish(&message->text);
}

static void send_error(struct director *director, const char *text, bool fatal) {
    struct message message;
    message_begin(&message, "error");
    json_key(&message.writer, "message");
    json_string(&message.writer, text);
    if (fatal) {
        json_key(&message.writer, "fatal");
        json_bool(&message.writer, true);
    }
    queue_message(director, &message);
}

static void reject_director(struct director *director, const char *message) {
    wlr_log(WLR_INFO, "closing director: %s", message);
    send_error(director, message, true);
    flush_director(director);
    close_director(director);
}

static void free_director(void *data) {
    free(data);
}

/* Close DIRECTOR now; the struct stays readable, marked closed, until the loop is idle. */
static void close_director(struct director *director) {
    if (director->closed) return;
    struct link *link = director->link;
    bool was_active = director->committed;
    director->closed = true;
    if (director->source) wl_event_source_remove(director->source);
    if (director->flush_timer) wl_event_source_remove(director->flush_timer);
    if (director->flush_idle) wl_event_source_remove(director->flush_idle);
    close(director->fd);
    VEC_FOR(&director->pending, struct coalesced, entry) strbuf_finish(&entry->message);
    vec_finish(&director->pending);
    strbuf_finish(&director->input);
    strbuf_finish(&director->output);
    director->free_idle = wl_event_loop_add_idle(link->server->loop, free_director, director);
    if (link->director == director) {
        link->director = NULL;
        director_detached(link->server, was_active);
    }
}

/* The welcome snapshot: everything the director's store mirrors. */
static void send_welcome(struct director *director) {
    struct server *server = director->link->server;
    struct message message;
    message_begin(&message, "welcome");
    struct json_writer *w = &message.writer;
    json_key(w, "protocol");
    json_int(w, PROTOCOL_VERSION);
    json_key(w, "instance");
    json_string(w, server->instance);
    json_key(w, "display");
    json_string(w, server->socket);
    json_key(w, "outputs");
    json_array_begin(w);
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) output_describe(output, w);
    json_array_end(w);
    json_key(w, "shares");
    shares_describe(server, w);
    json_key(w, "windows");
    json_array_begin(w);
    windows_describe(server, w);
    json_array_end(w);
    json_key(w, "cameras");
    json_array_begin(w);
    wl_list_for_each(output, &server->outputs, link) camera_describe(output, w);
    json_array_end(w);
    json_key(w, "focus");
    json_array_begin(w);
    json_object_begin(w);
    json_key(w, "seat");
    json_string(w, "seat0");
    json_key(w, "window");
    if (server->seat_state.focused) json_int(w, (int64_t)server->seat_state.focused->id);
    else json_null(w);
    json_object_end(w);
    json_array_end(w);
    json_key(w, "modifiers");
    json_array_begin(w);
    json_object_begin(w);
    json_key(w, "seat");
    json_string(w, "seat0");
    json_key(w, "modifiers");
    modifiers_write(server->seat_state.modifiers, w);
    json_object_end(w);
    json_array_end(w);
    queue_message(director, &message);
}

/* Rejected ops change nothing; the rest still apply, keeping a live session usable. */
static bool apply_op(struct server *server, const struct json_value *op, double time,
                     struct protocol_error *error) {
    if (op->type != JSON_OBJECT) return protocol_fail(error, "Each op must be an object.");
    const struct json_value *name = json_get(op, "op");
    int64_t id = 0, parent = 0, before = 0;
    const struct json_value *raw_before = json_given(op, "before");
    if (json_is_string(name, "reset")) {
        scene_clear(&server->scene);
        return true;
    }
    if (json_is_string(name, "shader")) {
        struct shader *shader;
        if (!shaders_define(&server->shaders, op, &shader, error)) return false;
        display_prepare_shader(server, shader);
        return true;
    }
    if (!json_integer(json_get(op, "id"), INT64_MIN / 2, INT64_MAX / 2, &id))
        return protocol_fail(error, "Node ids must be integers.");
    if (json_is_string(name, "create")) {
        const struct json_value *props = json_given(op, "props");
        struct json_value empty = {.type = JSON_OBJECT};
        return scene_create_node(&server->scene, id, json_get(op, "type"), props ? props : &empty,
                                 time, error);
    }
    if (json_is_string(name, "set"))
        return scene_update(&server->scene, id, json_get(op, "props"), time, error);
    if (!json_integer(json_get(op, "parent"), 0, INT64_MAX / 2, &parent))
        return protocol_fail(error, "parent must be a node id.");
    if (json_is_string(name, "insert")) {
        if (raw_before && !json_integer(raw_before, 1, INT64_MAX / 2, &before))
            return protocol_fail(error, "before must be a node id.");
        return scene_insert(&server->scene, parent, id, before, error);
    }
    if (json_is_string(name, "remove")) return scene_remove(&server->scene, parent, id, error);
    return protocol_fail(error, "Unknown op.");
}

static bool apply_commit(struct director *director, const struct json_value *message,
                         struct protocol_error *error) {
    struct server *server = director->link->server;
    const struct json_value *ops = json_get(message, "ops");
    if (!ops || ops->type != JSON_ARRAY)
        return protocol_fail(error, "commit requires an ops array.");
    /* From its first commit the director's scene replaces the fallback layout. */
    director->committed = true;
    double time = now_seconds();
    int rejected = 0;
    struct protocol_error first = {0};
    for (size_t i = 0; i < ops->array.count; i++) {
        struct protocol_error op_error = {0};
        if (!apply_op(server, &ops->array.items[i], time, &op_error) && rejected++ == 0)
            first = op_error;
    }
    scene_finish_commit(&server->scene, time);
    stage_reindex(server);
    if (rejected)
        return protocol_fail(error, "%d op%s rejected; first: %s", rejected,
                             rejected == 1 ? "" : "s", first.message);
    return true;
}

static bool window_field(struct server *server, const struct json_value *message,
                         struct window **out, bool nullable, struct protocol_error *error) {
    const struct json_value *raw = json_get(message, "window");
    int64_t id;
    if (nullable && (!raw || raw->type == JSON_NULL)) {
        *out = NULL;
        return true;
    }
    if (!json_integer(raw, 0, INT64_MAX / 2, &id) || !(*out = window_by_id(server, (uint64_t)id)))
        return protocol_fail(error, "Unknown window.");
    return true;
}

static bool message_source(struct server *server, const struct json_value *message,
                           struct capture_source *source, struct protocol_error *error) {
    *source = (struct capture_source){0};
    if (json_given(message, "window"))
        return window_field(server, message, &source->window, false, error);
    const struct json_value *name = json_given(message, "output");
    if (name) {
        if (name->type != JSON_STRING ||
            !(source->output = output_by_name(server, name->string.chars)))
            return protocol_fail(error, "Unknown output.");
    } else if (!(source->output = output_first(server))) {
        return protocol_fail(error, "Unknown output.");
    }
    const struct json_value *region = json_given(message, "region");
    if (region) {
        if (region->type != JSON_OBJECT) return protocol_fail(error, "region must be an object.");
        source->has_region = true;
        const char *names[] = {"x", "y", "width", "height"};
        double *fields[] = {&source->region.x, &source->region.y, &source->region.width,
                            &source->region.height};
        for (int i = 0; i < 4; i++) {
            const struct json_value *value = json_get(region, names[i]);
            if (!value || value->type != JSON_NUMBER || !(fabs(value->number) < 1e12))
                return protocol_fail(error, "region requires numbers.");
            *fields[i] = value->number;
        }
    }
    return true;
}

static bool move_cameras(struct server *server, const struct json_value *message,
                         struct protocol_error *error) {
    struct camera_move move = {0};
    const char *names[] = {"x", "y", "zoom", "rotation"};
    enum prop_key keys[] = {PROP_X, PROP_Y, PROP_ZOOM, PROP_ROTATION};
    for (int i = 0; i < 4; i++) {
        const struct json_value *raw = json_given(message, names[i]);
        if (!raw) continue;
        struct prop_value value;
        if (!prop_decode(keys[i], raw, &value, error)) return false;
        move.has[i] = true;
        move.values[i] = value.number;
    }
    const struct json_value *transition = json_given(message, "transition");
    if (transition && !(move.motion = decode_motion(transition, error))) return false;
    const struct json_value *target = json_given(message, "output");
    bool any = false;
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        if (target &&
            (target->type != JSON_STRING || strcmp(output_name(output), target->string.chars)))
            continue;
        camera_move(output, &move, now_seconds());
        any = true;
    }
    motion_unref(move.motion);
    if (!any) return protocol_fail(error, "Unknown output.");
    cameras_report(server);
    scene_changed(server);
    return true;
}

static bool measure_texts(struct director *director, const struct json_value *message,
                          struct protocol_error *error) {
    const struct json_value *requests = json_get(message, "requests");
    if (!requests || requests->type != JSON_ARRAY)
        return protocol_fail(error, "requests requires an array.");
    if (requests->array.count > 1000)
        return protocol_fail(error, "At most 1000 texts per measure request.");
    struct message reply;
    message_begin(&reply, "measured");
    struct json_writer *w = &reply.writer;
    json_key(w, "results");
    json_array_begin(w);
    bool ok = true;
    for (size_t i = 0; i < requests->array.count; i++) {
        const struct json_value *request = &requests->array.items[i];
        if (request->type != JSON_OBJECT) {
            ok = protocol_fail(error, "Measure requests must be objects.");
            break;
        }
        const struct json_value *props = json_given(request, "props");
        if (props && props->type != JSON_OBJECT) {
            ok = protocol_fail(error, "props must be an object.");
            break;
        }
        double width = 0, height = 0;
        ok = content_measure_text(director->link->server, props, &width, &height, error);
        if (!ok) break;
        json_object_begin(w);
        json_key(w, "key");
        const struct json_value *key = json_get(request, "key");
        if (key && key->type == JSON_NUMBER) json_number(w, key->number);
        else if (key && key->type == JSON_STRING)
            json_string_n(w, key->string.chars, key->string.length);
        else json_null(w);
        json_key(w, "width");
        json_number(w, width);
        json_key(w, "height");
        json_number(w, height);
        json_object_end(w);
    }
    json_array_end(w);
    if (ok) {
        queue_message(director, &reply);
        flush_director(director);
    } else {
        strbuf_finish(&reply.text);
    }
    return ok;
}

static bool message_id(const struct json_value *message, const char *type, int64_t *id,
                       struct protocol_error *error) {
    if (json_integer(json_get(message, "id"), 0, INT64_MAX / 2, id)) return true;
    return protocol_fail(error, "%s requires a numeric id.", type);
}

static bool dispatch(struct director *director, const struct json_value *message,
                     struct protocol_error *error) {
    struct server *server = director->link->server;
    const struct json_value *type = json_get(message, "type");
    if (json_is_string(type, "commit")) return apply_commit(director, message, error);
    if (json_is_string(type, "focus")) {
        struct window *window;
        if (!window_field(server, message, &window, true, error)) return false;
        focus_window(server, window);
        return true;
    }
    if (json_is_string(type, "close")) {
        struct window *window;
        if (!window_field(server, message, &window, false, error)) return false;
        window_close(window);
        return true;
    }
    if (json_is_string(type, "camera")) return move_cameras(server, message, error);
    if (json_is_string(type, "measure")) return measure_texts(director, message, error);
    if (json_is_string(type, "set-clipboard")) {
        const struct json_value *text = json_get(message, "text");
        if (text && text->type == JSON_STRING) {
            clipboard_set_text(server, text->string.chars, text->string.length);
            return true;
        }
        const struct json_value *mime = json_get(message, "mime"),
                                *path = json_get(message, "path");
        if (!mime || mime->type != JSON_STRING || !path || path->type != JSON_STRING)
            return protocol_fail(error, "set-clipboard requires text, or a mime type and a file.");
        return clipboard_set_file(server, mime->string.chars, path->string.chars, error);
    }
    if (json_is_string(type, "grab-keyboard") || json_is_string(type, "watch-input")) {
        bool grab = json_is_string(type, "grab-keyboard");
        const struct json_value *value = json_get(message, grab ? "grab" : "watch");
        if (!value || (value->type != JSON_TRUE && value->type != JSON_FALSE))
            return protocol_fail(error, "%s requires a boolean.",
                                 grab ? "grab-keyboard" : "watch-input");
        if (grab) input_grab_keyboard(server, value->type == JSON_TRUE);
        else server->seat_state.input_watched = value->type == JSON_TRUE;
        return true;
    }
    if (json_is_string(type, "warp-pointer")) {
        const struct json_value *name = json_get(message, "output");
        struct output *output =
            name && name->type == JSON_STRING ? output_by_name(server, name->string.chars) : NULL;
        if (!output) return protocol_fail(error, "Unknown output.");
        double position[2];
        const char *names[] = {"x", "y"};
        for (int i = 0; i < 2; i++) {
            const struct json_value *value = json_get(message, names[i]);
            if (!value || value->type != JSON_NUMBER || !(fabs(value->number) < 1e12))
                return protocol_fail(error, "warp-pointer requires numbers x and y.");
            position[i] = value->number;
        }
        input_warp_pointer(server, output, position[0], position[1]);
        return true;
    }
    if (json_is_string(type, "capture")) {
        int64_t id;
        struct capture_source source;
        if (!message_id(message, "capture", &id, error)) return false;
        if (!message_source(server, message, &source, error)) return false;
        capture_for_director(server, id, &source);
        return true;
    }
    if (json_is_string(type, "share-accept")) {
        int64_t id;
        struct capture_source source;
        if (!message_id(message, "share-accept", &id, error)) return false;
        if (!message_source(server, message, &source, error)) return false;
        return share_accept(server, (uint32_t)id, &source, error);
    }
    if (json_is_string(type, "share-cancel")) {
        int64_t id;
        if (!message_id(message, "share-cancel", &id, error)) return false;
        share_cancel(server, (uint32_t)id);
        return true;
    }
    return protocol_fail(error, "Unknown message type.");
}

static void handle_line(struct director *director, const char *text, size_t length) {
    char error_text[256];
    struct json_document document;
    if (!json_parse(text, length, &document, error_text, sizeof error_text)) {
        char message[300];
        snprintf(message, sizeof message, "Invalid JSON: %s", error_text);
        /* Newline framing survives a bad line, so a ready director is only told. */
        if (director->ready) send_error(director, message, false);
        else reject_director(director, message);
        return;
    }
    const struct json_value *message = document.root;
    if (message->type != JSON_OBJECT) {
        reject_director(director, "Messages must be JSON objects.");
    } else if (director->ready) {
        struct protocol_error error = {0};
        if (!dispatch(director, message, &error)) send_error(director, error.message, false);
    } else {
        int64_t protocol;
        if (json_is_string(json_get(message, "type"), "hello") &&
            json_integer(json_get(message, "protocol"), 0, 1000, &protocol) &&
            protocol == PROTOCOL_VERSION) {
            const struct json_value *client = json_given(message, "client");
            wlr_log(WLR_INFO, "director %s connected",
                    client && client->type == JSON_STRING ? client->string.chars : "(unnamed)");
            director->ready = true;
            send_welcome(director);
            flush_director(director);
        } else {
            char text_message[64];
            snprintf(text_message, sizeof text_message, "Expected hello for protocol %d.",
                     PROTOCOL_VERSION);
            reject_director(director, text_message);
        }
    }
    json_document_finish(&document);
}

static void consume_lines(struct director *director) {
    size_t start = 0;
    while (!director->closed) {
        size_t from = MAX(start, director->scanned);
        char *newline = memchr(director->input.data + from, '\n', director->input.length - from);
        if (!newline) break;
        size_t end = (size_t)(newline - director->input.data);
        size_t line_start = start;
        start = end + 1;
        if (end > line_start)
            handle_line(director, director->input.data + line_start, end - line_start);
    }
    if (director->closed) return;
    strbuf_consume(&director->input, start);
    director->scanned = director->input.length;
    if (director->input.length > MAX_MESSAGE_BYTES)
        reject_director(director, "Message exceeds the size limit.");
}

static void read_director(struct director *director) {
    char buffer[65536];
    while (!director->closed) {
        ssize_t count = recv(director->fd, buffer, sizeof buffer, MSG_DONTWAIT);
        if (count < 0) {
            if (errno == EINTR) continue;
            if (errno != EAGAIN && errno != EWOULDBLOCK) close_director(director);
            return;
        }
        if (count == 0) {
            close_director(director);
            return;
        }
        strbuf_append(&director->input, buffer, (size_t)count);
        consume_lines(director);
    }
}

static int director_io(int fd, uint32_t mask, void *data) {
    struct director *director = data;
    if (mask & WL_EVENT_WRITABLE) flush_director(director);
    if (!director->closed && (mask & (WL_EVENT_READABLE | WL_EVENT_HANGUP | WL_EVENT_ERROR)))
        read_director(director);
    return 0;
}

static int accept_director(int fd, uint32_t mask, void *data) {
    struct link *link = data;
    int socket = accept4(link->fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (socket < 0) {
        wlr_log_errno(WLR_ERROR, "accept failed");
        return 0;
    }
    /* The fatal error stops the old director instead of letting it reconnect. */
    if (link->director) reject_director(link->director, "Replaced by a newer director.");
    struct director *director = xcalloc(1, sizeof *director);
    director->link = link;
    director->fd = socket;
    vec_init(&director->pending, sizeof(struct coalesced));
    director->source =
        wl_event_loop_add_fd(link->server->loop, socket, WL_EVENT_READABLE, director_io, director);
    link->director = director;
    return 0;
}

struct link *link_create(struct server *server, const char *path) {
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (strlen(path) >= sizeof address.sun_path) {
        wlr_log(WLR_ERROR, "director socket path is too long: %s", path);
        return NULL;
    }
    strcpy(address.sun_path, path);
    struct stat st;
    if (stat(path, &st) == 0) {
        /* A file nothing accepts on is stale; one that answers belongs to a live compositor. */
        int probe = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        bool alive = connect(probe, (struct sockaddr *)&address, sizeof address) == 0;
        close(probe);
        if (alive) {
            wlr_log(WLR_ERROR, "Another compositor is listening on %s", path);
            return NULL;
        }
        unlink(path);
    }
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0 || bind(fd, (struct sockaddr *)&address, sizeof address) < 0 ||
        chmod(path, 0600) < 0 || listen(fd, 4) < 0) {
        wlr_log_errno(WLR_ERROR, "cannot listen on %s", path);
        if (fd >= 0) close(fd);
        unlink(path);
        return NULL;
    }
    struct link *link = xcalloc(1, sizeof *link);
    link->server = server;
    link->path = xstrdup(path);
    link->fd = fd;
    link->source = wl_event_loop_add_fd(server->loop, fd, WL_EVENT_READABLE, accept_director, link);
    return link;
}

void link_destroy(struct link *link) {
    if (!link) return;
    struct director *director = link->director;
    if (director) {
        close_director(director);
        wl_event_source_remove(director->free_idle);
        free(director);
    }
    wl_event_source_remove(link->source);
    close(link->fd);
    unlink(link->path);
    free(link->path);
    free(link);
}

/* Start an object of TYPE in TEXT, written through WRITER. */
static void begin_object(struct strbuf *text, struct json_writer *writer, const char *type) {
    strbuf_init(text);
    json_writer_init(writer, text);
    json_object_begin(writer);
    json_key(writer, "type");
    json_string(writer, type);
}

void message_begin(struct message *message, const char *type) {
    begin_object(&message->text, &message->writer, type);
}

void message_send(struct server *server, struct message *message, const char *coalesce) {
    json_object_end(&message->writer);
    link_send_message(server->link, message->text.data, message->text.length, coalesce);
    strbuf_finish(&message->text);
}

bool event_begin(struct server *server, struct event *event, struct node *node,
                 enum event_name name) {
    if (!link_ready(server->link) || !node || !node_receives(node, name)) return false;
    begin_object(&event->message, &event->writer, "event");
    json_key(&event->writer, "node");
    json_int(&event->writer, node->id);
    json_key(&event->writer, "name");
    json_string(&event->writer, EVENT_NAMES[name]);
    event->coalesce = name == EVENT_POINTERMOVE || name == EVENT_MOVE || name == EVENT_DRAG ||
                      name == EVENT_RESIZE;
    snprintf(event->key, sizeof event->key, "%lld/%s", (long long)node->id, EVENT_NAMES[name]);
    return true;
}

void event_end(struct server *server, struct event *event) {
    json_object_end(&event->writer);
    link_send_message(server->link, event->message.data, event->message.length,
                      event->coalesce ? event->key : NULL);
    strbuf_finish(&event->message);
}
