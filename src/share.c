/*
 * Screen sharing through the desktop portal.
 *
 * screencast.c owns the portal's ScreenCast backend and one PipeWire stream per
 * session. What to share is the director's choice: requests reach it in
 * `shares` reports and return as `share-accept` or `share-cancel`. A window is
 * captured from its own surfaces, a screen or region from the display list,
 * both offscreen so sharing never forces an output frame. A source is captured
 * only after it changed, at most 30 times a second, and only while a consumer
 * reads its stream; a still one is resent four times a second to keep the
 * stream alive. With no share streaming, nothing wakes.
 */
#include <math.h>
#include <stdio.h>
#include <wlr/types/wlr_output.h>
#include <wlr/util/log.h>

#include "display.h"
#include "link.h"
#include "screencast.h"
#include "stage.h"

/* Shortest time between captures of one source, and longest a still one goes without a frame. */
#define SHARE_INTERVAL 0.033
#define SHARE_KEEPALIVE 0.25
#define SHARE_WIDTH 1920
#define SHARE_HEIGHT 1080

struct share {
    struct wl_list link;
    uint32_t id;
    /* SCREENCAST_MONITOR and SCREENCAST_WINDOW bits the client accepts. */
    uint32_t types;
    char app[256];
    /* Accepted: what it shows. */
    bool running, streaming;
    struct capture_source source;
    int width, height;
    /* Where the next capture goes; pushed frames trade it for a spare. */
    uint8_t *pixels;
    bool dirty;
    double submitted_at;
    struct display_targets targets;
};

struct shares {
    struct server *server;
    struct screencast *cast;
    struct wl_event_source *readable, *timer;
    struct wl_list list; /* struct share */
};

static void report(struct server *server) {
    struct message message;
    message_begin(&message, "shares");
    json_key(&message.writer, "shares");
    shares_describe(server, &message.writer);
    message_send(server, &message, NULL);
}

void shares_describe(struct server *server, struct json_writer *w) {
    json_array_begin(w);
    struct shares *shares = server->share;
    struct share *share;
    if (shares)
        wl_list_for_each(share, &shares->list, link) {
            json_object_begin(w);
            json_key(w, "id");
            json_int(w, share->id);
            json_key(w, "app");
            json_string(w, share->app);
            json_key(w, "types");
            json_array_begin(w);
            if (share->types & SCREENCAST_MONITOR) json_string(w, "screen");
            if (share->types & SCREENCAST_WINDOW) json_string(w, "window");
            json_array_end(w);
            json_key(w, "source");
            if (share->running) json_string(w, share->source.window ? "window" : "screen");
            else json_null(w);
            json_key(w, "window");
            if (share->running && share->source.window)
                json_int(w, (int64_t)share->source.window->id);
            else json_null(w);
            json_key(w, "output");
            if (share->running && share->source.output)
                json_string(w, output_name(share->source.output));
            else json_null(w);
            json_object_end(w);
        }
    json_array_end(w);
}

static double due_at(const struct share *share) {
    return share->submitted_at + (share->dirty ? SHARE_INTERVAL : SHARE_KEEPALIVE);
}

/* Wake when the next streaming share is due; with none, never. */
static void schedule(struct shares *shares) {
    double next = INFINITY;
    struct share *share;
    wl_list_for_each(share, &shares->list, link) {
        if (share->running && share->streaming) next = fmin(next, due_at(share));
    }
    int delay = isinf(next) ? 0 : MAX(1, (int)ceil(1000 * (next - now_seconds())));
    wl_event_source_timer_update(shares->timer, delay);
}

static void forget(struct shares *shares, struct share *share) {
    if (share->targets.full || share->targets.scaled) {
        if (server_gl_current(shares->server)) display_release_targets(&share->targets);
    }
    if (share->source.window) window_unref(share->source.window);
    free(share->pixels);
    wl_list_remove(&share->link);
    free(share);
}

static void close_share(struct shares *shares, struct share *share) {
    screencast_close(shares->cast, share->id);
    forget(shares, share);
    schedule(shares);
    report(shares->server);
}

