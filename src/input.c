/*
 * Seat input routing.
 *
 * Input is resolved synchronously against the last presented hit list, so
 * clients never wait for the director. Windows and pages receive their input
 * directly; compositor-drawn nodes and bindings turn input into director events.
 * The cursor is wlroots', on a hardware plane where the output has one, so
 * pointer motion over a still scene costs no frame.
 */
#define _GNU_SOURCE
#include "input.h"

#include <linux/input-event-codes.h>
#include <math.h>
#include <stdio.h>
#include <strings.h>
#include <libinput.h>
#include <wlr/backend/libinput.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_cursor_shape_v1.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_input_device.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer.h>
#include <wlr/types/wlr_pointer_constraints_v1.h>
#include <wlr/types/wlr_pointer_gestures_v1.h>
#include <wlr/types/wlr_relative_pointer_v1.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_virtual_keyboard_v1.h>
#include <wlr/types/wlr_virtual_pointer_v1.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon.h>

#include "display.h"
#include "link.h"
#include "stage.h"
#include "web.h"

/* Held shortcut keys repeat as GNOME's keyboard does: after half a second, 33 a second. */
#define REPEAT_DELAY 500
#define REPEAT_INTERVAL 30

enum button_kind {
    BUTTON_MANIPULATION,
    BUTTON_CAPTURE,
    BUTTON_CLIENT,
};

struct button {
    uint32_t code;
    enum button_kind kind;
    struct hit hit; /* a client's, holding an implicit grab */
};

struct keyboard {
    struct wl_list link;
    struct server *server;
    struct wlr_keyboard *wlr_keyboard;
    struct wl_listener key, modifiers, destroy;
};

struct shortcut {
    struct node *node; /* referenced */
    char key[64];
    /* Digits bind by position, as Shift changes their keysym: evdev KEY_1..KEY_0. */
    uint32_t physical;
    uint32_t modifiers;
    bool repeat;
};

struct pressed_key {
    uint32_t keycode;
    struct node *shortcut; /* referenced; NULL for a key forwarded */
    bool repeat;
};

struct input {
    struct server *server;
    struct hit hovered;
    bool has_hovered;
    struct node *entered; /* referenced */
    struct node *capture; /* referenced */
    struct button buttons[16];
    int button_count;
    struct node *gesture; /* referenced binding receiving gesture events */
    /* The output the drag icon was last drawn on. */
    struct output *drag_output;
    /* The gesture under way went to the director, not to clients. */
    bool gesture_taken;
    struct manipulation *manipulation, *gesture_manipulation;
    /* The surface a client button was pressed on, which motion and releases go to
     * until every client button is up. */
    struct wlr_surface *grab_surface;

    /* The cursor its client set, by surface or by shape, and what is shown now. */
    bool client_cursor_set;
    struct wlr_surface *client_cursor;
    const char *client_cursor_shape;
    int hotspot_x, hotspot_y;
    const char *shown_name;
    /* The theme's cursor for each shape, once looked up. */
    const char *shape_names[CURSOR_COUNT];
    struct wlr_surface *shown_surface;
    bool shown_hidden;

    struct vec shortcuts; /* struct shortcut */
    struct vec pressed;   /* struct pressed_key */
    struct wl_event_source *repeat_timer;
    struct node *repeating;
    uint32_t repeat_keycode;

    struct wlr_drag *drag;
    struct wl_listener drag_destroy;
    struct wlr_pointer_constraint_v1 *constraint;
    struct wl_listener constraint_destroy;
    struct web_page *keyboard_page;
    bool virtual_devices;
    struct wl_listener virtual_keyboard, virtual_pointer;
};

static struct input *input_of(struct server *server) {
    return server->input;
}

static void sync_constraint(struct server *server);

/* Layout. */

struct output *input_pointer_output(struct server *server, double *x, double *y) {
    struct output *output = output_at(server, server->cursor->x, server->cursor->y);
    *x = *y = 0;
    if (!output) return NULL;
    *x = server->cursor->x - output->offset;
    *y = server->cursor->y;
    return output;
}

void input_clamp_pointer(struct server *server) {
    struct output *output = output_at(server, server->cursor->x, server->cursor->y);
    if (!output) return;
    double x = CLAMP(server->cursor->x, output->offset, output->offset + output->width - 1e-6);
    double y = CLAMP(server->cursor->y, 0.0, output->height - 1e-6);
    wlr_cursor_warp_closest(server->cursor, NULL, x, y);
}

void input_center_pointer(struct server *server, struct output *output) {
    wlr_cursor_warp_closest(server->cursor, NULL, output->offset + output->width / 2,
                            output->height / 2);
}

/* Picking. */

static void hit_local(const struct hit *hit, double x, double y, double *lx, double *ly) {
    mat3_apply(hit->inverse, x, y, lx, ly);
}

/* Output-logical point (X, Y) in the content of HIT's window or page. */
static void hit_content(const struct hit *hit, double x, double y, double *cx, double *cy) {
    double lx, ly;
    hit_local(hit, x, y, &lx, &ly);
    mat3_apply(hit->content, lx, ly, cx, cy);
}

static bool hit_accepts(const struct hit *hit, double x, double y) {
    if (hit->clipped && !(x >= hit->clip.x && x <= box_right(hit->clip) && y >= hit->clip.y &&
                          y <= box_bottom(hit->clip)))
        return false;
    double lx, ly;
    hit_local(hit, x, y, &lx, &ly);
    if (hit->window || hit->page) {
        double cx, cy;
        hit_content(hit, x, y, &cx, &cy);
        const struct wlr_box *b = &hit->content_bounds;
        if (!(cx >= b->x && cx <= b->x + b->width && cy >= b->y && cy <= b->y + b->height))
            return false;
        if (hit->page) return true;
        double sx, sy;
        return window_presentable(hit->window) && window_surface_at(hit->window, cx, cy, &sx, &sy);
    }
    /* A background is an infinite plane; sized nodes accept their own box. */
    return !hit->sized || (lx >= 0 && lx <= hit->width && ly >= 0 && ly <= hit->height);
}

static bool no_node(const struct node *node) {
    return false;
}

/* The topmost hit under the pointer that is a client or satisfies WANTS. */
static struct hit *pick(struct server *server, bool (*wants)(const struct node *)) {
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    if (!output) return NULL;
    size_t count;
    struct hit *hits = display_hits(output, &count);
    for (size_t i = 0; i < count; i++) {
        struct hit *hit = &hits[i];
        if (!(hit->window || hit->page) && !wants(hit->node)) continue;
        /* Hits may be a frame old: their node may be gone. */
        if (hit->node && hit->node->state != NODE_LIVE) continue;
        if (hit_accepts(hit, x, y)) return hit;
    }
    return NULL;
}

/* Director events. */

static void pointer_payload(struct server *server, struct json_writer *w, const struct hit *hit) {
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    if (!output) return;
    double world_x, world_y;
    camera_world_point(output, x, y, &world_x, &world_y);
    json_key(w, "output");
    json_string(w, output_name(output));
    json_key(w, "screen-x");
    json_number(w, x);
    json_key(w, "screen-y");
    json_number(w, y);
    json_key(w, "world-x");
    json_number(w, world_x);
    json_key(w, "world-y");
    json_number(w, world_y);
    json_key(w, "modifiers");
    modifiers_write(server->seat_state.modifiers, w);
    if (!hit) return;
    double lx, ly, px = x, py = y;
    hit_local(hit, x, y, &lx, &ly);
    if (hit->has_parent_inverse) mat3_apply(hit->parent_inverse, x, y, &px, &py);
    json_key(w, "x");
    json_number(w, px);
    json_key(w, "y");
    json_number(w, py);
    json_key(w, "local-x");
    json_number(w, lx);
    json_key(w, "local-y");
    json_number(w, ly);
}

/* NAME, a pointer event, as NODE receives it: bindings get down, move and up. */
static enum event_name pointer_event_name(const struct node *node, enum event_name name) {
    if (node->kind != KIND_POINTER_BINDING) return name;
    switch (name) {
    case EVENT_POINTERDOWN: return EVENT_DOWN;
    case EVENT_POINTERMOVE: return EVENT_MOVE;
    case EVENT_POINTERUP: return EVENT_UP;
    default: return name;
    }
}

static void emit_pointer(struct server *server, struct node *node, enum event_name name, int button,
                         const struct hit *hit) {
    struct event event;
    if (!event_begin(server, &event, node, name)) return;
    if (button >= 0) {
        json_key(&event.writer, "button");
        json_int(&event.writer, button);
    }
    pointer_payload(server, &event.writer, hit);
    event_end(server, &event);
}

/* NODE's hit as presented now, which may have moved since a press. */
static struct hit *node_hit(struct server *server, const struct node *node) {
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    if (!output || !node) return NULL;
    size_t count;
    struct hit *hits = display_hits(output, &count);
    for (size_t i = 0; i < count; i++) {
        if (hits[i].node == node) return &hits[i];
    }
    return NULL;
}

static struct hit *capture_hit(struct server *server) {
    return node_hit(server, input_of(server)->capture);
}

static void emit_capture(struct server *server, enum event_name name, int button) {
    struct input *in = input_of(server);
    if (in->capture)
        emit_pointer(server, in->capture, pointer_event_name(in->capture, name), button,
                     capture_hit(server));
}

