/*
 * Windows: client toplevels as the director sees them.
 *
 * A window has an id that names it in the protocol, metadata the director
 * mirrors, and the director nodes presenting it. The first of those configures
 * it: the client sees target sizes and states, never animation frames. A window
 * whose removal plays an exit animation keeps its last frame, so the animation
 * can show it after the client unmapped or left.
 */
#define _GNU_SOURCE
#include <math.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_fractional_scale_v1.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/edges.h>
#include <wlr/xwayland.h>

#include "display.h"
#include "input.h"
#include "link.h"
#include "server.h"
#include "stage.h"

struct window *window_create(struct server *server, enum window_type type) {
    struct window *window = xcalloc(1, sizeof *window);
    window->server = server;
    window->references = 1;
    window->type = type;
    window->id = server->next_window_id++;
    window->alive = true;
    vec_init(&window->nodes, sizeof(struct node *));
    vec_init(&window->snapshot, sizeof(struct surface_draw));
    vec_init(&window->fade, sizeof(struct surface_draw));
    strbuf_init(&window->report);
    wl_list_insert(server->windows.prev, &window->link);
    idmap_put(&server->windows_by_id, (int64_t)window->id, window);
    return window;
}

void window_ref(struct window *window) {
    window->references++;
}

void window_release_snapshot(struct window *window) {
    VEC_FOR(&window->snapshot, struct surface_draw, draw) wlr_buffer_unlock(draw->buffer);
    vec_clear(&window->snapshot);
    window->snapshot_commit = 0;
}

static void release_fade(struct window *window) {
    VEC_FOR(&window->fade, struct surface_draw, draw) wlr_buffer_unlock(draw->buffer);
    vec_clear(&window->fade);
    if (window->fade_release) wl_event_source_remove(window->fade_release);
    window->fade_release = NULL;
}

/* An idle source runs once and goes, so it is not removed again. */
static void fade_done(void *data) {
    struct window *window = data;
    window->fade_release = NULL;
    release_fade(window);
}

void window_fade_finished(struct window *window) {
    if (window->fade.length && !window->fade_release)
        window->fade_release = wl_event_loop_add_idle(window->server->loop, fade_done, window);
}

/* The first node presenting WINDOW, which configures it; NULL for none. */
static struct node *first_node(struct window *window) {
    return window->nodes.length ? *(struct node **)vec_at(&window->nodes, 0) : NULL;
}

double window_fade_progress(struct window *window) {
    struct node *node = first_node(window);
    if (!window->fade.length || !node) return 1;
    if (!node_moving(node, PROP_WIDTH) && !node_moving(node, PROP_HEIGHT)) return 1;
    double width, height;
    node_size(window->server, node, &width, &height);
    double target_width = node_target(node, PROP_WIDTH, width);
    double target_height = node_target(node, PROP_HEIGHT, height);
    double span_width = target_width - window->fade_from_width;
    double span_height = target_height - window->fade_from_height;
    /* Along the side that changes most: how much of the way from there it has come. */
    double progress = 1;
    if (fabs(span_width) >= fabs(span_height) && fabs(span_width) > 0.5)
        progress = 1 - (target_width - width) / span_width;
    else if (fabs(span_height) > 0.5) progress = 1 - (target_height - height) / span_height;
    return CLAMP(progress, 0, 1);
}

/* A frame of a new size while the box presenting the window still moves: the kept
 * frame stays, fading out under the new one as the box comes the rest of the way. */
static void begin_fade(struct window *window) {
    struct node *node = first_node(window);
    struct wlr_box bounds = window_bounds(window);
    if (!window->snapshot.length || !node || !window_presentable(window)) return;
    if (bounds.width == window->snapshot_bounds.width &&
        bounds.height == window->snapshot_bounds.height)
        return;
    if (!node_moving(node, PROP_WIDTH) && !node_moving(node, PROP_HEIGHT)) return;
    release_fade(window);
    /* The kept frame's buffers stay locked, now by the fade. */
    VEC_FOR(&window->snapshot, struct surface_draw, draw)
        *(struct surface_draw *)vec_push(&window->fade) = *draw;
    window->fade_bounds = window->snapshot_bounds;
    vec_clear(&window->snapshot);
    window->snapshot_commit = 0;
    node_size(window->server, node, &window->fade_from_width, &window->fade_from_height);
}

