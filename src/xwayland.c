/*
 * X11 clients through Xwayland.
 *
 * Managed X windows become windows like xdg toplevels. Override-redirect
 * windows (menus, tooltips) belong to the window they pop up from: they are
 * drawn and picked as part of it, placed by their X offset from it. X
 * coordinates never encode the canvas, so a mapped window keeps the X position
 * it has and the director moves its node instead.
 */
#include <stdlib.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/util/log.h>
#include <wlr/xcursor.h>
#include <wlr/xwayland.h>
#include <xcb/xcb_icccm.h>

#include "server.h"
#include "stage.h"

struct xsurface {
    struct wl_list link; /* server.xsurfaces */
    struct server *server;
    struct wlr_xwayland_surface *x;
    /* A managed window while associated. */
    struct window *window;
    /* The window an override-redirect surface pops up from, by id. */
    uint64_t owner;
    bool surface_listening;
    struct wl_listener associate, dissociate, destroy, request_configure, set_title, set_class,
        set_parent, set_size_hints, set_geometry, set_override_redirect, request_fullscreen,
        request_maximize, request_minimize, request_move, request_resize, request_activate, map,
        unmap;
};

static struct xsurface *xsurface_of(struct wlr_xwayland_surface *x) {
    return x ? x->data : NULL;
}

/* The window an override-redirect surface belongs to, through its parents. */
static struct window *owner_window(struct xsurface *xs) {
    for (int depth = 0; xs && depth < 32; depth++) {
        if (xs->window) return xs->window;
        if (xs->owner) return window_by_id(xs->server, xs->owner);
        xs = xsurface_of(xs->x->parent);
    }
    return NULL;
}

struct window *xwayland_window_of(struct wlr_xwayland_surface *x) {
    struct xsurface *xs = xsurface_of(x);
    return xs ? owner_window(xs) : NULL;
}

/* Menus may omit WM_TRANSIENT_FOR: they belong to the focused X window, or else to
 * the mapped one they open over. */
static uint64_t find_owner(struct xsurface *xs) {
    struct window *window = owner_window(xsurface_of(xs->x->parent));
    if (window) return window->id;
    struct server *server = xs->server;
    struct window *focused = server->seat_state.focused;
    if (focused && focused->type == WINDOW_XWAYLAND) return focused->id;
    struct xsurface *other;
    wl_list_for_each(other, &server->xsurfaces, link) {
        struct wlr_xwayland_surface *o = other->x;
        if (other->window && other->window->mapped && o->x <= xs->x->x &&
            xs->x->x <= o->x + o->width && o->y <= xs->x->y && xs->x->y <= o->y + o->height)
            return other->window->id;
    }
    return 0;
}

/* A child's offset from its owner's surface, in the owner's content coordinates. */
static bool child_offset(struct xsurface *xs, struct window *window, int *dx, int *dy) {
    if (xs->window || !xs->x->surface || !xs->x->surface->mapped || !window->xsurface) return false;
    if (owner_window(xs) != window) return false;
    *dx = xs->x->x - window->xsurface->x;
    *dy = xs->x->y - window->xsurface->y;
    return true;
}

struct offset_iterator {
    wlr_surface_iterator_func_t iterator;
    void *data;
    int dx, dy;
};

static void iterate_offset(struct wlr_surface *surface, int x, int y, void *data) {
    struct offset_iterator *offset = data;
    offset->iterator(surface, x + offset->dx, y + offset->dy, offset->data);
}

void xwayland_child_surfaces(struct window *window, wlr_surface_iterator_func_t iterator,
                             void *data) {
    struct xsurface *xs;
    wl_list_for_each(xs, &window->server->xsurfaces, link) {
        struct offset_iterator offset = {iterator, data};
        if (child_offset(xs, window, &offset.dx, &offset.dy))
            wlr_surface_for_each_surface(xs->x->surface, iterate_offset, &offset);
    }
}