static struct window *window_under(struct server *server) {
    struct hit *hit = pick(server, no_node);
    return hit ? hit->window : NULL;
}

static void set_ref(struct node **slot, struct node *node) {
    if (node) node_ref(node);
    if (*slot) node_unref(*slot);
    *slot = node;
}

static void copy_hit(struct hit *out, const struct hit *hit) {
    *out = *hit;
    if (out->node) node_ref(out->node);
    if (out->window) window_ref(out->window);
}

static void clear_hit(struct hit *hit) {
    if (hit->node) node_unref(hit->node);
    if (hit->window) window_unref(hit->window);
    *hit = (struct hit){0};
}

/* Client pointer focus. */

static bool drag_active(struct server *server) {
    return input_of(server)->drag != NULL;
}

/* The client hit holding an implicit grab because one of its buttons is pressed. */
static struct hit *client_grab(struct input *in) {
    for (int i = 0; i < in->button_count; i++) {
        if (in->buttons[i].kind == BUTTON_CLIENT) return &in->buttons[i].hit;
    }
    return NULL;
}

/* A grab follows its window as presented now, which may have moved since the press. */
static const struct hit *current_grab(struct server *server, const struct hit *grab) {
    const struct hit *now = node_hit(server, grab->node);
    return now && now->window == grab->window && now->page == grab->page ? now : grab;
}

static uint32_t time_msec(void) {
    return (uint32_t)(now_nanoseconds() / 1000000);
}

/* The pointer in HIT's content coordinates; with CLAMP, kept inside the content, as a
 * page held by a press sees it. */
static void content_point(struct server *server, const struct hit *hit, bool clamp, double *cx,
                          double *cy) {
    double x, y;
    input_pointer_output(server, &x, &y);
    hit_content(hit, x, y, cx, cy);
    if (!clamp) return;
    const struct wlr_box *b = &hit->content_bounds;
    *cx = CLAMP(*cx, (double)b->x, b->x + b->width - 1e-6);
    *cy = CLAMP(*cy, (double)b->y, b->y + b->height - 1e-6);
}

/* Pointer motion for HIT's client; with GRAB, to the surface its press went to,
 * wherever the pointer is. */
static void deliver_motion(struct server *server, const struct hit *hit, bool grab) {
    struct input *in = input_of(server);
    double x, y, cx, cy;
    if (!input_pointer_output(server, &x, &y)) return;
    if (hit->page) {
        content_point(server, hit, grab, &cx, &cy);
        web_page_pointer_motion(hit->page, cx, cy);
        return;
    }
    hit_content(hit, x, y, &cx, &cy);
    if (!hit->window || !window_presentable(hit->window)) return;
    double sx, sy;
    struct wlr_surface *surface;
    int ox, oy;
    if (grab && in->grab_surface &&
        window_surface_offset(hit->window, in->grab_surface, &ox, &oy)) {
        surface = in->grab_surface;
        sx = cx - ox;
        sy = cy - oy;
    } else {
        surface = window_surface_at(hit->window, cx, cy, &sx, &sy);
    }
    if (!surface) return;
    if (surface != server->seat->pointer_state.focused_surface)
        wlr_seat_pointer_notify_enter(server->seat, surface, sx, sy);
    wlr_seat_pointer_notify_motion(server->seat, time_msec(), sx, sy);
}

static bool same_client(const struct hit *a, const struct hit *b) {
    return a->window == b->window && a->page == b->page;
}

/* Move pointer focus to HIT's client, or clear it. */
static void set_hovered(struct server *server, const struct hit *hit) {
    struct input *in = input_of(server);
    bool changed = in->has_hovered != (hit != NULL) || (hit && !same_client(&in->hovered, hit));
    if (changed) {
        /* A newly entered client sets its own cursor. */
        in->client_cursor_set = false;
        in->client_cursor = NULL;
        in->client_cursor_shape = NULL;
        if (in->has_hovered && in->hovered.page) web_page_pointer_leave(in->hovered.page);
    }
    if (in->has_hovered) clear_hit(&in->hovered);
    in->has_hovered = hit != NULL;
    if (hit) copy_hit(&in->hovered, hit);
    /* Away from windows no client keeps the pointer; entering one moves it there. */
    if ((!hit || !hit->window) && !drag_active(server) && !client_grab(in) &&
        server->seat->pointer_state.focused_surface)
        wlr_seat_pointer_notify_clear_focus(server->seat);
}

/* Send pointerleave and pointerenter as the topmost node under the pointer changes;
 * each names the other, so the director can tell which ancestors the pointer crossed. */
static void set_entered(struct server *server, struct node *node) {
    struct input *in = input_of(server);
    struct node *old = in->entered;
    if (old == node) return;
    if (old) node_ref(old);
    set_ref(&in->entered, node);
    struct event event;
    if (old && old->state == NODE_LIVE && event_begin(server, &event, old, EVENT_POINTERLEAVE)) {
        json_key(&event.writer, "to");
        if (node) json_int(&event.writer, node->id);
        else json_null(&event.writer);
        pointer_payload(server, &event.writer, NULL);
        event_end(server, &event);
    }
    if (node && event_begin(server, &event, node, EVENT_POINTERENTER)) {
        json_key(&event.writer, "from");
        if (old) json_int(&event.writer, old->id);
        else json_null(&event.writer);
        pointer_payload(server, &event.writer, NULL);
        event_end(server, &event);
    }
    if (old) node_unref(old);
}

/* Whether a pointer button pressed on WINDOW is still held. */
static bool input_window_pressed(struct server *server, struct window *window) {
    struct input *in = input_of(server);
    for (int i = 0; i < in->button_count; i++) {
        if (in->buttons[i].kind == BUTTON_CLIENT && in->buttons[i].hit.window == window)
            return true;
    }
    return false;
}

/* The manipulation lost what it moved or where: the rest of the press goes to whoever
 * started it, so a binding that heard its press still hears the release. With STOP it
 * ends where it is, telling nobody, as a pan whose output is gone. */
static void manipulation_lost(struct server *server, bool stop) {
    struct input *in = input_of(server);
    struct node *source = in->manipulation->source;
    if (source) node_ref(source);
    if (stop) {
        manipulation_free(in->manipulation);
        in->manipulation = NULL;
    } else {
        manipulation_end(server);
    }
    if (source && source->state == NODE_LIVE) {
        set_ref(&in->capture, source);
        for (int i = 0; i < in->button_count; i++) {
            if (in->buttons[i].kind == BUTTON_MANIPULATION) in->buttons[i].kind = BUTTON_CAPTURE;
        }
    }
    if (source) node_unref(source);
}

static void input_update_cursor(struct server *server);

static void pointer_moved(struct server *server) {
    struct input *in = input_of(server);
    if (in->manipulation && in->manipulation->node && in->manipulation->node->state != NODE_LIVE)
        manipulation_lost(server, false);
    if (in->manipulation) {
        manipulation_update(server);
    } else if (in->capture) {
        emit_capture(server, EVENT_POINTERMOVE, -1);
    } else if (client_grab(in) && !drag_active(server)) {
        deliver_motion(server, current_grab(server, client_grab(in)), true);
    } else {
        struct hit *hit = pick(server, node_input_target);
        set_entered(server, hit ? hit->node : NULL);
        if (hit && (hit->window || hit->page)) {
            set_hovered(server, hit);
            deliver_motion(server, hit, false);
        } else {
            set_hovered(server, NULL);
            if (hit) emit_pointer(server, hit->node, EVENT_POINTERMOVE, -1, hit);
        }
    }
    input_update_cursor(server);
    sync_constraint(server);
}

void input_repick(struct server *server, struct output *output) {
    struct input *in = input_of(server);
    double x, y;
    if (input_pointer_output(server, &x, &y) != output) return;
    if (in->capture || in->manipulation || in->button_count) return;
    struct hit *hit = pick(server, node_input_target);
    bool client = hit && (hit->window || hit->page);
    bool entering = client && !(in->has_hovered && same_client(&in->hovered, hit));
    set_entered(server, hit ? hit->node : NULL);
    set_hovered(server, client ? hit : NULL);
    if (entering) deliver_motion(server, hit, false);
    input_update_cursor(server);
    sync_constraint(server);
}

static void revalidate_pointer(struct server *server) {
    struct input *in = input_of(server);
    if (in->capture || in->manipulation || client_grab(in)) return;
    pointer_moved(server);
}

/* A client is gone: buttons pressed on it and hovering it end. True when it was hovered. */
static bool forget_client(struct input *in, struct window *window, struct web_page *page) {
    for (int i = 0; i < in->button_count;) {
        struct hit *hit = &in->buttons[i].hit;
        if (in->buttons[i].kind == BUTTON_CLIENT && hit->window == window && hit->page == page) {
            clear_hit(hit);
            in->buttons[i] = in->buttons[--in->button_count];
        } else {
            i++;
        }
    }
    if (!client_grab(in)) in->grab_surface = NULL;
    if (!in->has_hovered || in->hovered.window != window || in->hovered.page != page) return false;
    clear_hit(&in->hovered);
    in->has_hovered = false;
    return true;
}

