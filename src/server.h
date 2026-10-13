/*
 * The compositor's shared state. One `struct server` lives for the whole run;
 * every module reaches the others through it.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <pixman.h>
#include <wayland-server-core.h>
#include <wlr/util/box.h>

#include "geometry.h"
#include "scene.h"
#include "util.h"

struct wlr_surface;
struct wlr_output;
struct wlr_buffer;
struct wlr_texture;
struct wlr_xdg_toplevel;
struct wlr_xdg_toplevel_decoration_v1;
struct wlr_xwayland_surface;
struct renderer;
struct link;
struct media;
struct web;
struct web_page;
struct display;
struct camera;
struct input;
struct shares;
struct clipboard;
struct json_writer;

/* A client surface to draw, as one of a window's surfaces in content coordinates. */
struct surface_draw {
    struct wlr_surface *surface;
    /* Locked while held by a snapshot, so its texture survives the client. */
    struct wlr_buffer *buffer;
    struct wlr_texture *texture;
    /* Position in the window's content coordinates, and size in logical pixels. */
    int x, y, width, height;
    /* The buffer's source box (viewporter crop) and transform. */
    struct wlr_fbox source;
    int transform;
    bool opaque_whole;
    /* A single opaque rectangle the client declared, in surface coordinates. */
    bool opaque_box_valid;
    struct wlr_box opaque_box;
};

enum window_type {
    WINDOW_XDG,
    WINDOW_XWAYLAND,
};

/* States a window's client is told of. */
enum window_state {
    WINDOW_FULLSCREEN,
    WINDOW_MAXIMIZED,
    WINDOW_ACTIVATED,
    WINDOW_RESIZING,
};

/* A client toplevel the director can place. */
struct window {
    struct server *server;
    struct wl_list link; /* server.windows */
    int references;
    uint64_t id;
    enum window_type type;
    struct wlr_xdg_toplevel *toplevel;
    struct wlr_xdg_toplevel_decoration_v1 *decoration;
    struct wlr_xwayland_surface *xsurface;
    struct wlr_surface *surface;
    bool mapped, alive;
    char *title, *app_id;
    struct window *parent;
    int min_width, min_height, max_width, max_height;

    /* Live director nodes presenting it, by id; the first configures it. */
    struct vec nodes; /* struct node * (referenced) */
    struct node *fallback;
    /* Last size and states sent, so each is sent once. */
    bool configured;
    int configured_width, configured_height;
    bool sent_fullscreen, sent_maximized, sent_activated;
    uint32_t sent_tiled;
    bool states_known;
    /* Outputs whose last frame showed it (bit per output index). */
    uint32_t outputs;
    uint64_t commit_count;
    /* The metadata last reported to the director. */
    struct strbuf report;
    /* What display items take from the surfaces besides their pixels. */
    uint64_t geometry;
    /* The last frame, kept while an exit animation may show it after the client
     * unmapped: retained buffers and the bounds they had. */
    struct vec snapshot; /* struct surface_draw */
    struct wlr_box snapshot_bounds;
    uint64_t snapshot_commit;
    /* The frame from before a resize, fading out under the new one while the box
     * presenting the window still moves to its new size: retained buffers, the bounds
     * they had, and the box's size when the new frame came. */
    struct vec fade; /* struct surface_draw */
    struct wlr_box fade_bounds;
    double fade_from_width, fade_from_height;
    struct wl_event_source *fade_release;

    /* xdg toplevels'; X11 windows listen through their xsurface. */
    struct wl_listener map, unmap, commit, destroy, request_move, request_resize, request_maximize,
        request_fullscreen, request_minimize, set_title, set_app_id, set_parent;
};

/* What lies under a pointer: a node, and the client or page it shows if any. */
struct hit {
    struct node *node;
    struct window *window; /* referenced */
    struct web_page *page;
    /* Output-logical point to node-local point, and to its parent's space. */
    struct mat3 inverse, parent_inverse;
    bool has_parent_inverse;
    /* Unsized hits accept the whole plane, as a background's does. */
    double width, height;
    bool sized;
    /* Node-local to client content coordinates, and the content's bounds. */
    struct mat3 content;
    struct wlr_box content_bounds;
    /* Output-logical rectangle outside which clipping ancestors hide the node. */
    bool clipped;
    struct box clip;
};