static void clear_nodes(struct window *window) {
    VEC_FOR(&window->nodes, struct node *, node) node_unref(*node);
    vec_clear(&window->nodes);
}

void window_unref(struct window *window) {
    if (--window->references > 0) return;
    window_release_snapshot(window);
    release_fade(window);
    clear_nodes(window);
    vec_finish(&window->nodes);
    vec_finish(&window->snapshot);
    vec_finish(&window->fade);
    strbuf_finish(&window->report);
    free(window->title);
    free(window->app_id);
    free(window);
}

struct window *window_by_id(struct server *server, uint64_t id) {
    return idmap_get(&server->windows_by_id, (int64_t)id);
}

struct window *window_for_node(struct server *server, const struct node *node) {
    if (!node->props[PROP_WINDOW].given) return NULL;
    int64_t id = node->props[PROP_WINDOW].id;
    struct window *window = idmap_get(&server->windows_by_id, id);
    return window ? window : idmap_get(&server->departed, id);
}

bool window_presentable(struct window *window) {
    return window->alive && window->mapped && window->surface;
}

struct wlr_box window_bounds(struct window *window) {
    if (!window_presentable(window) && window->snapshot.length) return window->snapshot_bounds;
    if (!window->surface) return (struct wlr_box){0};
    if (window->type == WINDOW_XDG && window->toplevel) {
        struct wlr_box geometry = window->toplevel->base->geometry;
        if (geometry.width > 0 && geometry.height > 0) return geometry;
    }
    return (struct wlr_box){0, 0, window->surface->current.width, window->surface->current.height};
}

bool window_natural_size(struct window *window, double *width, double *height) {
    struct wlr_box bounds = window_bounds(window);
    *width = MAX(bounds.width, 0);
    *height = MAX(bounds.height, 0);
    return true;
}

static void add_surface(struct wlr_surface *surface, int x, int y, void *data) {
    struct vec *out = data;
    if (!surface->mapped && !(surface->current.buffer_width > 0)) return;
    struct wlr_texture *texture = wlr_surface_get_texture(surface);
    if (!texture) return;
    struct surface_draw *draw = vec_push(out);
    draw->surface = surface;
    draw->texture = texture;
    draw->x = x;
    draw->y = y;
    draw->width = surface->current.width;
    draw->height = surface->current.height;
    wlr_surface_get_buffer_source_box(surface, &draw->source);
    draw->transform = surface->current.transform;
    draw->buffer = surface->buffer ? &surface->buffer->base : NULL;
    draw->opaque_whole = surface->buffer && wlr_buffer_is_opaque(&surface->buffer->base);
    pixman_region32_t *opaque = &surface->current.opaque;
    int count;
    pixman_box32_t *boxes = pixman_region32_rectangles(opaque, &count);
    if (count == 1) {
        draw->opaque_box_valid = true;
        draw->opaque_box = (struct wlr_box){boxes[0].x1, boxes[0].y1, boxes[0].x2 - boxes[0].x1,
                                            boxes[0].y2 - boxes[0].y1};
    }
}

void window_surfaces(struct window *window, struct vec *out) {
    vec_clear(out);
    if (!window_presentable(window)) {
        VEC_FOR(&window->snapshot, struct surface_draw, draw)
            *(struct surface_draw *)vec_push(out) = *draw;
        return;
    }
    if (window->type == WINDOW_XDG) {
        wlr_xdg_surface_for_each_surface(window->toplevel->base, add_surface, out);
    } else {
        wlr_surface_for_each_surface(window->surface, add_surface, out);
        xwayland_child_surfaces(window, add_surface, out);
    }
}

