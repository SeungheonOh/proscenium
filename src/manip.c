/*
 * Direct manipulation in the compositor.
 *
 * Pans, zooms, moves and resizes follow input in the same frame, with no
 * director round trip. A manipulated node holds the keys it drives, so director
 * commits cannot fight the pointer. The director learns the outcome from
 * coalesced progress events and a final event carrying the new values, which it
 * should store so its next render declares them.
 */
#include <math.h>
#include <wlr/types/wlr_cursor.h>

#include "input.h"
#include "link.h"
#include "stage.h"

#define MINIMUM_WIDTH 120.0
#define MINIMUM_HEIGHT 80.0
/* Seconds of motion history that estimate the release velocity. */
#define VELOCITY_WINDOW 0.1
/* Screen pixels a second below which a release simply stops. */
#define FLING_THRESHOLD 150.0
#define FLING_LIMIT 6000.0

/* Coordinates. */

static struct node *root_of(const struct node *node) {
    while (node->parent) node = node->parent;
    return (struct node *)node;
}

/* NODE's parent space to OUTPUT's logical pixels. */
static struct mat4 node_parent_matrix(struct server *server, struct output *output,
                                      const struct node *node) {
    struct mat4 matrix = root_of(node) == &server->scene.root
                             ? mat4_from_mat3(camera_transform(output))
                             : MAT4_IDENTITY;
    /* Ancestors below the root, outermost first. */
    const struct node *ancestors[256];
    int count = 0;
    for (const struct node *parent = node->parent; parent && parent->parent && count < 256;
         parent = parent->parent)
        ancestors[count++] = parent;
    while (count-- > 0) {
        const struct node *ancestor = ancestors[count];
        double width, height;
        node_size(server, ancestor, &width, &height);
        struct mat4 local = node_matrix(ancestor, width, height);
        /* A screen node restarts from output pixels, ignoring the camera. */
        matrix = ancestor->kind == KIND_SCREEN ? local : mat4_multiply(&matrix, &local);
    }
    return matrix;
}

/* The pointer relative to the manipulated output, even after leaving it. */
static void manipulation_point(struct server *server, const struct manipulation *manipulation,
                               double *x, double *y) {
    *x = server->cursor->x - manipulation->output->offset;
    *y = server->cursor->y;
}

/* Output-logical point (X, Y) on NODE's parent plane. */
static void parent_point(struct server *server, struct output *output, const struct node *node,
                         double x, double y, double *px, double *py) {
    struct mat4 parent = node_parent_matrix(server, output, node);
    struct mat3 inverse;
    if (mat3_invert(mat4_plane(&parent), &inverse)) {
        mat3_apply(inverse, x, y, px, py);
    } else {
        *px = x;
        *py = y;
    }
}

static void record_sample(struct manipulation *manipulation, double x, double y) {
    double time = now_seconds();
    int keep = 0;
    for (int i = 0; i < manipulation->sample_count; i++) {
        if (time - manipulation->samples[i][0] <= VELOCITY_WINDOW && keep < 31) {
            memmove(manipulation->samples[keep], manipulation->samples[i],
                    sizeof manipulation->samples[i]);
            keep++;
        }
    }
    manipulation->samples[keep][0] = time;
    manipulation->samples[keep][1] = x;
    manipulation->samples[keep][2] = y;
    manipulation->sample_count = keep + 1;
}

/* Screen velocity at release, or zero when the input had already stopped. */
static void release_velocity(const struct manipulation *manipulation, double *vx, double *vy) {
    *vx = *vy = 0;
    int count = manipulation->sample_count;
    if (!count) return;
    const double *newest = manipulation->samples[count - 1], *oldest = manipulation->samples[0];
    double span = newest[0] - oldest[0];
    if (span < 0.01 || now_seconds() - newest[0] > 0.05) return;
    double x = (newest[1] - oldest[1]) / span, y = (newest[2] - oldest[2]) / span;
    double speed = hypot(x, y);
    if (speed < FLING_THRESHOLD) return;
    double scale = speed > FLING_LIMIT ? FLING_LIMIT / speed : 1;
    *vx = x * scale;
    *vy = y * scale;
}

/* Events. */