struct output {
    struct server *server;
    struct wl_list link; /* server.outputs */
    struct wlr_output *wlr_output;
    int index;
    /* Outputs form one horizontal row in logical pixels, in arrival order. */
    double offset;
    double width, height; /* logical */
    struct camera *camera;
    struct display *display;
    /* Reserved by the director's reserve nodes, in logical pixels. */
    double reserve_top, reserve_right, reserve_bottom, reserve_left;
    /* A frame is wanted; one is being rendered; another was asked for meanwhile. */
    bool frame_requested, rendering, next_frame;
    /* A frame was asked for and is not yet rendered: picking keeps to the hits of the
     * frame on screen until it is. */
    bool awaiting_frame;
    /* Frame pacing: the last vblank, the refresh, and what frames cost. */
    int64_t vblank, refresh, target_vblank;
    int64_t frame_cost, gpu_cost;
    int streak;
    struct wl_event_source *pace_timer, *idle_frame;
    /* Commits failed in a row, which back the retries off. */
    int failures;
    struct gpu_timer *gpu_timer;
    bool gpu_timer_checked;
    struct wl_listener frame, request_state, destroy, present, needs_frame, damage, commit;
};

/* Focus and modifiers of the one seat; pointer routing lives in input.c. */
struct seat_state {
    struct window *focused;
    struct vec history; /* struct window *, most recent first */
    struct web_page *focused_page;
    uint32_t modifiers; /* enum modifier bits */
    /* The director holds the keyboard: keys no shortcut takes go to it, not to clients. */
    bool keyboard_grabbed;
    /* The director hears of every press, scroll and gesture start, which go on as ever. */
    bool input_watched;
};

struct server {
    struct wl_display *wl_display;
    struct wl_event_loop *loop;
    const char *socket;
    struct wlr_backend *backend;
    struct wlr_session *session;
    struct wlr_renderer *wlr_renderer;
    struct wlr_allocator *allocator;
    struct wlr_compositor *compositor;
    struct wlr_output_layout *output_layout;
    struct wlr_xdg_shell *xdg_shell;
    struct wlr_xdg_activation_v1 *activation;
    struct wlr_seat *seat;
    struct wlr_cursor *cursor;
    struct wlr_xcursor_manager *xcursor_manager;
    struct wlr_relative_pointer_manager_v1 *relative_pointer;
    struct wlr_pointer_constraints_v1 *pointer_constraints;
    struct wlr_pointer_gestures_v1 *pointer_gestures;
    struct wlr_xwayland *xwayland;

    struct wl_list outputs;   /* struct output */
    struct wl_list windows;   /* struct window */
    struct wl_list keyboards; /* struct keyboard */
    struct wl_list xsurfaces; /* struct xsurface */
    struct wl_list pages;     /* struct stage_page */
    struct idmap windows_by_id;
    /* Windows that left but whose last frame an exiting node still shows. */
    struct idmap departed;
    uint64_t next_window_id;
    struct seat_state seat_state;

    /* The director's scene, and the cascade shown while it has none. */
    struct scene scene;
    struct scene fallback;
    /* Shaders the director defined, for either scene. */
    struct shaders shaders;
    struct vec cameras, bindings, shortcuts, reserves; /* struct node * of the scene */
    double advanced_at;
    char instance[32];

    struct renderer *renderer;
    struct link *link;
    struct media *media;
    struct wl_event_source *media_source;
    /* Text rasters the media worker is making, by raster slot. */
    struct idmap text_jobs;
    struct web *web;
    struct input *input;
    struct shares *share;
    struct clipboard *clipboard;

    /* Options. */
    bool damage_debug;
    /* PROSCENIUM_CHECK: compare every frame with a full redraw. */
    bool check;
    bool screen_sharing;

    struct wl_listener new_output, new_input, new_xdg_toplevel, new_xdg_popup, new_decoration,
        activation_request, cursor_motion, cursor_motion_absolute, cursor_button, cursor_axis,
        cursor_frame, swipe_begin, swipe_update, swipe_end, pinch_begin, pinch_update, pinch_end,
        hold_begin, hold_end, request_cursor, request_set_selection, request_set_primary_selection,
        request_start_drag, start_drag, new_constraint, xwayland_ready, xwayland_new_surface,
        cursor_shape_request, new_surface;
};

