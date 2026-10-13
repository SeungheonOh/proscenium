/*
 * xdg-shell clients as windows, their popups, and activation requests.
 */
#include <math.h>
#include <stdlib.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_xdg_activation_v1.h>
#include <wlr/types/wlr_xdg_decoration_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/xwayland.h>

#include "display.h"
#include "input.h"
#include "server.h"
#include "stage.h"

struct popup {
    struct wlr_xdg_popup *popup;
    struct wl_listener commit, reposition, destroy;
};

struct surface_watch {
    struct server *server;
    struct wlr_surface *surface;
    struct wl_listener client_commit, commit, destroy;
};

/* The window an xdg surface belongs to, through its chain of popup parents. */
static struct window *xdg_window(struct wlr_xdg_surface *xdg_surface) {
    for (int depth = 0; xdg_surface && depth < 64; depth++) {
        if (xdg_surface->role == WLR_XDG_SURFACE_ROLE_TOPLEVEL)
            return xdg_surface->toplevel ? xdg_surface->toplevel->base->data : NULL;
        if (xdg_surface->role != WLR_XDG_SURFACE_ROLE_POPUP || !xdg_surface->popup) return NULL;
        struct wlr_surface *parent = xdg_surface->popup->parent;
        if (!parent) return NULL;
        struct wlr_xdg_surface *next = wlr_xdg_surface_try_from_wlr_surface(parent);
        if (!next) {
            /* An X11 window's popup, or a layer: follow the root. */
            struct wlr_xwayland_surface *xsurface =
                wlr_xwayland_surface_try_from_wlr_surface(parent);
            return xsurface ? xwayland_window_of(xsurface) : NULL;
        }
        xdg_surface = next;
    }
    return NULL;
}

/* The window a surface belongs to: its toplevel, through popups and subsurfaces, or an
 * X11 window; NULL for none. */
static struct window *window_of_surface(struct wlr_surface *surface) {
    if (!surface) return NULL;
    struct wlr_surface *root = wlr_surface_get_root_surface(surface);
    struct wlr_xdg_surface *xdg_surface = wlr_xdg_surface_try_from_wlr_surface(root);
    if (xdg_surface) return xdg_window(xdg_surface);
    struct wlr_xwayland_surface *xsurface = wlr_xwayland_surface_try_from_wlr_surface(root);
    return xsurface ? xwayland_window_of(xsurface) : NULL;
}

/* Every surface commit: its window's content changed, or a cursor or drag icon moved. */
static void handle_surface_commit(struct wl_listener *listener, void *data) {
    struct surface_watch *watch = wl_container_of(listener, watch, commit);
    struct window *window = window_of_surface(watch->surface);
    if (window && window->alive) window_committed(window, watch->surface);
    else input_surface_committed(watch->server, watch->surface);
}

/* Before wlroots applies a commit: what is on screen may have to be kept. */
static void handle_surface_client_commit(struct wl_listener *listener, void *data) {
    struct surface_watch *watch = wl_container_of(listener, watch, client_commit);
    struct window *window = window_of_surface(watch->surface);
    if (window && window->alive) window_client_commit(window, watch->surface);
}

static void handle_surface_destroy(struct wl_listener *listener, void *data) {
    struct surface_watch *watch = wl_container_of(listener, watch, destroy);
    struct window *window = window_of_surface(watch->surface);
    if (window && window->alive) window_surface_destroying(window);
    wl_list_remove(&watch->client_commit.link);
    wl_list_remove(&watch->commit.link);
    wl_list_remove(&watch->destroy.link);
    input_surface_destroyed(watch->server, watch->surface);
    free(watch);
}

static void handle_new_surface(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, new_surface);
    struct wlr_surface *surface = data;
    struct surface_watch *watch = xcalloc(1, sizeof *watch);
    watch->server = server;
    watch->surface = surface;
    watch->client_commit.notify = handle_surface_client_commit;
    wl_signal_add(&surface->events.client_commit, &watch->client_commit);
    watch->commit.notify = handle_surface_commit;
    wl_signal_add(&surface->events.commit, &watch->commit);
    watch->destroy.notify = handle_surface_destroy;
    wl_signal_add(&surface->events.destroy, &watch->destroy);
}

