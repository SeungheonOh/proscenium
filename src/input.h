/*
 * Seat input routing, resolved synchronously against the last presented hit
 * list, so clients never wait for the director. Windows and pages receive their
 * input directly; compositor-drawn nodes and bindings turn it into director
 * events. A node or binding receiving a press captures the pointer until every
 * button is released, as DOM pointer capture does.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "server.h"

struct wlr_surface;

void input_init(struct server *server);
/* Stop hearing of new devices, before the backend goes. */
void input_detach_backend(struct server *server);
void input_finish(struct server *server);
/* Offer virtual pointers and keyboards, as test drivers use: to every client, or with
 * DRIVE_ONLY to the proscenium-drive beside this binary alone. */
void input_enable_virtual_devices(struct server *server, bool drive_only);
/* Attach DEVICE, a keyboard or a pointer, as the backend's own devices are. */
struct wlr_input_device;
void input_add_device(struct server *server, struct wlr_input_device *device);

/* The output under the pointer and the pointer's output-logical coordinates. */
struct output *input_pointer_output(struct server *server, double *x, double *y);
void input_clamp_pointer(struct server *server);
void input_center_pointer(struct server *server, struct output *output);
/* Move the pointer to output-logical (X, Y) on OUTPUT, as if it had moved there. */
void input_warp_pointer(struct server *server, struct output *output, double x, double y);

/* A pointer event an agent sends a window, for input_inject. */
struct injected {
    enum { INJECT_MOTION, INJECT_BUTTON, INJECT_WHEEL } kind;
    /* Motion: where, in the window's own logical pixels from its top left. */
    double x, y;
    /* Button: its evdev code, and whether it goes down or up. */
    uint32_t button;
    bool pressed;
    /* Wheel: notches, down positive. */
    double notches;
};
/* Pointer EVENTS an agent sends straight to WINDOW, shown or not and wherever the real
 * pointer is: the seat's pointer enters the window's surface under each point for them
 * and goes back to what the real pointer is over after. A press focuses the window.
 * Either way the window keeps drawing a while, as a shared one does, so what the agent
 * did, or typed, reaches its pixels where no output shows it. Refused while the real
 * pointer holds a button, a grab or a drag. */
bool input_inject(struct server *server, struct window *window, const struct injected *events,
                  int count, struct protocol_error *error);
/* After the scene moved under a still pointer on OUTPUT: enter and leave what it is
 * over now. Motion waits for the pointer to move. */
void input_repick(struct server *server, struct output *output);
/* Replace the shortcut table from the scene's shortcut nodes. */
void input_install_shortcuts(struct server *server);
/* Drop captures and gestures owned by a director that went away. */
void input_release_director(struct server *server);
/* While GRAB, keys no shortcut takes go to the director instead of clients and pages. */
void input_grab_keyboard(struct server *server, bool grab);
void input_forget_window(struct server *server, struct window *window);
void input_forget_page(struct server *server, struct web_page *page);
void input_node_dead(struct server *server, struct node *node);
/* A client asked to move or resize WINDOW, presented by NODE. */
void input_client_move_request(struct server *server, struct window *window, struct node *node,
                               bool move, uint32_t edges);
/* A surface that is no window's committed: a cursor or a drag icon may have changed. */
void input_surface_committed(struct server *server, struct wlr_surface *surface);
void input_surface_destroyed(struct server *server, struct wlr_surface *surface);
/* The drag icon to draw on OUTPUT and where, in output-logical pixels. */
bool input_drag_icon(struct server *server, struct output *output, struct wlr_surface **icon,
                     double *x, double *y);
/* Where the pointer's or the gesture's manipulation is kept. */
struct manipulation **input_manipulation_slot(struct server *server, bool gesture);

/* Node targets. */
/* NODE or its nearest ancestor that direct manipulation may move. */
struct node *move_target(const struct node *node);
/* Whether NODE takes the pointer instead of passing it through. */
bool node_input_target(const struct node *node);

/* manip.c: native manipulations driven by the pointer or a gesture. */
enum manipulation_kind {
    MANIPULATION_PAN,
    MANIPULATION_ZOOM,
    MANIPULATION_MOVE,
    MANIPULATION_RESIZE,
};

struct manipulation {
    enum manipulation_kind kind;
    struct output *output;
    struct node *node;     /* referenced */
    struct window *window; /* referenced */
    /* xdg_toplevel resize edges: top 1, bottom 2, left 4, right 8. */
    uint32_t edges;
    double origin_x, origin_y, origin_width, origin_height;
    /* The pointer at the start, in the node's parent space; on its own plane for resizes. */
    double anchor_x, anchor_y;
    /* For resizes: the node's local matrix then, and output points onto its plane then. */
    struct mat4 frame;
    struct mat3 to_local;
    /* Previous screen point for pans, or pinch scale for zooms. */
    double last_x, last_y;
    /* Recent (time, x, y) screen samples, newest last. */
    double samples[32][3];
    int sample_count;
    /* The binding or node whose press started it, told about the release. */
    struct node *source; /* referenced */
};

struct manipulation *manipulation_begin_pan(struct server *server, struct output *output);
struct manipulation *manipulation_begin_move(struct server *server, struct node *node);
struct manipulation *manipulation_begin_resize(struct server *server, struct node *node,
                                               struct window *window, uint32_t edges);
void manipulation_update(struct server *server);
void manipulation_end(struct server *server);
void manipulation_free(struct manipulation *manipulation);
/* OUTPUT is going away: manipulations on it end, their buttons captured by whoever
 * started them. */
void input_forget_output(struct server *server, struct output *output);
/* Resize from the corner nearest a node-local point, as Hyprland and sway do. */
uint32_t resize_edges(double local_x, double local_y, double width, double height);
void wheel_zoom(struct server *server, double delta, bool wheel);
void wheel_pan(struct server *server, bool horizontal, double delta);
void gesture_manipulation_begin(struct server *server, int action);
void gesture_manipulation_update(struct server *server, double dx, double dy, double scale);
void gesture_manipulation_end(struct server *server, bool cancelled);