/* Windows. */
struct window *window_create(struct server *server, enum window_type type);
void window_ref(struct window *window);
void window_unref(struct window *window);
struct window *window_by_id(struct server *server, uint64_t id);
/* Content bounds: the xdg geometry, or the root surface; the last frame's once gone. */
struct wlr_box window_bounds(struct window *window);
bool window_presentable(struct window *window);
/* The surfaces to draw now, in paint order; the snapshot for a window that left. */
void window_surfaces(struct window *window, struct vec *out);
/* Where SURFACE, one of WINDOW's, lies in its content coordinates; false when it is not. */
bool window_surface_offset(struct window *window, struct wlr_surface *surface, int *x, int *y);
void window_mapped(struct window *window);
void window_unmapped(struct window *window);
void window_destroyed(struct window *window);
/* The client committed COMMITTED, or (NULL) the window gained or lost a surface: damage,
 * geometry, snapshots and outputs follow. */
void window_committed(struct window *window, struct wlr_surface *committed);
void window_configure(struct window *window);
void window_set_resizing(struct window *window, bool resizing);
void window_close(struct window *window);
void window_send_frame_done(struct window *window, const struct timespec *now);
/* A request from the client, delivered to the window's node as an event, or applied. */
void window_request(struct window *window, enum event_name event, bool value, uint32_t edges);
/* Tell the director of the window's metadata, if it changed since last told. */
void window_report(struct window *window);
void windows_sync_fallback(struct server *server);
void window_set_outputs(struct window *window, uint32_t outputs);
void windows_forget_output(struct server *server, struct output *output);
void window_release_snapshot(struct window *window);
/* A surface of WINDOW is about to apply a commit, or to go: its frame is held when the
 * commit replaces it with one of a new size mid-resize, or withdraws it before an exit. */
void window_client_commit(struct window *window, struct wlr_surface *surface);
void window_surface_destroying(struct window *window);
/* How far WINDOW's resize crossfade has come, 0..1; 1 when none runs. */
double window_fade_progress(struct window *window);
/* The crossfade is over: its frame goes once this frame is drawn. */
void window_fade_finished(struct window *window);
/* The surface at content point (X, Y) and the point within it, or NULL. */
struct wlr_surface *window_surface_at(struct window *window, double x, double y, double *sx,
                                      double *sy);
void windows_sweep_departed(struct server *server);
/* The window NODE presents, alive or departed. */
struct window *window_for_node(struct server *server, const struct node *node);
bool window_natural_size(struct window *window, double *width, double *height);
/* The largest scale of the outputs showing the window; 0 on none. */
double window_scale(struct window *window);

/* Focus. */
void focus_window(struct server *server, struct window *window);
void focus_page(struct server *server, struct web_page *page);
bool window_focusable(struct window *window);
void keyboard_sync_focus(struct server *server);

/* xdg.c */
void xdg_init(struct server *server);
void xdg_finish(struct server *server);

/* xwayland.c */
typedef void (*wlr_surface_iterator_func_t)(struct wlr_surface *surface, int sx, int sy,
                                            void *data);
void xwayland_init(struct server *server);
void xwayland_finish(struct server *server);
struct window *xwayland_window_of(struct wlr_xwayland_surface *xsurface);
/* Override-redirect children of WINDOW, in its content coordinates. */
void xwayland_child_surfaces(struct window *window, wlr_surface_iterator_func_t iterator,
                             void *data);
struct wlr_surface *xwayland_surface_at(struct window *window, double x, double y, double *sx,
                                        double *sy);
void xwayland_configure(struct window *window, int width, int height);
void xwayland_set_state(struct window *window, enum window_state state, bool value);

/* clipboard.c */
void clipboard_init(struct server *server);
void clipboard_finish(struct server *server);

/* Outputs. */
void outputs_init(struct server *server);
void outputs_finish(struct server *server);
struct output *output_by_name(struct server *server, const char *name);
struct output *output_first(struct server *server);
struct output *output_at(struct server *server, double layout_x, double layout_y);
void output_request_frame(struct output *output);
void request_frames(struct server *server);
void output_describe(struct output *output, struct json_writer *writer);
const char *output_name(struct output *output);
void outputs_update_reservations(struct server *server);

/* The scene. */
void scene_changed(struct server *server);
void invalidate_displays(struct server *server);
/* Sample motion at TIME and keep frames coming while anything moves. */
void server_advance(struct server *server, double time);
/* stage.c: rebuild everything indexed from the scene after it or the windows changed. */
void stage_reindex(struct server *server);
/* The size a node draws at: sized nodes their size, windows their natural one. */
void node_size(struct server *server, const struct node *node, double *width, double *height);

/* Director link. */
bool link_connected(struct server *server);

/* main.c */
/* Make the compositor's EGL context current; false when it cannot be. */
bool server_gl_current(struct server *server);