void input_forget_window(struct server *server, struct window *window) {
    /* An unmapped surface keeps the seat's focus until it is destroyed. */
    if (forget_client(input_of(server), window, NULL) && !drag_active(server))
        wlr_seat_pointer_notify_clear_focus(server->seat);
}

void input_forget_page(struct server *server, struct web_page *page) {
    struct input *in = input_of(server);
    forget_client(in, NULL, page);
    if (in->keyboard_page == page) in->keyboard_page = NULL;
}

void input_node_dead(struct server *server, struct node *node) {
    struct input *in = input_of(server);
    if (!in) return;
    if (in->entered == node) set_ref(&in->entered, NULL);
}

void input_release_director(struct server *server) {
    struct input *in = input_of(server);
    if (in->capture) {
        set_ref(&in->capture, NULL);
        for (int i = 0; i < in->button_count;) {
            if (in->buttons[i].kind == BUTTON_CAPTURE)
                in->buttons[i] = in->buttons[--in->button_count];
            else i++;
        }
    }
    set_ref(&in->gesture, NULL);
    set_ref(&in->entered, NULL);
}

/* Bindings. */

static bool modifiers_match(const struct node *node, uint32_t held) {
    return node_prop(node, PROP_MODIFIERS)->modifiers == held;
}

static struct node *find_binding(struct server *server, enum node_kind kind,
                                 bool (*predicate)(const struct node *node, const void *data),
                                 const void *data) {
    if (!link_connected(server)) return NULL;
    VEC_FOR(&server->bindings, struct node *, slot) {
        struct node *node = *slot;
        if (node->kind == kind && modifiers_match(node, server->seat_state.modifiers) &&
            (!predicate || predicate(node, data)))
            return node;
    }
    return NULL;
}

static bool button_matches(const struct node *node, const void *data) {
    return node_prop(node, PROP_BUTTON)->id == *(const uint32_t *)data;
}

static struct button *add_button(struct input *in, uint32_t code, enum button_kind kind) {
    for (int i = 0; i < in->button_count; i++) {
        if (in->buttons[i].code == code) {
            if (in->buttons[i].kind == BUTTON_CLIENT) clear_hit(&in->buttons[i].hit);
            in->buttons[i].kind = kind;
            return &in->buttons[i];
        }
    }
    if (in->button_count == (int)ARRAY_LENGTH(in->buttons)) return NULL;
    struct button *button = &in->buttons[in->button_count++];
    *button = (struct button){.code = code, .kind = kind};
    return button;
}

/* Start ACTION natively for HIT under the pointer; NULL when it cannot. */
static struct manipulation *begin_action(struct server *server, int action, struct hit *hit) {
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    switch (action) {
    case ACTION_PAN: return output ? manipulation_begin_pan(server, output) : NULL;
    case ACTION_MOVE: {
        struct node *target = hit ? move_target(hit->node) : NULL;
        return target ? manipulation_begin_move(server, target) : NULL;
    }
    case ACTION_RESIZE: {
        struct node *node = hit && hit->window ? hit->node : NULL;
        if (!node || !node_bool(node, PROP_RESIZABLE)) return NULL;
        double lx, ly;
        hit_local(hit, x, y, &lx, &ly);
        return manipulation_begin_resize(server, node, hit->window,
                                         resize_edges(lx, ly, hit->width, hit->height));
    }
    default: return NULL;
    }
}

/* Route button CODE's release to MANIPULATION, or SOURCE's captured events. */
static void start_pointer_target(struct server *server, uint32_t code, struct node *source,
                                 struct manipulation *manipulation) {
    struct input *in = input_of(server);
    if (manipulation) {
        if (source) node_ref(source);
        manipulation->source = source;
        add_button(in, code, BUTTON_MANIPULATION);
    } else {
        set_ref(&in->capture, source);
        add_button(in, code, BUTTON_CAPTURE);
    }
}

static void press_binding(struct server *server, struct node *binding, uint32_t code) {
    struct hit *hit = pick(server, node_input_target);
    struct window *window = hit ? hit->window : NULL;
    uint64_t window_id = window ? window->id : 0;
    struct hit copy;
    if (hit) copy_hit(&copy, hit);
    set_hovered(server, NULL);
    start_pointer_target(
        server, code, binding,
        begin_action(server, node_choice(binding, PROP_ACTION), hit ? &copy : NULL));
    if (hit) clear_hit(&copy);
    struct event event;
    if (event_begin(server, &event, binding, EVENT_DOWN)) {
        json_key(&event.writer, "button");
        json_int(&event.writer, code);
        json_key(&event.writer, "window");
        if (window_id) json_int(&event.writer, (int64_t)window_id);
        else json_null(&event.writer);
        pointer_payload(server, &event.writer, NULL);
        event_end(server, &event);
    }
}

/* A button for HIT's client; with GRAB, to the surface the grab holds. */
static void deliver_button(struct server *server, const struct hit *hit, uint32_t code,
                           bool pressed, bool grab) {
    deliver_motion(server, hit, grab);
    if (hit->page) {
        double cx, cy;
        content_point(server, hit, true, &cx, &cy);
        web_page_pointer_button(hit->page, cx, cy, code, pressed);
        return;
    }
    wlr_seat_pointer_notify_button(server->seat, time_msec(), code,
                                   pressed ? WL_POINTER_BUTTON_STATE_PRESSED
                                           : WL_POINTER_BUTTON_STATE_RELEASED);
}

static void press_scene(struct server *server, uint32_t code) {
    struct input *in = input_of(server);
    struct hit *hit = pick(server, node_input_target);
    if (!hit) return;
    if (hit->window || hit->page) {
        if (hit->window) {
            if (window_focusable(hit->window)) focus_window(server, hit->window);
        } else if (node_bool(hit->node, PROP_FOCUSABLE)) {
            focus_page(server, hit->page);
        }
        struct hit copy;
        copy_hit(&copy, hit);
        struct button *button = add_button(in, code, BUTTON_CLIENT);
        if (button) copy_hit(&button->hit, &copy);
        set_hovered(server, &copy);
        deliver_button(server, &copy, code, true, false);
        if (copy.window) in->grab_surface = server->seat->pointer_state.focused_surface;
        clear_hit(&copy);
        return;
    }
    struct node *node = hit->node;
    struct manipulation *manipulation = NULL;
    if (node->kind == KIND_BACKGROUND) {
        double x, y;
        struct output *output = input_pointer_output(server, &x, &y);
        if (node_bool(node, PROP_PAN) && output)
            manipulation = manipulation_begin_pan(server, output);
    } else {
        struct node *target = move_target(node);
        if (target) manipulation = manipulation_begin_move(server, target);
    }
    struct hit copy;
    copy_hit(&copy, hit);
    set_hovered(server, NULL);
    start_pointer_target(server, code, node, manipulation);
    emit_pointer(server, node, EVENT_POINTERDOWN, (int)code, &copy);
    clear_hit(&copy);
}

static void press(struct server *server, uint32_t code) {
    struct input *in = input_of(server);
    if (in->manipulation) {
        add_button(in, code, BUTTON_MANIPULATION);
    } else if (in->capture) {
        add_button(in, code, BUTTON_CAPTURE);
        emit_capture(server, EVENT_POINTERDOWN, (int)code);
    } else if (in->button_count) {
        /* Further buttons follow the window that already holds the grab. */
        struct hit *grab = client_grab(in);
        if (grab) {
            struct hit copy;
            copy_hit(&copy, current_grab(server, grab));
            struct button *button = add_button(in, code, BUTTON_CLIENT);
            if (button) copy_hit(&button->hit, &copy);
            deliver_button(server, &copy, code, true, true);
            clear_hit(&copy);
        }
    } else {
        struct node *binding = find_binding(server, KIND_POINTER_BINDING, button_matches, &code);
        if (binding) press_binding(server, binding, code);
        else press_scene(server, code);
    }
}

static void release(struct server *server, uint32_t code) {
    struct input *in = input_of(server);
    struct button target = {0};
    bool found = false;
    for (int i = 0; i < in->button_count; i++) {
        if (in->buttons[i].code == code) {
            target = in->buttons[i];
            in->buttons[i] = in->buttons[--in->button_count];
            found = true;
            break;
        }
    }
    if (found && target.kind == BUTTON_MANIPULATION) {
        if (!in->button_count && in->manipulation) {
            struct node *source = in->manipulation->source;
            if (source) node_ref(source);
            manipulation_end(server);
            if (source) {
                emit_pointer(server, source, pointer_event_name(source, EVENT_POINTERUP), (int)code,
                             NULL);
                node_unref(source);
            }
        }
    } else if (found && target.kind == BUTTON_CAPTURE) {
        emit_capture(server, EVENT_POINTERUP, (int)code);
        if (!in->button_count) set_ref(&in->capture, NULL);
    } else if (found && target.kind == BUTTON_CLIENT) {
        bool live = target.hit.page || (target.hit.window && window_presentable(target.hit.window));
        if (live) deliver_button(server, current_grab(server, &target.hit), code, false, true);
        clear_hit(&target.hit);
        if (!client_grab(in)) in->grab_surface = NULL;
    } else if (drag_active(server) || server->seat->pointer_state.focused_surface) {
        wlr_seat_pointer_notify_button(server->seat, time_msec(), code,
                                       WL_POINTER_BUTTON_STATE_RELEASED);
    }
    if (!in->button_count) revalidate_pointer(server);
}