struct surface_search {
    struct wlr_surface *surface;
    int x, y;
    bool found;
};

static void find_surface(struct wlr_surface *surface, int x, int y, void *data) {
    struct surface_search *search = data;
    if (search->found || surface != search->surface) return;
    *search = (struct surface_search){surface, x, y, true};
}

bool window_surface_offset(struct window *window, struct wlr_surface *surface, int *x, int *y) {
    struct surface_search search = {.surface = surface};
    if (!window_presentable(window)) {
        VEC_FOR(&window->snapshot, struct surface_draw, draw)
            if (draw->surface == surface) find_surface(surface, draw->x, draw->y, &search);
    } else if (window->type == WINDOW_XDG) {
        wlr_xdg_surface_for_each_surface(window->toplevel->base, find_surface, &search);
    } else {
        wlr_surface_for_each_surface(window->surface, find_surface, &search);
        xwayland_child_surfaces(window, find_surface, &search);
    }
    *x = search.x;
    *y = search.y;
    return search.found;
}

/* What display items take from the surfaces besides their pixels. */
static uint64_t surface_geometry(struct window *window, struct vec *surfaces) {
    struct wlr_box bounds = window_bounds(window);
    uint64_t hash = hash_bytes(HASH_SEED, &bounds, sizeof bounds);
    VEC_FOR(surfaces, struct surface_draw, draw) {
        int values[6] = {draw->x,      draw->y,         draw->width,
                         draw->height, draw->transform, draw->opaque_whole};
        hash = hash_bytes(hash, values, sizeof values);
        hash = hash_bytes(hash, &draw->source, sizeof draw->source);
        hash = hash_bytes(hash, &draw->opaque_box_valid, sizeof draw->opaque_box_valid);
        if (draw->opaque_box_valid)
            hash = hash_bytes(hash, &draw->opaque_box, sizeof draw->opaque_box);
        hash = hash_bytes(hash, &draw->surface, sizeof draw->surface);
    }
    return hash;
}

static bool shows_window(const struct node *node, uint64_t id) {
    if (node->kind == KIND_WINDOW && node->props[PROP_WINDOW].given &&
        (uint64_t)node->props[PROP_WINDOW].id == id)
        return true;
    NODE_FOR_CHILDREN(node, child)
        if (shows_window(child, id)) return true;
    return false;
}

/* Whether WINDOW's last frame may be shown after the client is gone: a node presenting
 * it would play an exit animation when removed, or already plays one. */
static bool window_exits(struct window *window) {
    VEC_FOR(&window->nodes, struct node *, slot) {
        for (struct node *node = *slot; node; node = node->parent) {
            if (node->exit) return true;
        }
    }
    VEC_FOR(&window->server->scene.exiting, struct node *, root) {
        if (shows_window(*root, window->id)) return true;
    }
    return false;
}

/* Keep the frame on screen now, its buffers locked, to show once the client replaces
 * or withdraws it. A held buffer cannot be updated in place, so wlroots would upload
 * each new frame whole: frames are held only on their way out, and let go after. */
static void hold_frame(struct window *window) {
    if (!window_presentable(window)) return;
    if (window->snapshot.length && window->snapshot_commit == window->commit_count) return;
    struct vec surfaces;
    vec_init(&surfaces, sizeof(struct surface_draw));
    window_surfaces(window, &surfaces);
    if (surfaces.length) {
        VEC_FOR(&surfaces, struct surface_draw, draw) {
            if (draw->buffer) wlr_buffer_lock(draw->buffer);
        }
        window_release_snapshot(window);
        VEC_FOR(&surfaces, struct surface_draw, draw) {
            if (!draw->buffer) continue;
            struct surface_draw *kept = vec_push(&window->snapshot);
            *kept = *draw;
            kept->surface = NULL;
        }
        window->snapshot_commit = window->commit_count;
        window->snapshot_bounds = window_bounds(window);
    }
    vec_finish(&surfaces);
}