static void emit_box(struct server *server, struct node *node, enum event_name name, double x,
                     double y, bool sized, double width, double height) {
    struct event event;
    if (!event_begin(server, &event, node, name)) return;
    json_key(&event.writer, "x");
    json_number(&event.writer, x);
    json_key(&event.writer, "y");
    json_number(&event.writer, y);
    if (sized) {
        json_key(&event.writer, "width");
        json_number(&event.writer, width);
        json_key(&event.writer, "height");
        json_number(&event.writer, height);
    }
    event_end(server, &event);
}

/* Targets. */

struct node *move_target(const struct node *node) {
    for (const struct node *current = node; current && current->parent; current = current->parent) {
        bool movable;
        switch (current->kind) {
        case KIND_WINDOW: movable = node_bool(current, PROP_MOVABLE); break;
        case KIND_GROUP:
        case KIND_TEXT:
        case KIND_IMAGE: movable = node_bool(current, PROP_DRAGGABLE); break;
        default: movable = false; break;
        }
        if (movable) return (struct node *)current;
    }
    return NULL;
}

uint32_t resize_edges(double local_x, double local_y, double width, double height) {
    return (local_y < height / 2 ? 1 : 2) | (local_x < width / 2 ? 4 : 8);
}

/* Pointer manipulations. */

static struct manipulation *create(enum manipulation_kind kind, struct output *output) {
    struct manipulation *manipulation = xcalloc(1, sizeof *manipulation);
    manipulation->kind = kind;
    manipulation->output = output;
    return manipulation;
}

void manipulation_free(struct manipulation *manipulation) {
    if (manipulation->node) node_unref(manipulation->node);
    if (manipulation->window) window_unref(manipulation->window);
    if (manipulation->source) node_unref(manipulation->source);
    free(manipulation);
}

static void install(struct server *server, struct manipulation *manipulation, bool gesture) {
    struct manipulation **slot = input_manipulation_slot(server, gesture);
    if (*slot) manipulation_free(*slot);
    *slot = manipulation;
}

static struct output *pointer_output(struct server *server) {
    double x, y;
    return input_pointer_output(server, &x, &y);
}

struct manipulation *manipulation_begin_pan(struct server *server, struct output *output) {
    struct manipulation *manipulation = create(MANIPULATION_PAN, output);
    manipulation_point(server, manipulation, &manipulation->last_x, &manipulation->last_y);
    record_sample(manipulation, manipulation->last_x, manipulation->last_y);
    /* Grabbing a coasting canvas stops it where it is. */
    camera_settle(output, now_seconds());
    install(server, manipulation, false);
    return manipulation;
}

/* Start a KIND manipulation of NODE anchored at the pointer; the director's values
 * for the keys it drives wait until it ends. */
static struct manipulation *begin_node(struct server *server, struct node *node,
                                       enum manipulation_kind kind) {
    struct output *output = pointer_output(server);
    if (!output) return NULL;
    struct manipulation *manipulation = create(kind, output);
    node_ref(node);
    manipulation->node = node;
    manipulation->origin_x = node_number(node, PROP_X, 0);
    manipulation->origin_y = node_number(node, PROP_Y, 0);
    double x, y;
    manipulation_point(server, manipulation, &x, &y);
    parent_point(server, output, node, x, y, &manipulation->anchor_x, &manipulation->anchor_y);
    node_hold(node, PROP_X);
    node_hold(node, PROP_Y);
    install(server, manipulation, false);
    return manipulation;
}

struct manipulation *manipulation_begin_move(struct server *server, struct node *node) {
    struct manipulation *manipulation = begin_node(server, node, MANIPULATION_MOVE);
    if (manipulation)
        emit_box(server, node, EVENT_DRAGSTART, manipulation->origin_x, manipulation->origin_y,
                 false, 0, 0);
    return manipulation;
}