/* Shortcuts. */

void input_install_shortcuts(struct server *server) {
    struct input *in = input_of(server);
    VEC_FOR(&in->shortcuts, struct shortcut, shortcut) node_unref(shortcut->node);
    vec_clear(&in->shortcuts);
    VEC_FOR(&server->shortcuts, struct node *, slot) {
        struct node *node = *slot;
        const char *key = node_string(node, PROP_KEY);
        if (!key) continue;
        struct shortcut *shortcut = vec_push(&in->shortcuts);
        node_ref(node);
        shortcut->node = node;
        snprintf(shortcut->key, sizeof shortcut->key, "%s", key);
        if (key[0] >= '0' && key[0] <= '9' && !key[1])
            shortcut->physical = key[0] == '0' ? KEY_0 : KEY_1 + (uint32_t)(key[0] - '1');
        shortcut->modifiers = node_prop(node, PROP_MODIFIERS)->modifiers;
        shortcut->repeat = node_bool(node, PROP_REPEAT);
    }
}

/* The shortcut a key press matches; later declarations win, so duplicates never tie. */
static struct shortcut *match_shortcut(struct input *in, uint32_t keycode, const xkb_keysym_t *syms,
                                       int count, uint32_t modifiers) {
    char names[8][64];
    count = MIN(count, 8);
    for (int s = 0; s < count; s++) xkb_keysym_get_name(syms[s], names[s], sizeof names[s]);
    for (size_t i = in->shortcuts.length; i-- > 0;) {
        struct shortcut *shortcut = vec_at(&in->shortcuts, i);
        if (shortcut->modifiers != modifiers) continue;
        if (shortcut->physical) {
            if (shortcut->physical == keycode) return shortcut;
            continue;
        }
        for (int s = 0; s < count; s++) {
            if (!strcasecmp(names[s], shortcut->key)) return shortcut;
        }
    }
    return NULL;
}

static void emit_simple(struct server *server, struct node *node, enum event_name name) {
    struct event event;
    if (event_begin(server, &event, node, name)) event_end(server, &event);
}

static int repeat_fired(void *data) {
    struct server *server = data;
    struct input *in = input_of(server);
    if (!in->repeating || !link_connected(server)) return 0;
    emit_simple(server, in->repeating, EVENT_PRESS);
    wl_event_source_timer_update(in->repeat_timer, REPEAT_INTERVAL);
    return 0;
}

static void stop_repeat(struct input *in) {
    set_ref(&in->repeating, NULL);
    if (in->repeat_timer) wl_event_source_timer_update(in->repeat_timer, 0);
}

/* True when a shortcut consumed the key. */
static bool handle_shortcut(struct server *server, uint32_t keycode, const xkb_keysym_t *syms,
                            int count, bool pressed) {
    struct input *in = input_of(server);
    struct pressed_key *held = NULL;
    size_t held_index = 0;
    for (size_t i = 0; i < in->pressed.length; i++) {
        struct pressed_key *key = vec_at(&in->pressed, i);
        if (key->keycode == keycode) {
            held = key;
            held_index = i;
        }
    }
    if (!pressed) {
        if (!held) return false;
        struct node *node = held->shortcut;
        vec_remove(&in->pressed, held_index);
        if (in->repeat_keycode == keycode) stop_repeat(in);
        if (!node) return false;
        emit_simple(server, node, EVENT_RELEASE);
        node_unref(node);
        return true;
    }
    if (held) {
        /* A key the backend repeats itself. */
        if (!held->shortcut) return false;
        if (held->repeat) emit_simple(server, held->shortcut, EVENT_PRESS);
        return true;
    }
    struct shortcut *shortcut =
        link_connected(server)
            ? match_shortcut(in, keycode, syms, count, server->seat_state.modifiers)
            : NULL;
    struct pressed_key *key = vec_push(&in->pressed);
    key->keycode = keycode;
    if (!shortcut) return false;
    node_ref(shortcut->node);
    key->shortcut = shortcut->node;
    key->repeat = shortcut->repeat;
    emit_simple(server, shortcut->node, EVENT_PRESS);
    if (shortcut->repeat) {
        set_ref(&in->repeating, shortcut->node);
        in->repeat_keycode = keycode;
        if (!in->repeat_timer)
            in->repeat_timer = wl_event_loop_add_timer(server->loop, repeat_fired, server);
        wl_event_source_timer_update(in->repeat_timer, REPEAT_DELAY);
    }
    return true;
}

/* Keyboards. */

static uint32_t stage_modifiers(uint32_t wlr) {
    uint32_t out = 0;
    if (wlr & WLR_MODIFIER_SHIFT) out |= MOD_SHIFT;
    if (wlr & WLR_MODIFIER_CTRL) out |= MOD_CONTROL;
    if (wlr & WLR_MODIFIER_ALT) out |= MOD_ALT;
    if (wlr & WLR_MODIFIER_LOGO) out |= MOD_LOGO;
    return out;
}

static void set_modifiers(struct server *server, uint32_t modifiers) {
    if (modifiers == server->seat_state.modifiers) return;
    server->seat_state.modifiers = modifiers;
    /* The director hears when held modifiers change, e.g. to end a switcher as they are let go. */
    struct message message;
    message_begin(&message, "modifiers");
    json_key(&message.writer, "seat");
    json_string(&message.writer, "seat0");
    json_key(&message.writer, "modifiers");
    modifiers_write(modifiers, &message.writer);
    message_send(server, &message, NULL);
}

static void handle_key(struct wl_listener *listener, void *data) {
    struct keyboard *keyboard = wl_container_of(listener, keyboard, key);
    struct server *server = keyboard->server;
    struct wlr_keyboard_key_event *event = data;
    const xkb_keysym_t *syms = NULL;
    int count =
        keyboard->wlr_keyboard->xkb_state
            ? xkb_state_key_get_syms(keyboard->wlr_keyboard->xkb_state, event->keycode + 8, &syms)
            : 0;
    bool pressed = event->state == WL_KEYBOARD_KEY_STATE_PRESSED;
    if (handle_shortcut(server, event->keycode, syms, count, pressed)) return;
    struct web_page *page = server->seat_state.focused_page;
    if (page) {
        web_page_key(page, event->keycode, syms, count, pressed,
                     wlr_keyboard_get_modifiers(keyboard->wlr_keyboard));
        return;
    }
    wlr_seat_set_keyboard(server->seat, keyboard->wlr_keyboard);
    wlr_seat_keyboard_notify_key(server->seat, event->time_msec, event->keycode, event->state);
}

static void handle_modifiers(struct wl_listener *listener, void *data) {
    struct keyboard *keyboard = wl_container_of(listener, keyboard, modifiers);
    struct server *server = keyboard->server;
    uint32_t modifiers = wlr_keyboard_get_modifiers(keyboard->wlr_keyboard);
    set_modifiers(server, stage_modifiers(modifiers));
    if (server->seat_state.focused_page)
        web_page_modifiers(server->seat_state.focused_page, modifiers);
    wlr_seat_set_keyboard(server->seat, keyboard->wlr_keyboard);
    wlr_seat_keyboard_notify_modifiers(server->seat, &keyboard->wlr_keyboard->modifiers);
}

static void update_capabilities(struct server *server);

static void handle_keyboard_destroy(struct wl_listener *listener, void *data) {
    struct keyboard *keyboard = wl_container_of(listener, keyboard, destroy);
    struct server *server = keyboard->server;
    wl_list_remove(&keyboard->key.link);
    wl_list_remove(&keyboard->modifiers.link);
    wl_list_remove(&keyboard->destroy.link);
    wl_list_remove(&keyboard->link);
    free(keyboard);
    /* A keyboard leaving with keys held releases them, but its modifiers stay in the
     * seat's state: what remains holds the modifiers now. */
    uint32_t modifiers = 0;
    struct keyboard *other;
    wl_list_for_each(other, &server->keyboards, link)
        modifiers |= stage_modifiers(wlr_keyboard_get_modifiers(other->wlr_keyboard));
    set_modifiers(server, modifiers);
    if (server->input) update_capabilities(server);
}

/* Give the keyboard to the focused page, else the focused window. */
void keyboard_sync_focus(struct server *server) {
    struct input *in = input_of(server);
    struct seat_state *state = &server->seat_state;
    struct web_page *page = state->focused_page;
    if (page != in->keyboard_page) {
        if (in->keyboard_page) web_page_focus(in->keyboard_page, false);
        in->keyboard_page = page;
        if (page) web_page_focus(page, true);
    }
    struct window *window = state->focused;
    struct wlr_surface *surface =
        !page && window && window_presentable(window) ? window->surface : NULL;
    if (surface == server->seat->keyboard_state.focused_surface) return;
    if (!surface) {
        wlr_seat_keyboard_notify_clear_focus(server->seat);
        return;
    }
    struct wlr_keyboard *keyboard = wlr_seat_get_keyboard(server->seat);
    if (!keyboard) {
        wlr_seat_keyboard_notify_enter(server->seat, surface, NULL, 0, NULL);
        return;
    }
    /* Keys a shortcut took are never released to clients, so the client is not told of them. */
    uint32_t keycodes[WLR_KEYBOARD_KEYS_CAP];
    size_t count = 0;
    for (size_t i = 0; i < keyboard->num_keycodes; i++) {
        bool taken = false;
        VEC_FOR(&in->pressed, struct pressed_key, key) {
            if (key->keycode == keyboard->keycodes[i] && key->shortcut) taken = true;
        }
        if (!taken) keycodes[count++] = keyboard->keycodes[i];
    }
    wlr_seat_keyboard_notify_enter(server->seat, surface, keycodes, count, &keyboard->modifiers);
}