void window_client_commit(struct window *window, struct wlr_surface *surface) {
    if (!window_presentable(window) || !(surface->pending.committed & WLR_SURFACE_STATE_BUFFER))
        return;
    struct wlr_buffer *next = surface->pending.buffer;
    if (!next) {
        /* Withdrawn: an exit may show the last frame. */
        if (surface == window->surface && window_exits(window)) hold_frame(window);
        return;
    }
    /* A new size while the box still moves: the old frame fades out under it. */
    struct node *node = first_node(window);
    bool resized = next->width != surface->current.buffer_width ||
                   next->height != surface->current.buffer_height;
    if (resized && node && (node_moving(node, PROP_WIDTH) || node_moving(node, PROP_HEIGHT)))
        hold_frame(window);
}

void window_surface_destroying(struct window *window) {
    if (window_exits(window)) hold_frame(window);
}

double window_scale(struct window *window) {
    double scale = 0;
    struct output *output;
    wl_list_for_each(output, &window->server->outputs, link) {
        if (window->outputs & (1u << output->index)) scale = fmax(scale, output->wlr_output->scale);
    }
    return scale;
}

/* Surfaces enter the outputs whose frames show the window; their clients scale for them. */
static void sync_membership(struct window *window, struct vec *surfaces) {
    struct server *server = window->server;
    double scale = window_scale(window);
    struct output *output;
    VEC_FOR(surfaces, struct surface_draw, draw) {
        struct wlr_surface *surface = draw->surface;
        if (!surface) continue;
        /* wlroots tells a surface of each output once. */
        wl_list_for_each(output, &server->outputs, link) {
            if (window->outputs & (1u << output->index))
                wlr_surface_send_enter(surface, output->wlr_output);
            else wlr_surface_send_leave(surface, output->wlr_output);
        }
        if (scale > 0) {
            wlr_fractional_scale_v1_notify_scale(surface, scale);
            wlr_surface_set_preferred_buffer_scale(surface, (int32_t)ceil(scale));
        }
    }
}

struct wlr_surface *window_surface_at(struct window *window, double x, double y, double *sx,
                                      double *sy) {
    if (!window_presentable(window)) return NULL;
    if (window->type == WINDOW_XDG)
        return wlr_xdg_surface_surface_at(window->toplevel->base, x, y, sx, sy);
    return xwayland_surface_at(window, x, y, sx, sy);
}

void window_set_outputs(struct window *window, uint32_t outputs) {
    if (!window->alive || window->outputs == outputs) return;
    window->outputs = outputs;
    struct vec surfaces;
    vec_init(&surfaces, sizeof(struct surface_draw));
    if (window_presentable(window)) window_surfaces(window, &surfaces);
    sync_membership(window, &surfaces);
    vec_finish(&surfaces);
}

void windows_forget_output(struct server *server, struct output *output) {
    struct window *window;
    wl_list_for_each(window, &server->windows, link) {
        if (window->outputs & (1u << output->index))
            window_set_outputs(window, window->outputs & ~(1u << output->index));
    }
}

/* Metadata. */

static void window_describe(struct window *window, struct json_writer *w) {
    double width, height;
    window_natural_size(window, &width, &height);
    struct window *parent = window->parent && window->parent->alive ? window->parent : NULL;
    json_object_begin(w);
    json_key(w, "id");
    json_int(w, (int64_t)window->id);
    json_key(w, "title");
    json_string(w, window->title ? window->title : "");
    json_key(w, "app");
    json_string(w, window->app_id ? window->app_id : "");
    json_key(w, "mapped");
    json_bool(w, window->mapped);
    json_key(w, "width");
    json_int(w, (int64_t)round(width));
    json_key(w, "height");
    json_int(w, (int64_t)round(height));
    json_key(w, "parent");
    if (parent) json_int(w, (int64_t)parent->id);
    else json_null(w);
    json_key(w, "min-width");
    json_int(w, window->min_width);
    json_key(w, "min-height");
    json_int(w, window->min_height);
    json_key(w, "max-width");
    json_int(w, window->max_width);
    json_key(w, "max-height");
    json_int(w, window->max_height);
    json_object_end(w);
}