/* Toplevels. */

static void handle_map(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, map);
    window_mapped(window);
}

static void handle_unmap(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, unmap);
    window_unmapped(window);
}

static void handle_toplevel_commit(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, commit);
    struct wlr_xdg_toplevel *toplevel = window->toplevel;
    if (toplevel->base->initial_commit) {
        /* The first configure: the director's size if a node already presents it. */
        window->configured = false;
        window->states_known = false;
        if (window->decoration)
            wlr_xdg_toplevel_decoration_v1_set_mode(
                window->decoration, WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
        window_configure(window);
        if (!window->configured) wlr_xdg_toplevel_set_size(toplevel, 0, 0);
        return;
    }
    /* Size limits are double-buffered state with no event of their own. */
    struct wlr_xdg_toplevel_state *state = &toplevel->current;
    if (state->min_width != window->min_width || state->min_height != window->min_height ||
        state->max_width != window->max_width || state->max_height != window->max_height) {
        window->min_width = state->min_width;
        window->min_height = state->min_height;
        window->max_width = state->max_width;
        window->max_height = state->max_height;
        window_report(window);
    }
}

static void handle_destroy(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, destroy);
    wl_list_remove(&window->map.link);
    wl_list_remove(&window->unmap.link);
    wl_list_remove(&window->commit.link);
    wl_list_remove(&window->destroy.link);
    wl_list_remove(&window->request_move.link);
    wl_list_remove(&window->request_resize.link);
    wl_list_remove(&window->request_maximize.link);
    wl_list_remove(&window->request_fullscreen.link);
    wl_list_remove(&window->request_minimize.link);
    wl_list_remove(&window->set_title.link);
    wl_list_remove(&window->set_app_id.link);
    wl_list_remove(&window->set_parent.link);
    window_destroyed(window);
}

static void handle_request_move(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, request_move);
    window_request(window, EVENT_MOVEREQUEST, true, 0);
}

static void handle_request_resize(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, request_resize);
    struct wlr_xdg_toplevel_resize_event *event = data;
    window_request(window, EVENT_RESIZEREQUEST, true, event->edges);
}

static void handle_request_maximize(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, request_maximize);
    window_request(window, EVENT_MAXIMIZEREQUEST, window->toplevel->requested.maximized, 0);
}

static void handle_request_fullscreen(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, request_fullscreen);
    window_request(window, EVENT_FULLSCREENREQUEST, window->toplevel->requested.fullscreen, 0);
}

static void handle_request_minimize(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, request_minimize);
    window_request(window, EVENT_MINIMIZEREQUEST, true, 0);
}

static void handle_set_title(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, set_title);
    free(window->title);
    window->title = window->toplevel->title ? xstrdup(window->toplevel->title) : NULL;
    window_report(window);
}

static void handle_set_app_id(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, set_app_id);
    free(window->app_id);
    window->app_id = window->toplevel->app_id ? xstrdup(window->toplevel->app_id) : NULL;
    window_report(window);
}

static void handle_set_parent(struct wl_listener *listener, void *data) {
    struct window *window = wl_container_of(listener, window, set_parent);
    struct wlr_xdg_toplevel *parent = window->toplevel->parent;
    window->parent = parent ? parent->base->data : NULL;
    window_report(window);
}