void focus_page(struct server *server, struct web_page *page) {
    if (page == server->seat_state.focused_page) return;
    server->seat_state.focused_page = page;
    keyboard_sync_focus(server);
}

static void add_keyboard(struct server *server, struct wlr_input_device *device) {
    struct wlr_keyboard *wlr_keyboard = wlr_keyboard_from_input_device(device);
    struct keyboard *keyboard = xcalloc(1, sizeof *keyboard);
    keyboard->server = server;
    keyboard->wlr_keyboard = wlr_keyboard;
    /* A virtual keyboard brings its own keymap; others use XKB_DEFAULT_* from the environment. */
    if (!wlr_input_device_get_virtual_keyboard(device)) {
        struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
        struct xkb_keymap *keymap =
            xkb_keymap_new_from_names(context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
        if (!keymap) {
            /* A layout from the environment that does not compile falls back to US. */
            wlr_log(WLR_ERROR, "keyboard layout from XKB_DEFAULT_* does not compile; using us");
            struct xkb_rule_names us = {.rules = "evdev", .layout = "us"};
            keymap = xkb_keymap_new_from_names(context, &us, XKB_KEYMAP_COMPILE_NO_FLAGS);
        }
        if (keymap) wlr_keyboard_set_keymap(wlr_keyboard, keymap);
        xkb_keymap_unref(keymap);
        xkb_context_unref(context);
        /* Keys repeat as GNOME sets them up: 33 a second after half a second. */
        wlr_keyboard_set_repeat_info(wlr_keyboard, 33, 500);
    }
    keyboard->key.notify = handle_key;
    wl_signal_add(&wlr_keyboard->events.key, &keyboard->key);
    keyboard->modifiers.notify = handle_modifiers;
    wl_signal_add(&wlr_keyboard->events.modifiers, &keyboard->modifiers);
    keyboard->destroy.notify = handle_keyboard_destroy;
    wl_signal_add(&device->events.destroy, &keyboard->destroy);
    wlr_seat_set_keyboard(server->seat, wlr_keyboard);
    wl_list_insert(&server->keyboards, &keyboard->link);
}

/* Touchpads start as GNOME sets them up: tap to click, natural scrolling, and a
 * pause while typing. */
static void configure_pointer(struct wlr_input_device *device) {
    if (!wlr_input_device_is_libinput(device)) return;
    struct libinput_device *handle = wlr_libinput_get_device_handle(device);
    if (libinput_device_config_tap_get_finger_count(handle) > 0) {
        libinput_device_config_tap_set_enabled(handle, LIBINPUT_CONFIG_TAP_ENABLED);
        if (libinput_device_config_scroll_has_natural_scroll(handle))
            libinput_device_config_scroll_set_natural_scroll_enabled(handle, 1);
        if (libinput_device_config_dwt_is_available(handle))
            libinput_device_config_dwt_set_enabled(handle, LIBINPUT_CONFIG_DWT_ENABLED);
    }
}

static void update_capabilities(struct server *server) {
    uint32_t caps = WL_SEAT_CAPABILITY_POINTER;
    if (!wl_list_empty(&server->keyboards)) caps |= WL_SEAT_CAPABILITY_KEYBOARD;
    wlr_seat_set_capabilities(server->seat, caps);
}

static void handle_new_input(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, new_input);
    struct wlr_input_device *device = data;
    switch (device->type) {
    case WLR_INPUT_DEVICE_KEYBOARD: add_keyboard(server, device); break;
    case WLR_INPUT_DEVICE_POINTER:
        configure_pointer(device);
        wlr_cursor_attach_input_device(server->cursor, device);
        break;
    default: break;
    }
    update_capabilities(server);
}

/* Virtual devices, for remote desktops and test drivers on headless sessions. */

static void handle_virtual_keyboard(struct wl_listener *listener, void *data) {
    struct input *in = wl_container_of(listener, in, virtual_keyboard);
    struct wlr_virtual_keyboard_v1 *keyboard = data;
    add_keyboard(in->server, &keyboard->keyboard.base);
    update_capabilities(in->server);
}

static void handle_virtual_pointer(struct wl_listener *listener, void *data) {
    struct input *in = wl_container_of(listener, in, virtual_pointer);
    struct wlr_virtual_pointer_v1_new_pointer_event *event = data;
    wlr_cursor_attach_input_device(in->server->cursor, &event->new_pointer->pointer.base);
}

void input_enable_virtual_devices(struct server *server) {
    struct input *in = input_of(server);
    struct wlr_virtual_keyboard_manager_v1 *keyboards =
        wlr_virtual_keyboard_manager_v1_create(server->wl_display);
    in->virtual_keyboard.notify = handle_virtual_keyboard;
    wl_signal_add(&keyboards->events.new_virtual_keyboard, &in->virtual_keyboard);
    struct wlr_virtual_pointer_manager_v1 *pointers =
        wlr_virtual_pointer_manager_v1_create(server->wl_display);
    in->virtual_pointer.notify = handle_virtual_pointer;
    wl_signal_add(&pointers->events.new_virtual_pointer, &in->virtual_pointer);
    in->virtual_devices = true;
}

/* Pointer. */

static bool locked(struct server *server) {
    struct input *in = input_of(server);
    return in->constraint && in->constraint->type == WLR_POINTER_CONSTRAINT_V1_LOCKED;
}

/* Whether a confined pointer may go to layout point (X, Y): within the confining
 * region, on the output it is on. */
static bool confines(struct server *server, double lx, double ly) {
    struct input *in = input_of(server);
    const struct hit *hit = client_grab(in)   ? client_grab(in)
                            : in->has_hovered ? &in->hovered
                                              : NULL;
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    int ox, oy;
    if (!hit || !hit->window || !output ||
        !window_surface_offset(hit->window, in->constraint->surface, &ox, &oy))
        return true;
    if (output_at(server, lx, ly) != output) return false;
    double cx, cy;
    hit_content(hit, lx - output->offset, ly, &cx, &cy);
    return pixman_region32_contains_point(&in->constraint->region, (int)floor(cx - ox),
                                          (int)floor(cy - oy), NULL);
}

/* The drag icon follows the pointer: the output it is on draws again, and the one it left. */
static void drag_frames(struct server *server) {
    struct input *in = input_of(server);
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    if (output) output_request_frame(output);
    if (in->drag_output && in->drag_output != output) output_request_frame(in->drag_output);
    in->drag_output = output;
}

static void after_motion(struct server *server) {
    pointer_moved(server);
    /* Displays with shaders reading the pointer are rebuilt as it moves. */
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        if (display_pointer_shaders(output)) {
            display_invalidate(output);
            output_request_frame(output);
        }
    }
    if (drag_active(server)) drag_frames(server);
}

static void handle_motion(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, cursor_motion);
    struct wlr_pointer_motion_event *event = data;
    wlr_relative_pointer_manager_v1_send_relative_motion(
        server->relative_pointer, server->seat, (uint64_t)event->time_msec * 1000, event->delta_x,
        event->delta_y, event->unaccel_dx, event->unaccel_dy);
    struct input *in = input_of(server);
    double dx = event->delta_x, dy = event->delta_y;
    if (in->constraint && in->constraint->type == WLR_POINTER_CONSTRAINT_V1_CONFINED) {
        /* Along the region's edge the pointer slides on the axis still allowed. */
        double x = server->cursor->x, y = server->cursor->y;
        if (!confines(server, x + dx, y + dy)) {
            if (confines(server, x + dx, y)) dy = 0;
            else if (confines(server, x, y + dy)) dx = 0;
            else dx = dy = 0;
        }
    }
    if (!locked(server) && (dx || dy))
        wlr_cursor_move(server->cursor, &event->pointer->base, dx, dy);
    after_motion(server);
}

static void handle_motion_absolute(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, cursor_motion_absolute);
    struct wlr_pointer_motion_absolute_event *event = data;
    if (!input_of(server)->constraint)
        wlr_cursor_warp_absolute(server->cursor, &event->pointer->base, event->x, event->y);
    after_motion(server);
}

static void handle_button(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, cursor_button);
    struct wlr_pointer_button_event *event = data;
    bool pressed = event->state == WL_POINTER_BUTTON_STATE_PRESSED;
    if (drag_active(server)) {
        wlr_seat_pointer_notify_button(server->seat, event->time_msec, event->button, event->state);
        struct input *in = input_of(server);
        for (int i = 0; i < in->button_count; i++) {
            if (in->buttons[i].code == event->button) {
                if (in->buttons[i].kind == BUTTON_CLIENT) clear_hit(&in->buttons[i].hit);
                in->buttons[i] = in->buttons[--in->button_count];
                break;
            }
        }
    } else if (pressed) {
        press(server, event->button);
    } else {
        release(server, event->button);
    }
    /* Presses start and end moves and captures, which change the cursor and focus. */
    input_update_cursor(server);
    sync_constraint(server);
}