void windows_describe(struct server *server, struct json_writer *w) {
    struct window *window;
    wl_list_for_each(window, &server->windows, link) {
        if (!window->alive) continue;
        strbuf_clear(&window->report);
        struct json_writer own;
        json_writer_init(&own, &window->report);
        window_describe(window, &own);
        json_raw(w, window->report.data, window->report.length);
    }
}

void window_report(struct window *window) {
    if (!window->alive) return;
    struct strbuf text;
    strbuf_init(&text);
    struct json_writer w;
    json_writer_init(&w, &text);
    window_describe(window, &w);
    if (window->report.length != text.length ||
        memcmp(window->report.data, text.data, text.length)) {
        strbuf_clear(&window->report);
        strbuf_append(&window->report, text.data, text.length);
        struct message message;
        message_begin(&message, "window");
        json_key(&message.writer, "window");
        json_raw(&message.writer, text.data, text.length);
        message_send(window->server, &message, NULL);
    }
    strbuf_finish(&text);
}

/* Configuration. */

static bool initialized(struct window *window) {
    if (window->type == WINDOW_XDG) return window->toplevel && window->toplevel->base->initialized;
    return window->xsurface != NULL;
}

/* A configure dimension clients and the protocol accept. */
static int client_extent(double value) {
    return (int)CLAMP(round(value), 1.0, 32767.0);
}

static void send_size(struct window *window, int width, int height) {
    if (window->type == WINDOW_XDG) {
        wlr_xdg_toplevel_set_size(window->toplevel, width, height);
    } else {
        xwayland_configure(window, width, height);
    }
}

static void send_state(struct window *window, enum window_state state, bool value) {
    if (window->type == WINDOW_XDG) {
        struct wlr_xdg_toplevel *toplevel = window->toplevel;
        switch (state) {
        case WINDOW_FULLSCREEN: wlr_xdg_toplevel_set_fullscreen(toplevel, value); break;
        case WINDOW_MAXIMIZED: wlr_xdg_toplevel_set_maximized(toplevel, value); break;
        case WINDOW_ACTIVATED: wlr_xdg_toplevel_set_activated(toplevel, value); break;
        case WINDOW_RESIZING: wlr_xdg_toplevel_set_resizing(toplevel, value); break;
        }
    } else {
        xwayland_set_state(window, state, value);
    }
}

static void window_set_activated(struct window *window, bool activated) {
    if (!window->alive || !initialized(window)) return;
    if (window->states_known && window->sent_activated == activated) return;
    window->sent_activated = activated;
    send_state(window, WINDOW_ACTIVATED, activated);
}

void window_set_resizing(struct window *window, bool resizing) {
    if (window->alive && initialized(window)) send_state(window, WINDOW_RESIZING, resizing);
}