struct manipulation *manipulation_begin_resize(struct server *server, struct node *node,
                                               struct window *window, uint32_t edges) {
    if (!window) return NULL;
    struct manipulation *manipulation = begin_node(server, node, MANIPULATION_RESIZE);
    if (!manipulation) return NULL;
    double width, height;
    node_size(server, node, &width, &height);
    node_hold(node, PROP_WIDTH);
    node_hold(node, PROP_HEIGHT);
    window_ref(window);
    manipulation->window = window;
    manipulation->edges = edges;
    manipulation->origin_width = width;
    manipulation->origin_height = height;
    /* Edges follow the pointer along the node's own axes, however it is turned: points
     * are taken onto its plane as it was at the start. */
    manipulation->frame = node_matrix(node, width, height);
    struct mat4 parent = node_parent_matrix(server, manipulation->output, node);
    struct mat4 whole = mat4_multiply(&parent, &manipulation->frame);
    if (!mat3_invert(mat4_plane(&whole), &manipulation->to_local))
        manipulation->to_local = MAT3_IDENTITY;
    double x, y;
    manipulation_point(server, manipulation, &x, &y);
    mat3_apply(manipulation->to_local, x, y, &manipulation->anchor_x, &manipulation->anchor_y);
    window_set_resizing(window, true);
    emit_box(server, node, EVENT_RESIZESTART, manipulation->origin_x, manipulation->origin_y, true,
             width, height);
    return manipulation;
}

static void update_pan(struct server *server, struct manipulation *manipulation) {
    double x, y;
    manipulation_point(server, manipulation, &x, &y);
    camera_pan(manipulation->output, x - manipulation->last_x, y - manipulation->last_y);
    manipulation->last_x = x;
    manipulation->last_y = y;
    record_sample(manipulation, x, y);
    cameras_report(server);
}

static double edge(uint32_t edges, double size, double delta, uint32_t low, uint32_t high,
                   double minimum) {
    if (edges & high) return fmax(minimum, size + delta);
    if (edges & low) return fmax(minimum, size - delta);
    return size;
}

/* NODE's box with its edges dragged to output point (X, Y): the corner opposite them
 * stays where it was in its parent. */
static void resized_box(const struct manipulation *manipulation, const struct node *node,
                        double screen_x, double screen_y, double out[4]) {
    uint32_t edges = manipulation->edges;
    double local_x, local_y;
    mat3_apply(manipulation->to_local, screen_x, screen_y, &local_x, &local_y);
    double width = manipulation->origin_width, height = manipulation->origin_height;
    double new_width = edge(edges, width, local_x - manipulation->anchor_x, 4, 8, MINIMUM_WIDTH);
    double new_height = edge(edges, height, local_y - manipulation->anchor_y, 1, 2, MINIMUM_HEIGHT);
    /* Placed at (0, 0), the node puts the fixed corner at OFFSET, so it moves by what that leaves.
     */
    double fixed_x, fixed_y, offset_x, offset_y;
    mat3_apply(mat4_plane(&manipulation->frame), edges & 4 ? width : 0, edges & 1 ? height : 0,
               &fixed_x, &fixed_y);
    struct mat4 placed = node_local_matrix(node, new_width, new_height, 0, 0);
    mat3_apply(mat4_plane(&placed), edges & 4 ? new_width : 0, edges & 1 ? new_height : 0,
               &offset_x, &offset_y);
    out[0] = fixed_x - offset_x;
    out[1] = fixed_y - offset_y;
    out[2] = new_width;
    out[3] = new_height;
}

static void update_node(struct server *server, struct manipulation *manipulation) {
    struct node *node = manipulation->node;
    struct scene *scene = &server->scene;
    double screen_x, screen_y;
    manipulation_point(server, manipulation, &screen_x, &screen_y);
    if (manipulation->kind == MANIPULATION_MOVE) {
        double px, py;
        parent_point(server, manipulation->output, node, screen_x, screen_y, &px, &py);
        double x = manipulation->origin_x + px - manipulation->anchor_x;
        double y = manipulation->origin_y + py - manipulation->anchor_y;
        node_jump(scene, node, PROP_X, x);
        node_jump(scene, node, PROP_Y, y);
        emit_box(server, node, EVENT_DRAG, x, y, false, 0, 0);
    } else {
        double box[4];
        resized_box(manipulation, node, screen_x, screen_y, box);
        node_jump(scene, node, PROP_X, box[0]);
        node_jump(scene, node, PROP_Y, box[1]);
        node_jump(scene, node, PROP_WIDTH, box[2]);
        node_jump(scene, node, PROP_HEIGHT, box[3]);
        window_configure(manipulation->window);
        emit_box(server, node, EVENT_RESIZE, box[0], box[1], true, box[2], box[3]);
    }
}