static void handle_new_toplevel(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, new_xdg_toplevel);
    struct wlr_xdg_toplevel *toplevel = data;
    struct window *window = window_create(server, WINDOW_XDG);
    window->toplevel = toplevel;
    window->surface = toplevel->base->surface;
    toplevel->base->data = window;
    if (toplevel->title) window->title = xstrdup(toplevel->title);
    if (toplevel->app_id) window->app_id = xstrdup(toplevel->app_id);
    if (toplevel->parent) window->parent = toplevel->parent->base->data;

    window->map.notify = handle_map;
    wl_signal_add(&toplevel->base->surface->events.map, &window->map);
    window->unmap.notify = handle_unmap;
    wl_signal_add(&toplevel->base->surface->events.unmap, &window->unmap);
    window->commit.notify = handle_toplevel_commit;
    wl_signal_add(&toplevel->base->surface->events.commit, &window->commit);
    window->destroy.notify = handle_destroy;
    wl_signal_add(&toplevel->events.destroy, &window->destroy);
    window->request_move.notify = handle_request_move;
    wl_signal_add(&toplevel->events.request_move, &window->request_move);
    window->request_resize.notify = handle_request_resize;
    wl_signal_add(&toplevel->events.request_resize, &window->request_resize);
    window->request_maximize.notify = handle_request_maximize;
    wl_signal_add(&toplevel->events.request_maximize, &window->request_maximize);
    window->request_fullscreen.notify = handle_request_fullscreen;
    wl_signal_add(&toplevel->events.request_fullscreen, &window->request_fullscreen);
    window->request_minimize.notify = handle_request_minimize;
    wl_signal_add(&toplevel->events.request_minimize, &window->request_minimize);
    window->set_title.notify = handle_set_title;
    wl_signal_add(&toplevel->events.set_title, &window->set_title);
    window->set_app_id.notify = handle_set_app_id;
    wl_signal_add(&toplevel->events.set_app_id, &window->set_app_id);
    window->set_parent.notify = handle_set_parent;
    wl_signal_add(&toplevel->events.set_parent, &window->set_parent);

    /* The director may already present this id, e.g. after it restarted. */
    stage_reindex(server);
    window_report(window);
}

/* Decorations: windows draw their own; any frame around them is the director's shaders. */

struct decoration {
    struct wlr_xdg_toplevel_decoration_v1 *decoration;
    struct window *window; /* referenced */
    struct wl_listener request_mode, destroy;
};