struct wlr_surface *xwayland_surface_at(struct window *window, double x, double y, double *sx,
                                        double *sy) {
    /* Children are stacked above their owner, the latest topmost. */
    struct xsurface *xs;
    wl_list_for_each_reverse(xs, &window->server->xsurfaces, link) {
        int dx, dy;
        if (!child_offset(xs, window, &dx, &dy)) continue;
        struct wlr_surface *surface =
            wlr_surface_surface_at(xs->x->surface, x - dx, y - dy, sx, sy);
        if (surface) return surface;
    }
    return window->surface ? wlr_surface_surface_at(window->surface, x, y, sx, sy) : NULL;
}

/* A child appearing, moving or leaving changes its owner's content. */
static void owner_changed(struct xsurface *xs) {
    struct window *window = owner_window(xs);
    if (window && window->alive) window_committed(window, NULL);
}

void xwayland_configure(struct window *window, int width, int height) {
    struct wlr_xwayland_surface *x = window->xsurface;
    if (x)
        wlr_xwayland_surface_configure(x, x->x, x->y, CLAMP(width, 1, 65535),
                                       CLAMP(height, 1, 65535));
}

void xwayland_set_state(struct window *window, enum window_state state, bool value) {
    struct wlr_xwayland_surface *x = window->xsurface;
    if (!x) return;
    switch (state) {
    case WINDOW_FULLSCREEN: wlr_xwayland_surface_set_fullscreen(x, value); break;
    case WINDOW_MAXIMIZED: wlr_xwayland_surface_set_maximized(x, value, value); break;
    case WINDOW_ACTIVATED:
        wlr_xwayland_surface_activate(x, value);
        if (value && !x->override_redirect)
            wlr_xwayland_surface_restack(x, NULL, XCB_STACK_MODE_ABOVE);
        break;
    case WINDOW_RESIZING: break; /* X11 has no such hint */
    }
}

static void read_size_hints(struct window *window, struct wlr_xwayland_surface *x) {
    xcb_size_hints_t *hints = x->size_hints;
    bool min = hints && (hints->flags & XCB_ICCCM_SIZE_HINT_P_MIN_SIZE);
    bool max = hints && (hints->flags & XCB_ICCCM_SIZE_HINT_P_MAX_SIZE);
    window->min_width = min ? MAX(hints->min_width, 0) : 0;
    window->min_height = min ? MAX(hints->min_height, 0) : 0;
    window->max_width = max ? MAX(hints->max_width, 0) : 0;
    window->max_height = max ? MAX(hints->max_height, 0) : 0;
}

static void set_text(char **slot, const char *text) {
    free(*slot);
    *slot = text ? xstrdup(text) : NULL;
}

/* Surface lifetime. */

static void handle_map(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, map);
    if (xs->window) window_mapped(xs->window);
    else owner_changed(xs);
}

static void handle_unmap(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, unmap);
    if (xs->window) window_unmapped(xs->window);
    else owner_changed(xs);
}

static void dissociate(struct xsurface *xs) {
    if (xs->surface_listening) {
        wl_list_remove(&xs->map.link);
        wl_list_remove(&xs->unmap.link);
        xs->surface_listening = false;
    }
    if (xs->window) {
        struct window *window = xs->window;
        xs->window = NULL;
        window_destroyed(window);
    } else if (xs->owner) {
        owner_changed(xs);
        xs->owner = 0;
    }
}

static void handle_associate(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, associate);
    struct server *server = xs->server;
    struct wlr_xwayland_surface *x = xs->x;
    dissociate(xs);
    struct wlr_surface *surface = x->surface;
    xs->map.notify = handle_map;
    wl_signal_add(&surface->events.map, &xs->map);
    xs->unmap.notify = handle_unmap;
    wl_signal_add(&surface->events.unmap, &xs->unmap);
    xs->surface_listening = true;
    if (x->override_redirect) {
        xs->owner = find_owner(xs);
    } else {
        struct window *window = window_create(server, WINDOW_XWAYLAND);
        window->xsurface = x;
        window->surface = surface;
        set_text(&window->title, x->title);
        set_text(&window->app_id, x->class);
        struct xsurface *parent = xsurface_of(x->parent);
        window->parent = parent ? parent->window : NULL;
        read_size_hints(window, x);
        xs->window = window;
    }
    /* Association can follow the surface's first buffer, whose map was missed. */
    if (wlr_surface_has_buffer(surface) && !surface->mapped) wlr_surface_map(surface);
    else if (surface->mapped) handle_map(&xs->map, NULL);
}