static const char *axis_source(enum wl_pointer_axis_source source) {
    switch (source) {
    case WL_POINTER_AXIS_SOURCE_FINGER: return "finger";
    case WL_POINTER_AXIS_SOURCE_CONTINUOUS: return "continuous";
    case WL_POINTER_AXIS_SOURCE_WHEEL_TILT: return "wheel-tilt";
    default: return "wheel";
    }
}

static void axis_fields(struct json_writer *w, struct wlr_pointer_axis_event *event) {
    json_key(w, "orientation");
    json_string(w, event->orientation == WL_POINTER_AXIS_HORIZONTAL_SCROLL ? "horizontal"
                                                                           : "vertical");
    json_key(w, "delta");
    json_number(w, event->delta);
    json_key(w, "discrete");
    json_int(w, event->delta_discrete);
    json_key(w, "source");
    json_string(w, axis_source(event->source));
}

static void axis_action(struct server *server, int action, struct wlr_pointer_axis_event *event) {
    if (event->delta == 0) return;
    bool vertical = event->orientation == WL_POINTER_AXIS_VERTICAL_SCROLL;
    if (action == ACTION_ZOOM && vertical)
        wheel_zoom(server, event->delta, event->source == WL_POINTER_AXIS_SOURCE_WHEEL);
    else wheel_pan(server, !vertical, event->delta);
}

static bool wheel_target(const struct node *node) {
    return node_receives(node, EVENT_WHEEL) ||
           (node->kind == KIND_BACKGROUND && node_bool(node, PROP_PAN));
}

static void handle_axis(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, cursor_axis);
    struct input *in = input_of(server);
    struct wlr_pointer_axis_event *event = data;
    struct node *binding = find_binding(server, KIND_WHEEL_BINDING, NULL, NULL);
    struct event message;
    if (binding) {
        int action = node_choice(binding, PROP_ACTION);
        if (action == ACTION_ZOOM || action == ACTION_PAN) axis_action(server, action, event);
        if (event_begin(server, &message, binding, EVENT_WHEEL)) {
            axis_fields(&message.writer, event);
            json_key(&message.writer, "window");
            struct window *window = window_under(server);
            if (window) json_int(&message.writer, (int64_t)window->id);
            else json_null(&message.writer);
            pointer_payload(server, &message.writer, NULL);
            event_end(server, &message);
        }
        return;
    }
    const struct hit *grab = client_grab(in);
    const struct hit *hit = grab ? current_grab(server, grab) : pick(server, wheel_target);
    if (!hit) return;
    if (hit->window || hit->page) {
        struct hit copy;
        copy_hit(&copy, hit);
        /* The wheel may pass through compositor nodes to a client: it is hovered now. */
        if (!grab && !(in->has_hovered && same_client(&in->hovered, &copy)))
            set_hovered(server, &copy);
        deliver_motion(server, &copy, grab != NULL);
        if (copy.page) {
            double cx, cy;
            content_point(server, &copy, grab != NULL, &cx, &cy);
            web_page_pointer_axis(
                copy.page, cx, cy, event->orientation == WL_POINTER_AXIS_HORIZONTAL_SCROLL,
                event->delta,
                event->relative_direction == WL_POINTER_AXIS_RELATIVE_DIRECTION_INVERTED);
        } else {
            wlr_seat_pointer_notify_axis(server->seat, event->time_msec, event->orientation,
                                         event->delta, event->delta_discrete, event->source,
                                         event->relative_direction);
        }
        clear_hit(&copy);
        sync_constraint(server);
        return;
    }
    if (hit->node->kind == KIND_BACKGROUND && node_bool(hit->node, PROP_PAN))
        axis_action(server, ACTION_PAN, event);
    if (event_begin(server, &message, hit->node, EVENT_WHEEL)) {
        axis_fields(&message.writer, event);
        pointer_payload(server, &message.writer, hit);
        event_end(server, &message);
    }
    sync_constraint(server);
}

static void handle_frame(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, cursor_frame);
    wlr_seat_pointer_notify_frame(server->seat);
}

/* Gestures. */

struct gesture_match {
    int gesture;
    uint32_t fingers;
};

static bool gesture_matches(const struct node *node, const void *data) {
    const struct gesture_match *match = data;
    return node_choice(node, PROP_GESTURE) == match->gesture &&
           node_prop(node, PROP_FINGERS)->id == match->fingers;
}

static void gesture_fields(struct json_writer *w, uint32_t fingers, double dx, double dy,
                           double scale, double rotation, bool cancelled) {
    json_key(w, "fingers");
    json_int(w, fingers);
    json_key(w, "dx");
    json_number(w, dx);
    json_key(w, "dy");
    json_number(w, dy);
    json_key(w, "scale");
    json_number(w, scale);
    json_key(w, "rotation");
    json_number(w, rotation);
    json_key(w, "cancelled");
    json_bool(w, cancelled);
}

/* True when a binding took the gesture; otherwise the client under the pointer gets it. */
static bool gesture_begin(struct server *server, int gesture, uint32_t fingers) {
    struct input *in = input_of(server);
    struct gesture_match match = {gesture, fingers};
    struct node *binding = find_binding(server, KIND_GESTURE_BINDING, gesture_matches, &match);
    set_ref(&in->gesture, binding);
    in->gesture_taken = binding != NULL;
    if (!binding) return false;
    int action = node_choice(binding, PROP_ACTION);
    if (action == ACTION_PAN || action == ACTION_ZOOM) gesture_manipulation_begin(server, action);
    struct event event;
    if (event_begin(server, &event, binding, EVENT_BEGIN)) {
        gesture_fields(&event.writer, fingers, 0, 0, 1, 0, false);
        pointer_payload(server, &event.writer, NULL);
        event_end(server, &event);
    }
    return true;
}

static void gesture_update(struct server *server, uint32_t fingers, double dx, double dy,
                           double scale, double rotation) {
    struct input *in = input_of(server);
    if (in->gesture_manipulation) gesture_manipulation_update(server, dx, dy, scale);
    struct event event;
    if (in->gesture && event_begin(server, &event, in->gesture, EVENT_UPDATE)) {
        gesture_fields(&event.writer, fingers, dx, dy, scale, rotation, false);
        event_end(server, &event);
    }
}

static void gesture_end(struct server *server, uint32_t fingers, bool cancelled) {
    struct input *in = input_of(server);
    if (in->gesture_manipulation) gesture_manipulation_end(server, cancelled);
    struct event event;
    if (in->gesture && event_begin(server, &event, in->gesture, EVENT_END)) {
        gesture_fields(&event.writer, fingers, 0, 0, 1, 0, cancelled);
        event_end(server, &event);
    }
    set_ref(&in->gesture, NULL);
    in->gesture_taken = false;
}

static void handle_swipe_begin(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, swipe_begin);
    struct wlr_pointer_swipe_begin_event *event = data;
    if (!gesture_begin(server, GESTURE_SWIPE, event->fingers))
        wlr_pointer_gestures_v1_send_swipe_begin(server->pointer_gestures, server->seat,
                                                 event->time_msec, event->fingers);
}

static void handle_swipe_update(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, swipe_update);
    struct wlr_pointer_swipe_update_event *event = data;
    if (input_of(server)->gesture_taken)
        gesture_update(server, event->fingers, event->dx, event->dy, 1, 0);
    else
        wlr_pointer_gestures_v1_send_swipe_update(server->pointer_gestures, server->seat,
                                                  event->time_msec, event->dx, event->dy);
}

static void handle_swipe_end(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, swipe_end);
    struct wlr_pointer_swipe_end_event *event = data;
    if (input_of(server)->gesture_taken) gesture_end(server, 0, event->cancelled);
    else
        wlr_pointer_gestures_v1_send_swipe_end(server->pointer_gestures, server->seat,
                                               event->time_msec, event->cancelled);
}

static void handle_pinch_begin(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, pinch_begin);
    struct wlr_pointer_pinch_begin_event *event = data;
    if (!gesture_begin(server, GESTURE_PINCH, event->fingers))
        wlr_pointer_gestures_v1_send_pinch_begin(server->pointer_gestures, server->seat,
                                                 event->time_msec, event->fingers);
}

static void handle_pinch_update(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, pinch_update);
    struct wlr_pointer_pinch_update_event *event = data;
    if (input_of(server)->gesture_taken)
        gesture_update(server, event->fingers, event->dx, event->dy, event->scale, event->rotation);
    else
        wlr_pointer_gestures_v1_send_pinch_update(server->pointer_gestures, server->seat,
                                                  event->time_msec, event->dx, event->dy,
                                                  event->scale, event->rotation);
}

static void handle_pinch_end(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, pinch_end);
    struct wlr_pointer_pinch_end_event *event = data;
    if (input_of(server)->gesture_taken) gesture_end(server, 0, event->cancelled);
    else
        wlr_pointer_gestures_v1_send_pinch_end(server->pointer_gestures, server->seat,
                                               event->time_msec, event->cancelled);
}