void manipulation_update(struct server *server) {
    struct manipulation *manipulation = *input_manipulation_slot(server, false);
    if (!manipulation) return;
    if (manipulation->kind == MANIPULATION_PAN) {
        update_pan(server, manipulation);
    } else {
        update_node(server, manipulation);
    }
    scene_changed(server);
}

void manipulation_end(struct server *server) {
    struct manipulation **slot = input_manipulation_slot(server, false);
    struct manipulation *manipulation = *slot;
    if (!manipulation) return;
    *slot = NULL;
    struct node *node = manipulation->node;
    if (manipulation->kind == MANIPULATION_PAN) {
        double vx, vy;
        release_velocity(manipulation, &vx, &vy);
        if (vx || vy) camera_fling(manipulation->output, vx, vy, now_seconds());
        cameras_report(server);
    } else {
        node_release(node, PROP_X);
        node_release(node, PROP_Y);
        node_release(node, PROP_WIDTH);
        node_release(node, PROP_HEIGHT);
        if (manipulation->kind == MANIPULATION_RESIZE)
            window_set_resizing(manipulation->window, false);
        if (node->state == NODE_LIVE) {
            double x = node_number(node, PROP_X, 0), y = node_number(node, PROP_Y, 0);
            if (manipulation->kind == MANIPULATION_MOVE) {
                emit_box(server, node, EVENT_DRAGEND, x, y, false, 0, 0);
            } else {
                double width, height;
                node_size(server, node, &width, &height);
                emit_box(server, node, EVENT_RESIZEEND, x, y, true, width, height);
            }
        }
    }
    manipulation_free(manipulation);
    scene_changed(server);
}

/* Camera input without a pointer grab. */

void wheel_zoom(struct server *server, double delta, bool wheel) {
    double x, y;
    struct output *output = input_pointer_output(server, &x, &y);
    if (!output) return;
    /* Notched wheels glide between steps; touchpads track exactly. */
    camera_zoom_at(output, exp2(-delta / 120), x, y, wheel ? camera_wheel_motion() : NULL,
                   now_seconds());
    cameras_report(server);
    scene_changed(server);
}

void wheel_pan(struct server *server, bool horizontal, double delta) {
    struct output *output = pointer_output(server);
    if (!output) return;
    if (horizontal) camera_pan(output, -delta, 0);
    else camera_pan(output, 0, -delta);
    cameras_report(server);
    scene_changed(server);
}

void gesture_manipulation_begin(struct server *server, int action) {
    struct output *output = pointer_output(server);
    if (!output) return;
    struct manipulation *manipulation =
        create(action == ACTION_ZOOM ? MANIPULATION_ZOOM : MANIPULATION_PAN, output);
    /* Pinch scale is relative to the gesture's start. */
    manipulation->last_x = 1;
    record_sample(manipulation, 0, 0);
    install(server, manipulation, true);
}

void gesture_manipulation_update(struct server *server, double dx, double dy, double scale) {
    struct manipulation *manipulation = *input_manipulation_slot(server, true);
    if (!manipulation) return;
    struct output *output = manipulation->output;
    if (manipulation->kind == MANIPULATION_ZOOM && scale > 0) {
        double x, y;
        manipulation_point(server, manipulation, &x, &y);
        camera_zoom_at(output, scale / manipulation->last_x, x, y, NULL, now_seconds());
        manipulation->last_x = scale;
    }
    camera_pan(output, dx, dy);
    const double *newest = manipulation->samples[manipulation->sample_count - 1];
    record_sample(manipulation, newest[1] + dx, newest[2] + dy);
    cameras_report(server);
    scene_changed(server);
}

void gesture_manipulation_end(struct server *server, bool cancelled) {
    struct manipulation **slot = input_manipulation_slot(server, true);
    struct manipulation *manipulation = *slot;
    if (!manipulation) return;
    *slot = NULL;
    if (manipulation->kind == MANIPULATION_PAN && !cancelled) {
        double vx, vy;
        release_velocity(manipulation, &vx, &vy);
        if (vx || vy) camera_fling(manipulation->output, vx, vy, now_seconds());
    }
    manipulation_free(manipulation);
    cameras_report(server);
    scene_changed(server);
}