/* A window turning into a menu, or back, is associated again in its new role. */
static void handle_set_override_redirect(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, set_override_redirect);
    bool managed = xs->window != NULL;
    if (xs->x->surface && managed == xs->x->override_redirect)
        handle_associate(&xs->associate, NULL);
}

static void handle_dissociate(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, dissociate);
    dissociate(xs);
}

static void handle_destroy(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, destroy);
    dissociate(xs);
    struct wl_listener *listeners[] = {
        &xs->associate,
        &xs->dissociate,
        &xs->destroy,
        &xs->request_configure,
        &xs->set_title,
        &xs->set_class,
        &xs->set_parent,
        &xs->set_size_hints,
        &xs->set_geometry,
        &xs->set_override_redirect,
        &xs->request_fullscreen,
        &xs->request_maximize,
        &xs->request_minimize,
        &xs->request_move,
        &xs->request_resize,
        &xs->request_activate,
    };
    for (size_t i = 0; i < ARRAY_LENGTH(listeners); i++) wl_list_remove(&listeners[i]->link);
    wl_list_remove(&xs->link);
    xs->x->data = NULL;
    free(xs);
}

/* Metadata. */

static void handle_set_title(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, set_title);
    if (!xs->window) return;
    set_text(&xs->window->title, xs->x->title);
    window_report(xs->window);
}

static void handle_set_class(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, set_class);
    if (!xs->window) return;
    set_text(&xs->window->app_id, xs->x->class);
    window_report(xs->window);
}

static void handle_set_parent(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, set_parent);
    if (!xs->window) return;
    struct xsurface *parent = xsurface_of(xs->x->parent);
    xs->window->parent = parent ? parent->window : NULL;
    window_report(xs->window);
}

static void handle_set_size_hints(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, set_size_hints);
    if (!xs->window) return;
    read_size_hints(xs->window, xs->x);
    window_report(xs->window);
}

static void handle_set_geometry(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, set_geometry);
    if (!xs->window) owner_changed(xs);
}

/* Requests. */

static void handle_request_configure(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_configure);
    struct wlr_xwayland_surface_configure_event *event = data;
    struct wlr_xwayland_surface *x = xs->x;
    /* A mapped window keeps the size its node gives it; only unmapped ones get what they ask. */
    bool managed = xs->window && xs->window->mapped;
    uint16_t mask = managed ? 0 : event->mask;
    wlr_xwayland_surface_configure(
        x, mask & XCB_CONFIG_WINDOW_X ? event->x : x->x,
        mask & XCB_CONFIG_WINDOW_Y ? event->y : x->y,
        MAX(1, mask & XCB_CONFIG_WINDOW_WIDTH ? event->width : x->width),
        MAX(1, mask & XCB_CONFIG_WINDOW_HEIGHT ? event->height : x->height));
}

static void handle_request_fullscreen(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_fullscreen);
    if (xs->window) window_request(xs->window, EVENT_FULLSCREENREQUEST, xs->x->fullscreen, 0);
}

static void handle_request_maximize(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_maximize);
    bool value = xs->x->maximized_horz && xs->x->maximized_vert;
    if (xs->window) window_request(xs->window, EVENT_MAXIMIZEREQUEST, value, 0);
}

static void handle_request_minimize(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_minimize);
    struct wlr_xwayland_minimize_event *event = data;
    if (xs->window) window_request(xs->window, EVENT_MINIMIZEREQUEST, event->minimize, 0);
}