static void handle_hold_begin(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, hold_begin);
    struct wlr_pointer_hold_begin_event *event = data;
    if (!gesture_begin(server, GESTURE_HOLD, event->fingers))
        wlr_pointer_gestures_v1_send_hold_begin(server->pointer_gestures, server->seat,
                                                event->time_msec, event->fingers);
}

static void handle_hold_end(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, hold_end);
    struct wlr_pointer_hold_end_event *event = data;
    if (input_of(server)->gesture_taken) gesture_end(server, 0, event->cancelled);
    else
        wlr_pointer_gestures_v1_send_hold_end(server->pointer_gestures, server->seat,
                                              event->time_msec, event->cancelled);
}

/* Client requests. */

void input_client_move_request(struct server *server, struct window *window, struct node *node,
                               bool move, uint32_t edges) {
    struct input *in = input_of(server);
    /* Only while a button pressed on the window is held: a request racing its release,
     * or one from a client no one pressed, would glue the window to the pointer. */
    if (!node || in->manipulation || in->capture || !input_window_pressed(server, window)) return;
    enum event_name event = move ? EVENT_MOVEREQUEST : EVENT_RESIZEREQUEST;
    enum button_kind kind;
    struct manipulation *manipulation = NULL;
    /* Client-side title bars and edges move and resize natively. */
    if (move && node_bool(node, PROP_MOVABLE)) {
        manipulation = manipulation_begin_move(server, node);
        kind = BUTTON_MANIPULATION;
    } else if (!move && node_bool(node, PROP_RESIZABLE)) {
        manipulation = manipulation_begin_resize(server, node, window, edges);
        kind = BUTTON_MANIPULATION;
    } else if (node_handles(node, event) && link_connected(server)) {
        /* Otherwise the request continues as a capture on the window node, so the
         * director reuses its ordinary drag handling. */
        kind = BUTTON_CAPTURE;
        set_ref(&in->capture, node);
    } else {
        return;
    }
    if (kind == BUTTON_MANIPULATION && !manipulation) return;
    for (int i = 0; i < in->button_count; i++) {
        if (in->buttons[i].kind == BUTTON_CLIENT) clear_hit(&in->buttons[i].hit);
        in->buttons[i].kind = kind;
    }
    in->grab_surface = NULL;
    set_hovered(server, NULL);
    if (kind == BUTTON_CAPTURE) {
        struct event message;
        if (event_begin(server, &message, node, event)) {
            if (!move) {
                json_key(&message.writer, "edges");
                json_int(&message.writer, edges);
            }
            pointer_payload(server, &message.writer, capture_hit(server));
            event_end(server, &message);
        }
    }
    input_update_cursor(server);
}

/* Cursors. */

static const char *const *shape_names(int shape) {
    static const char *const names[CURSOR_COUNT][4] = {
        [CURSOR_DEFAULT] = {"default", "left_ptr"},
        [CURSOR_POINTER] = {"pointer", "hand2"},
        [CURSOR_TEXT] = {"text", "xterm"},
        [CURSOR_CROSSHAIR] = {"crosshair", "cross"},
        [CURSOR_MOVE] = {"move", "fleur"},
        [CURSOR_GRAB] = {"grab", "openhand"},
        [CURSOR_GRABBING] = {"grabbing", "closedhand", "fleur"},
        [CURSOR_NOT_ALLOWED] = {"not-allowed", "crossed_circle"},
        [CURSOR_HELP] = {"help", "question_arrow"},
        [CURSOR_WAIT] = {"wait", "watch"},
        [CURSOR_PROGRESS] = {"progress", "left_ptr_watch"},
        [CURSOR_ZOOM_IN] = {"zoom-in"},
        [CURSOR_ZOOM_OUT] = {"zoom-out"},
        [CURSOR_EW_RESIZE] = {"ew-resize", "sb_h_double_arrow"},
        [CURSOR_NS_RESIZE] = {"ns-resize", "sb_v_double_arrow"},
        [CURSOR_NWSE_RESIZE] = {"nwse-resize", "bd_double_arrow"},
        [CURSOR_NESW_RESIZE] = {"nesw-resize", "fd_double_arrow"},
    };
    return names[shape];
}

static int node_cursor(const struct node *node) {
    for (; node; node = node->parent) {
        if (node->props[PROP_CURSOR].given) return node->props[PROP_CURSOR].choice;
    }
    return CURSOR_DEFAULT;
}

/* Resize shape for xdg_toplevel EDGES: top 1, bottom 2, left 4, right 8. */
static int edge_cursor(uint32_t edges) {
    switch (edges) {
    case 5:
    case 10: return CURSOR_NWSE_RESIZE;
    case 6:
    case 9: return CURSOR_NESW_RESIZE;
    case 1:
    case 2: return CURSOR_NS_RESIZE;
    default: return CURSOR_EW_RESIZE;
    }
}

static void show_shape(struct server *server, int shape) {
    struct input *in = input_of(server);
    if (shape == CURSOR_NONE) {
        if (!in->shown_hidden) wlr_cursor_unset_image(server->cursor);
        in->shown_hidden = true;
        in->shown_name = NULL;
        in->shown_surface = NULL;
        return;
    }
    /* The theme's name for each shape is looked up once. */
    const char *name = in->shape_names[shape];
    if (!name) {
        const char *const *names = shape_names(shape);
        for (int i = 0; i < 4 && names[i] && !name; i++) {
            if (wlr_xcursor_manager_get_xcursor(server->xcursor_manager, names[i], 1))
                name = names[i];
        }
        in->shape_names[shape] = name = name ? name : "default";
    }
    if (in->shown_name == name && !in->shown_hidden && !in->shown_surface) return;
    wlr_cursor_set_xcursor(server->cursor, server->xcursor_manager, name);
    in->shown_name = name;
    in->shown_hidden = false;
    in->shown_surface = NULL;
}

/* The cursor shape may have changed: after presses, captures and manipulations, and as
 * the pointer moves. */
static void input_update_cursor(struct server *server) {
    struct input *in = input_of(server);
    struct hit *client = client_grab(in);
    if (!client && in->has_hovered) client = &in->hovered;
    if (in->manipulation) {
        show_shape(server, in->manipulation->kind == MANIPULATION_RESIZE
                               ? edge_cursor(in->manipulation->edges)
                               : CURSOR_GRABBING);
    } else if (in->capture) {
        show_shape(server, node_cursor(in->capture));
    } else if (client && client->window && in->client_cursor_set) {
        /* Over a client the pointer shows the cursor that client set. */
        if (in->client_cursor_shape) {
            if (in->shown_name != in->client_cursor_shape || in->shown_surface || in->shown_hidden)
                wlr_cursor_set_xcursor(server->cursor, server->xcursor_manager,
                                       in->client_cursor_shape);
            in->shown_name = in->client_cursor_shape;
            in->shown_surface = NULL;
            in->shown_hidden = false;
        } else if (in->client_cursor) {
            if (in->shown_surface != in->client_cursor)
                wlr_cursor_set_surface(server->cursor, in->client_cursor, in->hotspot_x,
                                       in->hotspot_y);
            in->shown_surface = in->client_cursor;
            in->shown_name = NULL;
            in->shown_hidden = false;
        } else {
            show_shape(server, CURSOR_NONE);
        }
    } else if (client) {
        show_shape(server, node_cursor(client->node));
    } else {
        show_shape(server, node_cursor(in->entered));
    }
}

static void handle_request_cursor(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, request_cursor);
    struct input *in = input_of(server);
    struct wlr_seat_pointer_request_set_cursor_event *event = data;
    if (event->seat_client != server->seat->pointer_state.focused_client) return;
    in->client_cursor_set = true;
    in->client_cursor = event->surface;
    in->client_cursor_shape = NULL;
    in->hotspot_x = event->hotspot_x;
    in->hotspot_y = event->hotspot_y;
    in->shown_surface = NULL;
    input_update_cursor(server);
}

static void handle_cursor_shape(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, cursor_shape_request);
    struct input *in = input_of(server);
    struct wlr_cursor_shape_manager_v1_request_set_shape_event *event = data;
    if (event->seat_client != server->seat->pointer_state.focused_client) return;
    in->client_cursor_set = true;
    in->client_cursor = NULL;
    in->client_cursor_shape = wlr_cursor_shape_v1_name(event->shape);
    input_update_cursor(server);
}

void input_surface_committed(struct server *server, struct wlr_surface *surface) {
    struct input *in = input_of(server);
    if (in->drag && in->drag->icon && in->drag->icon->surface == surface) drag_frames(server);
}

void input_surface_destroyed(struct server *server, struct wlr_surface *surface) {
    struct input *in = input_of(server);
    if (in->grab_surface == surface) in->grab_surface = NULL;
    if (in->client_cursor == surface) {
        in->client_cursor = NULL;
        in->shown_surface = NULL;
    }
    displays_forget_surface(server, surface);
}

/* Drag and drop. */

static void handle_drag_destroy(struct wl_listener *listener, void *data) {
    struct input *in = wl_container_of(listener, in, drag_destroy);
    wl_list_remove(&in->drag_destroy.link);
    in->drag = NULL;
    request_frames(in->server);
}