/* Send the primary node's declared size and states; the client sees targets, not frames. */
void window_configure(struct window *window) {
    struct node *node = first_node(window);
    if (!node || !window->alive || !initialized(window)) return;
    bool has_size = node_has_number(node, PROP_WIDTH) && node_has_number(node, PROP_HEIGHT);
    int width = has_size ? client_extent(node_target(node, PROP_WIDTH, 0)) : 0;
    int height = has_size ? client_extent(node_target(node, PROP_HEIGHT, 0)) : 0;
    uint32_t tiled = node_bool(node, PROP_TILED)
                         ? WLR_EDGE_TOP | WLR_EDGE_BOTTOM | WLR_EDGE_LEFT | WLR_EDGE_RIGHT
                         : WLR_EDGE_NONE;
    if (has_size && !(window->configured && window->configured_width == width &&
                      window->configured_height == height)) {
        window->configured = true;
        window->configured_width = width;
        window->configured_height = height;
        send_size(window, width, height);
    }
    /* Tiled edges need a newer xdg_wm_base; clients bound to version 1 never get them. */
    if (tiled != window->sent_tiled && window->type == WINDOW_XDG &&
        wl_resource_get_version(window->toplevel->resource) >=
            XDG_TOPLEVEL_STATE_TILED_LEFT_SINCE_VERSION) {
        window->sent_tiled = tiled;
        wlr_xdg_toplevel_set_tiled(window->toplevel, tiled);
    }
    bool fullscreen = node_bool(node, PROP_FULLSCREEN), maximized = node_bool(node, PROP_MAXIMIZED);
    if (!window->states_known || fullscreen != window->sent_fullscreen) {
        window->sent_fullscreen = fullscreen;
        send_state(window, WINDOW_FULLSCREEN, fullscreen);
    }
    if (!window->states_known || maximized != window->sent_maximized) {
        window->sent_maximized = maximized;
        send_state(window, WINDOW_MAXIMIZED, maximized);
    }
    window->states_known = true;
}

void window_close(struct window *window) {
    if (!window->alive) return;
    if (window->type == WINDOW_XDG) wlr_xdg_toplevel_send_close(window->toplevel);
    else wlr_xwayland_surface_close(window->xsurface);
}

/* Client events. */

void window_committed(struct window *window, struct wlr_surface *committed) {
    struct server *server = window->server;
    window->commit_count++;
    struct vec surfaces;
    vec_init(&surfaces, sizeof(struct surface_draw));
    window_surfaces(window, &surfaces);
    uint64_t geometry = surface_geometry(window, &surfaces);
    /* What moved or changed size is damaged by the display's diff; the window's size
     * is what its description can change on a commit. */
    if (geometry != window->geometry) {
        window->geometry = geometry;
        invalidate_displays(server);
        window_report(window);
    }
    /* The committed surface's damage, in the window's content coordinates, reaches every
     * output showing it; the other surfaces' damage is from their own last commits. */
    VEC_FOR(&surfaces, struct surface_draw, draw) {
        if (!committed || draw->surface != committed) continue;
        pixman_region32_t damage;
        pixman_region32_init(&damage);
        wlr_surface_get_effective_damage(committed, &damage);
        pixman_region32_translate(&damage, draw->x, draw->y);
        if (pixman_region32_not_empty(&damage)) {
            displays_damage_client(server, window, &damage);
            share_window_changed(server, window);
        } else if (window->outputs && !wl_list_empty(&committed->current.frame_callback_list)) {
            /* A commit asking only for a frame callback gets it with the next frame. */
            struct output *output;
            wl_list_for_each(output, &server->outputs, link) {
                if (window->outputs & (1u << output->index)) output_request_frame(output);
            }
        }
        pixman_region32_fini(&damage);
        break;
    }
    /* Subsurfaces apply their commits before the window's own surface, which settles
     * the frame: then a held one fades out if the size changed, or is let go. */
    if (!committed || committed == window->surface) {
        begin_fade(window);
        if (window_presentable(window)) window_release_snapshot(window);
    }
    /* New subsurfaces and popups join the window's outputs. */
    sync_membership(window, &surfaces);
    vec_finish(&surfaces);
    if (!window->configured) window_configure(window);
}

void window_mapped(struct window *window) {
    struct server *server = window->server;
    window->mapped = true;
    windows_sync_fallback(server);
    window_configure(window);
    /* A new window takes the keyboard, unless the director placed it unfocusable. */
    if (window_focusable(window)) focus_window(server, window);
    scene_changed(server);
    window_report(window);
}