static struct share *find(struct shares *shares, uint32_t id) {
    struct share *share;
    wl_list_for_each(share, &shares->list, link) {
        if (share->id == id) return share;
    }
    return NULL;
}

static int handle_events(int fd, uint32_t mask, void *data) {
    struct shares *shares = data;
    struct screencast_event event;
    bool changed = false;
    while (screencast_next_event(shares->cast, &event)) {
        struct share *share = find(shares, event.id);
        switch (event.type) {
        case SCREENCAST_EVENT_REQUEST:
            if (share) break;
            share = xcalloc(1, sizeof *share);
            share->id = event.id;
            share->types = event.sources;
            snprintf(share->app, sizeof share->app, "%s", event.app);
            wl_list_insert(shares->list.prev, &share->link);
            changed = true;
            break;
        case SCREENCAST_EVENT_CLOSED:
            /* The client or the portal ended the session. */
            if (share) {
                forget(shares, share);
                changed = true;
            }
            break;
        case SCREENCAST_EVENT_STREAMING:
            if (share) {
                share->streaming = true;
                share->dirty = true;
                share->submitted_at = 0;
            }
            break;
        case SCREENCAST_EVENT_PAUSED:
            if (share) share->streaming = false;
            break;
        }
    }
    schedule(shares);
    if (changed) report(shares->server);
    return 0;
}

bool share_accept(struct server *server, uint32_t id, const struct capture_source *source,
                  struct protocol_error *error) {
    struct shares *shares = server->share;
    if (!shares) return protocol_fail(error, "Screen sharing is not enabled.");
    struct share *share = find(shares, id);
    if (!share) return protocol_fail(error, "Unknown share %u.", id);
    if (share->running) return protocol_fail(error, "Share %u is already running.", id);
    uint32_t type = source->window ? SCREENCAST_WINDOW : SCREENCAST_MONITOR;
    if (!(share->types & type))
        return protocol_fail(error, "The client did not ask to share a %s.",
                             source->window ? "window" : "screen");
    int x, y, source_width, source_height;
    if (!capture_source_size(source, &x, &y, &source_width, &source_height, error)) return false;
    fit_size(source_width, source_height, SHARE_WIDTH, SHARE_HEIGHT, &share->width, &share->height);
    share->running = true;
    share->source = *source;
    if (source->window) window_ref(source->window);
    share->pixels = xmalloc((size_t)share->width * share->height * 4);
    share->dirty = true;
    screencast_accept(shares->cast, id, type, x, y, (uint32_t)share->width,
                      (uint32_t)share->height);
    schedule(shares);
    report(server);
    return true;
}

void share_cancel(struct server *server, uint32_t id) {
    struct shares *shares = server->share;
    struct share *share = shares ? find(shares, id) : NULL;
    if (share) close_share(shares, share);
}

/* Change tracking. */

static void mark_changed(struct shares *shares, bool (*changed)(struct share *share, void *data),
                         void *data) {
    bool any = false;
    struct share *share;
    wl_list_for_each(share, &shares->list, link) {
        if (share->running && !share->dirty && changed(share, data)) {
            share->dirty = true;
            any = share->streaming || any;
        }
    }
    if (any) schedule(shares);
}

struct presented {
    struct output *output;
    const pixman_region32_t *damage;
};

static bool output_changed(struct share *share, void *data) {
    struct presented *presented = data;
    if (share->source.output != presented->output || share->source.window) return false;
    if (!share->source.has_region) return true;
    /* Damage is in buffer pixels; the region in logical ones. */
    struct output *output = presented->output;
    struct box area = mat3_box_bounds(
        output_buffer_transform(output->width, output->height, output->wlr_output->width,
                                output->wlr_output->height, output->wlr_output->transform),
        share->source.region, 1);
    pixman_box32_t box = {(int)floor(area.x), (int)floor(area.y), (int)ceil(box_right(area)),
                          (int)ceil(box_bottom(area))};
    return pixman_region32_contains_rectangle((pixman_region32_t *)presented->damage, &box) !=
           PIXMAN_REGION_OUT;
}