/* The mode goes out with a configure, which waits for the toplevel's initial commit. */
static void set_client_side(struct wlr_xdg_toplevel_decoration_v1 *decoration) {
    if (decoration->toplevel->base->initialized)
        wlr_xdg_toplevel_decoration_v1_set_mode(decoration,
                                                WLR_XDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
}

static void handle_decoration_request_mode(struct wl_listener *listener, void *data) {
    struct decoration *decoration = wl_container_of(listener, decoration, request_mode);
    set_client_side(decoration->decoration);
}

static void handle_decoration_destroy(struct wl_listener *listener, void *data) {
    struct decoration *decoration = wl_container_of(listener, decoration, destroy);
    wl_list_remove(&decoration->request_mode.link);
    wl_list_remove(&decoration->destroy.link);
    if (decoration->window->decoration == decoration->decoration)
        decoration->window->decoration = NULL;
    window_unref(decoration->window);
    free(decoration);
}

static void handle_new_decoration(struct wl_listener *listener, void *data) {
    struct wlr_xdg_toplevel_decoration_v1 *wlr_decoration = data;
    struct window *window = wlr_decoration->toplevel->base->data;
    if (!window) return;
    struct decoration *decoration = xcalloc(1, sizeof *decoration);
    decoration->decoration = wlr_decoration;
    window_ref(window);
    decoration->window = window;
    window->decoration = wlr_decoration;
    decoration->request_mode.notify = handle_decoration_request_mode;
    wl_signal_add(&wlr_decoration->events.request_mode, &decoration->request_mode);
    decoration->destroy.notify = handle_decoration_destroy;
    wl_signal_add(&wlr_decoration->events.destroy, &decoration->destroy);
    set_client_side(wlr_decoration);
}

/* Popups. */

/*
 * The part of an output showing WINDOW, in its content coordinates, so its popups
 * open where they can be seen; under a turned window, the bounding box of the
 * output's corners mapped back onto its plane.
 */
static bool window_popup_box(struct window *window, struct wlr_box *out) {
    struct output *output;
    wl_list_for_each(output, &window->server->outputs, link) {
        struct mat3 to_logical, inverse;
        if (!display_window_logical_transform(output, window, &to_logical) ||
            !mat3_invert(to_logical, &inverse))
            continue;
        struct box box =
            mat3_box_bounds(inverse, (struct box){0, 0, output->width, output->height}, 0);
        if (box.width >= BOX_UNBOUNDED.width) continue;
        *out = (struct wlr_box){(int)floor(box.x), (int)floor(box.y), (int)ceil(box.width),
                                (int)ceil(box.height)};
        return true;
    }
    return false;
}

/* Keep a popup where it can be seen: wlroots takes the box in the toplevel's
 * surface coordinates, our content coordinates, and places the popup within it. */
static void unconstrain(struct popup *popup) {
    struct window *window = xdg_window(popup->popup->base);
    struct wlr_box box;
    if (window && window_popup_box(window, &box))
        wlr_xdg_popup_unconstrain_from_box(popup->popup, &box);
}

static void handle_popup_commit(struct wl_listener *listener, void *data) {
    struct popup *popup = wl_container_of(listener, popup, commit);
    if (popup->popup->base->initial_commit) {
        unconstrain(popup);
        wlr_xdg_surface_schedule_configure(popup->popup->base);
    }
}

static void handle_popup_reposition(struct wl_listener *listener, void *data) {
    struct popup *popup = wl_container_of(listener, popup, reposition);
    /* The new positioner is unconstrained too, before wlroots sends its configure. */
    unconstrain(popup);
}

static void handle_popup_destroy(struct wl_listener *listener, void *data) {
    struct popup *popup = wl_container_of(listener, popup, destroy);
    struct window *window = xdg_window(popup->popup->base);
    wl_list_remove(&popup->commit.link);
    wl_list_remove(&popup->reposition.link);
    wl_list_remove(&popup->destroy.link);
    free(popup);
    if (window && window->alive) window_committed(window, NULL);
}

static void handle_new_popup(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, new_xdg_popup);
    struct wlr_xdg_popup *xdg_popup = data;
    struct popup *popup = xcalloc(1, sizeof *popup);
    popup->popup = xdg_popup;
    popup->commit.notify = handle_popup_commit;
    wl_signal_add(&xdg_popup->base->surface->events.commit, &popup->commit);
    popup->reposition.notify = handle_popup_reposition;
    wl_signal_add(&xdg_popup->events.reposition, &popup->reposition);
    popup->destroy.notify = handle_popup_destroy;
    wl_signal_add(&xdg_popup->events.destroy, &popup->destroy);
}

static void handle_activation_request(struct wl_listener *listener, void *data) {
    struct wlr_xdg_activation_v1_request_activate_event *event = data;
    struct window *window = window_of_surface(event->surface);
    if (window && window->alive) window_request(window, EVENT_ACTIVATEREQUEST, true, 0);
}

void xdg_init(struct server *server) {
    struct wlr_xdg_decoration_manager_v1 *decorations =
        wlr_xdg_decoration_manager_v1_create(server->wl_display);
    server->new_decoration.notify = handle_new_decoration;
    wl_signal_add(&decorations->events.new_toplevel_decoration, &server->new_decoration);
    server->new_xdg_toplevel.notify = handle_new_toplevel;
    wl_signal_add(&server->xdg_shell->events.new_toplevel, &server->new_xdg_toplevel);
    server->new_xdg_popup.notify = handle_new_popup;
    wl_signal_add(&server->xdg_shell->events.new_popup, &server->new_xdg_popup);
    server->activation_request.notify = handle_activation_request;
    wl_signal_add(&server->activation->events.request_activate, &server->activation_request);
    server->new_surface.notify = handle_new_surface;
    wl_signal_add(&server->compositor->events.new_surface, &server->new_surface);
}

void xdg_finish(struct server *server) {
    wl_list_remove(&server->new_decoration.link);
    wl_list_remove(&server->new_xdg_toplevel.link);
    wl_list_remove(&server->new_xdg_popup.link);
    wl_list_remove(&server->activation_request.link);
    wl_list_remove(&server->new_surface.link);
}