/* X11 has no serials; input takes a move or resize only while a button pressed on
 * the window is held. */
static void handle_request_move(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_move);
    if (xs->window) window_request(xs->window, EVENT_MOVEREQUEST, true, 0);
}

static void handle_request_resize(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_resize);
    struct wlr_xwayland_resize_event *event = data;
    if (xs->window) window_request(xs->window, EVENT_RESIZEREQUEST, true, event->edges);
}

static void handle_request_activate(struct wl_listener *listener, void *data) {
    struct xsurface *xs = wl_container_of(listener, xs, request_activate);
    if (xs->window && xs->window->mapped)
        window_request(xs->window, EVENT_ACTIVATEREQUEST, true, 0);
}

static void handle_new_surface(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, xwayland_new_surface);
    struct wlr_xwayland_surface *x = data;
    struct xsurface *xs = xcalloc(1, sizeof *xs);
    xs->server = server;
    xs->x = x;
    x->data = xs;
    wl_list_insert(server->xsurfaces.prev, &xs->link);
#define LISTEN(signal, field, handler)                                                             \
    xs->field.notify = handler;                                                                    \
    wl_signal_add(&x->events.signal, &xs->field)
    LISTEN(associate, associate, handle_associate);
    LISTEN(dissociate, dissociate, handle_dissociate);
    LISTEN(destroy, destroy, handle_destroy);
    LISTEN(request_configure, request_configure, handle_request_configure);
    LISTEN(set_title, set_title, handle_set_title);
    LISTEN(set_class, set_class, handle_set_class);
    LISTEN(set_parent, set_parent, handle_set_parent);
    LISTEN(set_size_hints, set_size_hints, handle_set_size_hints);
    LISTEN(set_geometry, set_geometry, handle_set_geometry);
    LISTEN(set_override_redirect, set_override_redirect, handle_set_override_redirect);
    LISTEN(request_fullscreen, request_fullscreen, handle_request_fullscreen);
    LISTEN(request_maximize, request_maximize, handle_request_maximize);
    LISTEN(request_minimize, request_minimize, handle_request_minimize);
    LISTEN(request_move, request_move, handle_request_move);
    LISTEN(request_resize, request_resize, handle_request_resize);
    LISTEN(request_activate, request_activate, handle_request_activate);
#undef LISTEN
}

static void handle_ready(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, xwayland_ready);
    wlr_xwayland_set_seat(server->xwayland, server->seat);
    /* X clients that set no cursor show the default one. */
    struct wlr_xcursor *xcursor =
        wlr_xcursor_manager_get_xcursor(server->xcursor_manager, "default", 1);
    if (xcursor) {
        struct wlr_xcursor_image *image = xcursor->images[0];
        wlr_xwayland_set_cursor(server->xwayland, wlr_xcursor_image_get_buffer(image),
                                (int32_t)image->hotspot_x, (int32_t)image->hotspot_y);
    }
}

void xwayland_init(struct server *server) {
    /* Lazy: Xwayland starts when the first X client connects. */
    server->xwayland = wlr_xwayland_create(server->wl_display, server->compositor, true);
    if (!server->xwayland) {
        wlr_log(WLR_ERROR, "Xwayland is unavailable; X11 clients will not run");
        return;
    }
    server->xwayland_new_surface.notify = handle_new_surface;
    wl_signal_add(&server->xwayland->events.new_surface, &server->xwayland_new_surface);
    server->xwayland_ready.notify = handle_ready;
    wl_signal_add(&server->xwayland->events.ready, &server->xwayland_ready);
    setenv("DISPLAY", server->xwayland->display_name, 1);
}

void xwayland_finish(struct server *server) {
    if (!server->xwayland) return;
    wl_list_remove(&server->xwayland_new_surface.link);
    wl_list_remove(&server->xwayland_ready.link);
    wlr_xwayland_destroy(server->xwayland);
    server->xwayland = NULL;
}