void share_output_presented(struct server *server, struct output *output,
                            const pixman_region32_t *damage) {
    if (!server->share || !pixman_region32_not_empty((pixman_region32_t *)damage)) return;
    struct presented presented = {output, damage};
    mark_changed(server->share, output_changed, &presented);
}

static bool window_changed(struct share *share, void *data) {
    return share->source.window == data;
}

void share_window_changed(struct server *server, struct window *window) {
    if (server->share) mark_changed(server->share, window_changed, window);
}

void share_window_gone(struct server *server, struct window *window) {
    struct shares *shares = server->share;
    if (!shares) return;
    struct share *share, *next;
    wl_list_for_each_safe(share, next, &shares->list, link) {
        if (share->source.window == window) close_share(shares, share);
    }
}

void share_output_removed(struct server *server, struct output *output) {
    struct shares *shares = server->share;
    if (!shares) return;
    struct share *share, *next;
    wl_list_for_each_safe(share, next, &shares->list, link) {
        if (share->running && !share->source.window && share->source.output == output)
            close_share(shares, share);
    }
}

/* Capture. */

/* The window's bounds letterboxed to the stream's aspect, which stays fixed as it resizes. */
static struct box letterboxed(struct window *window, int width, int height) {
    struct wlr_box b = window_bounds(window);
    double ratio = (double)width / height;
    if ((double)b.width / MAX(1, b.height) > ratio) {
        double expanded = b.width / ratio;
        return (struct box){b.x, b.y - (expanded - b.height) / 2, b.width, expanded};
    }
    double expanded = b.height * ratio;
    return (struct box){b.x - (expanded - b.width) / 2, b.y, expanded, b.height};
}

static bool capture(struct server *server, struct share *share) {
    struct box bounds = {0};
    if (share->source.window)
        bounds = letterboxed(share->source.window, share->width, share->height);
    if (!capture_read(server, &share->source, bounds, share->width, share->height, share->pixels,
                      &share->targets))
        return false;
    /* A shared window keeps drawing even where no output shows it. */
    if (share->source.window) {
        struct timespec when;
        clock_gettime(CLOCK_MONOTONIC, &when);
        window_send_frame_done(share->source.window, &when);
    }
    return true;
}

static int tick(void *data) {
    struct shares *shares = data;
    struct server *server = shares->server;
    double time = now_seconds();
    bool current = server_gl_current(server);
    struct share *share, *next;
    wl_list_for_each_safe(share, next, &shares->list, link) {
        if (!share->running || !share->streaming || due_at(share) > time) continue;
        if (share->dirty && !(current && capture(server, share))) {
            wlr_log(WLR_ERROR, "screen sharing stopped: share %u could not be captured", share->id);
            close_share(shares, share);
            continue;
        }
        if (share->dirty)
            screencast_push_frame(shares->cast, share->id, &share->pixels, (uint32_t)share->width,
                                  (uint32_t)share->height);
        else screencast_repeat_frame(shares->cast, share->id);
        share->dirty = false;
        share->submitted_at = time;
    }
    schedule(shares);
    return 0;
}

void share_init(struct server *server) {
    struct screencast *cast = screencast_create();
    if (!cast) {
        wlr_log(WLR_ERROR, "screen sharing is unavailable");
        return;
    }
    struct shares *shares = xcalloc(1, sizeof *shares);
    shares->server = server;
    shares->cast = cast;
    wl_list_init(&shares->list);
    shares->readable = wl_event_loop_add_fd(server->loop, screencast_get_fd(cast),
                                            WL_EVENT_READABLE, handle_events, shares);
    shares->timer = wl_event_loop_add_timer(server->loop, tick, shares);
    server->share = shares;
}

void share_finish(struct server *server) {
    struct shares *shares = server->share;
    if (!shares) return;
    struct share *share, *next;
    wl_list_for_each_safe(share, next, &shares->list, link) forget(shares, share);
    wl_event_source_remove(shares->readable);
    wl_event_source_remove(shares->timer);
    screencast_destroy(shares->cast);
    free(shares);
    server->share = NULL;
}