static void handle_request_start_drag(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, request_start_drag);
    struct wlr_seat_request_start_drag_event *event = data;
    if (wlr_seat_validate_pointer_grab_serial(server->seat, event->origin, event->serial))
        wlr_seat_start_pointer_drag(server->seat, event->drag, event->serial);
    else wlr_data_source_destroy(event->drag->source);
}

static void handle_start_drag(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, start_drag);
    struct input *in = input_of(server);
    struct wlr_drag *drag = data;
    in->drag = drag;
    in->drag_destroy.notify = handle_drag_destroy;
    wl_signal_add(&drag->events.destroy, &in->drag_destroy);
}

bool input_drag_icon(struct server *server, struct output *output, struct wlr_surface **icon,
                     double *x, double *y) {
    struct input *in = input_of(server);
    if (!in->drag || !in->drag->icon || !in->drag->icon->surface->mapped) return false;
    double px, py;
    if (input_pointer_output(server, &px, &py) != output) return false;
    *icon = in->drag->icon->surface;
    *x = px;
    *y = py;
    return true;
}

/* Pointer constraints: a locked pointer stays where it is while its client reads
 * motion, a confined one stays in a region. Only the constraint of the surface with
 * pointer focus is active. */

static void handle_constraint_destroy(struct wl_listener *listener, void *data) {
    struct input *in = wl_container_of(listener, in, constraint_destroy);
    wl_list_remove(&in->constraint_destroy.link);
    in->constraint = NULL;
}

static void sync_constraint(struct server *server) {
    struct input *in = input_of(server);
    struct wlr_surface *focused = server->seat->pointer_state.focused_surface;
    struct wlr_pointer_constraint_v1 *wanted =
        focused ? wlr_pointer_constraints_v1_constraint_for_surface(server->pointer_constraints,
                                                                    focused, server->seat)
                : NULL;
    if (wanted == in->constraint) return;
    if (in->constraint) {
        wl_list_remove(&in->constraint_destroy.link);
        wlr_pointer_constraint_v1_send_deactivated(in->constraint);
    }
    in->constraint = wanted;
    if (!wanted) return;
    in->constraint_destroy.notify = handle_constraint_destroy;
    wl_signal_add(&wanted->events.destroy, &in->constraint_destroy);
    wlr_pointer_constraint_v1_send_activated(wanted);
}

static void handle_new_constraint(struct wl_listener *listener, void *data) {
    struct server *server = wl_container_of(listener, server, new_constraint);
    sync_constraint(server);
}

void input_init(struct server *server) {
    struct input *in = xcalloc(1, sizeof *in);
    in->server = server;
    vec_init(&in->shortcuts, sizeof(struct shortcut));
    vec_init(&in->pressed, sizeof(struct pressed_key));
    server->input = in;

    server->seat = wlr_seat_create(server->wl_display, "seat0");
    server->cursor = wlr_cursor_create();
    wlr_cursor_attach_output_layout(server->cursor, server->output_layout);
    const char *theme = getenv("XCURSOR_THEME");
    const char *size_text = getenv("XCURSOR_SIZE");
    int size = size_text ? atoi(size_text) : 24;
    server->xcursor_manager =
        wlr_xcursor_manager_create(theme, size >= 8 && size <= 256 ? size : 24);
    wlr_xcursor_manager_load(server->xcursor_manager, 1);

    struct wlr_cursor_shape_manager_v1 *shapes =
        wlr_cursor_shape_manager_v1_create(server->wl_display, 1);
    server->cursor_shape_request.notify = handle_cursor_shape;
    wl_signal_add(&shapes->events.request_set_shape, &server->cursor_shape_request);

    server->new_input.notify = handle_new_input;
    wl_signal_add(&server->backend->events.new_input, &server->new_input);
    server->cursor_motion.notify = handle_motion;
    wl_signal_add(&server->cursor->events.motion, &server->cursor_motion);
    server->cursor_motion_absolute.notify = handle_motion_absolute;
    wl_signal_add(&server->cursor->events.motion_absolute, &server->cursor_motion_absolute);
    server->cursor_button.notify = handle_button;
    wl_signal_add(&server->cursor->events.button, &server->cursor_button);
    server->cursor_axis.notify = handle_axis;
    wl_signal_add(&server->cursor->events.axis, &server->cursor_axis);
    server->cursor_frame.notify = handle_frame;
    wl_signal_add(&server->cursor->events.frame, &server->cursor_frame);
    server->swipe_begin.notify = handle_swipe_begin;
    wl_signal_add(&server->cursor->events.swipe_begin, &server->swipe_begin);
    server->swipe_update.notify = handle_swipe_update;
    wl_signal_add(&server->cursor->events.swipe_update, &server->swipe_update);
    server->swipe_end.notify = handle_swipe_end;
    wl_signal_add(&server->cursor->events.swipe_end, &server->swipe_end);
    server->pinch_begin.notify = handle_pinch_begin;
    wl_signal_add(&server->cursor->events.pinch_begin, &server->pinch_begin);
    server->pinch_update.notify = handle_pinch_update;
    wl_signal_add(&server->cursor->events.pinch_update, &server->pinch_update);
    server->pinch_end.notify = handle_pinch_end;
    wl_signal_add(&server->cursor->events.pinch_end, &server->pinch_end);
    server->hold_begin.notify = handle_hold_begin;
    wl_signal_add(&server->cursor->events.hold_begin, &server->hold_begin);
    server->hold_end.notify = handle_hold_end;
    wl_signal_add(&server->cursor->events.hold_end, &server->hold_end);
    server->request_cursor.notify = handle_request_cursor;
    wl_signal_add(&server->seat->events.request_set_cursor, &server->request_cursor);
    server->request_start_drag.notify = handle_request_start_drag;
    wl_signal_add(&server->seat->events.request_start_drag, &server->request_start_drag);
    server->start_drag.notify = handle_start_drag;
    wl_signal_add(&server->seat->events.start_drag, &server->start_drag);
    server->new_constraint.notify = handle_new_constraint;
    wl_signal_add(&server->pointer_constraints->events.new_constraint, &server->new_constraint);
    update_capabilities(server);
}

void input_detach_backend(struct server *server) {
    if (!input_of(server)) return;
    wl_list_remove(&server->new_input.link);
    wl_list_init(&server->new_input.link);
}

void input_finish(struct server *server) {
    struct input *in = input_of(server);
    if (!in) return;
    struct wl_listener *listeners[] = {
        &server->new_input,
        &server->cursor_motion,
        &server->cursor_motion_absolute,
        &server->cursor_button,
        &server->cursor_axis,
        &server->cursor_frame,
        &server->swipe_begin,
        &server->swipe_update,
        &server->swipe_end,
        &server->pinch_begin,
        &server->pinch_update,
        &server->pinch_end,
        &server->hold_begin,
        &server->hold_end,
        &server->request_cursor,
        &server->request_start_drag,
        &server->start_drag,
        &server->new_constraint,
        &server->cursor_shape_request,
    };
    for (size_t i = 0; i < ARRAY_LENGTH(listeners); i++) wl_list_remove(&listeners[i]->link);
    if (in->virtual_devices) {
        wl_list_remove(&in->virtual_keyboard.link);
        wl_list_remove(&in->virtual_pointer.link);
    }
    if (in->drag) wl_list_remove(&in->drag_destroy.link);
    if (in->constraint) wl_list_remove(&in->constraint_destroy.link);
    if (in->has_hovered) clear_hit(&in->hovered);
    for (int i = 0; i < in->button_count; i++) {
        if (in->buttons[i].kind == BUTTON_CLIENT) clear_hit(&in->buttons[i].hit);
    }
    set_ref(&in->entered, NULL);
    set_ref(&in->capture, NULL);
    set_ref(&in->gesture, NULL);
    stop_repeat(in);
    if (in->repeat_timer) wl_event_source_remove(in->repeat_timer);
    if (in->manipulation) manipulation_free(in->manipulation);
    if (in->gesture_manipulation) manipulation_free(in->gesture_manipulation);
    VEC_FOR(&in->shortcuts, struct shortcut, shortcut) node_unref(shortcut->node);
    vec_finish(&in->shortcuts);
    VEC_FOR(&in->pressed, struct pressed_key, key)
        if (key->shortcut) node_unref(key->shortcut);
    vec_finish(&in->pressed);
    free(in);
    server->input = NULL;
}

/* Manipulations live with the input state. */
void input_forget_output(struct server *server, struct output *output) {
    struct input *in = input_of(server);
    if (in->drag_output == output) in->drag_output = NULL;
    /* A move or resize ends where it got to; a pan simply stops. */
    if (in->manipulation && in->manipulation->output == output)
        manipulation_lost(server, in->manipulation->kind == MANIPULATION_PAN);
    if (in->gesture_manipulation && in->gesture_manipulation->output == output) {
        manipulation_free(in->gesture_manipulation);
        in->gesture_manipulation = NULL;
    }
}

struct manipulation **input_manipulation_slot(struct server *server, bool gesture) {
    struct input *in = input_of(server);
    return gesture ? &in->gesture_manipulation : &in->manipulation;
}