static void focus_forget_window(struct server *server, struct window *window);

/* The window stopped showing: it loses pointer and keyboard focus. */
static void window_gone(struct window *window) {
    struct server *server = window->server;
    input_forget_window(server, window);
    share_window_gone(server, window);
    focus_forget_window(server, window);
}

void window_unmapped(struct window *window) {
    struct server *server = window->server;
    release_fade(window);
    /* Withdrawn without a last commit, as when the client destroys the window. */
    if (window_exits(window)) hold_frame(window);
    else window_release_snapshot(window);
    window->mapped = false;
    windows_sync_fallback(server);
    window_gone(window);
    scene_changed(server);
    window_report(window);
}

void window_destroyed(struct window *window) {
    struct server *server = window->server;
    /* Even unmapped, the director may have focused it. */
    window->mapped = false;
    window_gone(window);
    window->alive = false;
    wl_list_remove(&window->link);
    idmap_remove(&server->windows_by_id, (int64_t)window->id);
    displays_forget_window(server, window);
    if (window->fallback) {
        struct protocol_error ignored;
        scene_remove(&server->fallback, 0, window->fallback->id, &ignored);
        scene_finish_commit(&server->fallback, now_seconds());
        window->fallback = NULL;
    }
    struct window *other;
    wl_list_for_each(other, &server->windows, link) {
        if (other->parent == window) {
            other->parent = NULL;
            window_report(other);
        }
    }
    window->surface = NULL;
    window->toplevel = NULL;
    window->xsurface = NULL;
    if (window->snapshot.length) {
        /* An exiting node may still show its last frame. */
        window_ref(window);
        idmap_put(&server->departed, (int64_t)window->id, window);
    }
    struct message message;
    message_begin(&message, "window-removed");
    json_key(&message.writer, "id");
    json_int(&message.writer, (int64_t)window->id);
    message_send(server, &message, NULL);
    scene_changed(server);
    window_unref(window);
}

/* A request from the client: the window's node may handle it, or it is answered here. */
void window_request(struct window *window, enum event_name event, bool value, uint32_t edges) {
    struct server *server = window->server;
    struct node *node = first_node(window);
    bool handled = node && node_handles(node, event) && link_connected(server);
    switch (event) {
    case EVENT_MOVEREQUEST:
    case EVENT_RESIZEREQUEST:
        input_client_move_request(server, window, node, event == EVENT_MOVEREQUEST, edges);
        return;
    case EVENT_ACTIVATEREQUEST: {
        struct event message;
        /* The window's node may decide how to show it, e.g. on its workspace. */
        if (handled && event_begin(server, &message, node, EVENT_ACTIVATEREQUEST)) {
            event_end(server, &message);
        } else if (window_focusable(window)) {
            focus_window(server, window);
        }
        return;
    }
    case EVENT_FULLSCREENREQUEST:
    case EVENT_MAXIMIZEREQUEST:
    case EVENT_MINIMIZEREQUEST: {
        struct event message;
        if (handled && event_begin(server, &message, node, event)) {
            json_key(&message.writer, "value");
            json_bool(&message.writer, value);
            event_end(server, &message);
        } else if (event != EVENT_MINIMIZEREQUEST && initialized(window)) {
            /* Unhandled requests are answered with the current state, so clients
             * waiting for a configure are not left hanging. */
            bool current =
                node && node_bool(node, event == EVENT_FULLSCREENREQUEST ? PROP_FULLSCREEN
                                                                         : PROP_MAXIMIZED);
            send_state(window,
                       event == EVENT_FULLSCREENREQUEST ? WINDOW_FULLSCREEN : WINDOW_MAXIMIZED,
                       current);
        } else if (window->type == WINDOW_XWAYLAND && event != EVENT_MINIMIZEREQUEST) {
            /* X11 sets the state it asks for before asking; it keeps what was sent
             * until the director declares otherwise. */
            send_state(window,
                       event == EVENT_FULLSCREENREQUEST ? WINDOW_FULLSCREEN : WINDOW_MAXIMIZED,
                       event == EVENT_FULLSCREENREQUEST ? window->sent_fullscreen
                                                        : window->sent_maximized);
        }
        if (window->type == WINDOW_XWAYLAND && window->xsurface && event == EVENT_MINIMIZEREQUEST)
            wlr_xwayland_surface_set_minimized(window->xsurface, false);
        if (window->type == WINDOW_XDG && window->toplevel->base->initialized)
            wlr_xdg_surface_schedule_configure(window->toplevel->base);
        return;
    }
    default: return;
    }
}

static void frame_done_iterator(struct wlr_surface *surface, int x, int y, void *data) {
    wlr_surface_send_frame_done(surface, data);
}

void window_send_frame_done(struct window *window, const struct timespec *when) {
    if (!window_presentable(window)) return;
    if (window->type == WINDOW_XDG) {
        wlr_xdg_surface_for_each_surface(window->toplevel->base, frame_done_iterator, (void *)when);
    } else {
        wlr_surface_for_each_surface(window->surface, frame_done_iterator, (void *)when);
        xwayland_child_surfaces(window, frame_done_iterator, (void *)when);
    }
}

/* Focus. */

bool window_focusable(struct window *window) {
    struct node *node = first_node(window);
    return window->mapped && (!node || node_bool(node, PROP_FOCUSABLE));
}

static void report_focus(struct server *server) {
    struct window *window = server->seat_state.focused;
    struct message message;
    message_begin(&message, "focus");
    json_key(&message.writer, "seat");
    json_string(&message.writer, "seat0");
    json_key(&message.writer, "window");
    if (window) json_int(&message.writer, (int64_t)window->id);
    else json_null(&message.writer);
    message_send(server, &message, NULL);
}

/* The history holds a reference to each window in it, most recent first. */
static void history_remove(struct seat_state *state, struct window *window) {
    for (size_t i = 0; i < state->history.length; i++) {
        if (*(struct window **)vec_at(&state->history, i) == window) {
            vec_remove(&state->history, i);
            window_unref(window);
            return;
        }
    }
}

static void history_push_front(struct seat_state *state, struct window *window) {
    vec_push(&state->history);
    memmove(vec_at(&state->history, 1), vec_at(&state->history, 0),
            (state->history.length - 1) * sizeof(struct window *));
    *(struct window **)vec_at(&state->history, 0) = window;
}

/* Focus WINDOW, which also takes the keyboard back from a focused page. The focused
 * slot holds a reference, which the history takes over when focus moves on. */
void focus_window(struct server *server, struct window *window) {
    struct seat_state *state = &server->seat_state;
    struct window *old = state->focused;
    if (window) state->focused_page = NULL;
    if (old != window) {
        if (old) {
            history_remove(state, old);
            history_push_front(state, old);
            window_set_activated(old, false);
        }
        if (window) {
            history_remove(state, window);
            window_ref(window);
            window_set_activated(window, true);
        }
        state->focused = window;
        report_focus(server);
    } else if (window) {
        /* Focused before it could be configured, e.g. before mapping: activate it now. */
        window_set_activated(window, true);
    }
    keyboard_sync_focus(server);
}

static void focus_forget_window(struct server *server, struct window *window) {
    struct seat_state *state = &server->seat_state;
    history_remove(state, window);
    if (state->focused != window) return;
    state->focused = NULL;
    window_unref(window);
    /* Focus returns to the latest window still on screen. */
    struct window *next = NULL;
    VEC_FOR(&state->history, struct window *, candidate) {
        if (window_focusable(*candidate) && (*candidate)->outputs) {
            next = *candidate;
            break;
        }
    }
    if (next) {
        focus_window(server, next);
    } else {
        report_focus(server);
        keyboard_sync_focus(server);
    }
}
