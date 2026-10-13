/*
 * Per-output cameras.
 *
 * A camera is compositor state, not a scene node. Direct manipulation moves it
 * in the same frame as the input, without a director round trip, and it
 * survives remounts, reloads and director restarts. <Camera> nodes declare
 * targets, zoom limits and the transition for programmatic moves; the director
 * observes the camera through coalesced reports of its targets.
 */
#include <math.h>
#include <stdio.h>

#include "link.h"
#include "stage.h"

#define FLING_TIME_CONSTANT 0.25

struct camera {
    struct channel x, y;
    /* The logarithm of the zoom factor, so zoom animates at an even pace. */
    struct channel zoom;
    struct channel rotation;
    double min_zoom, max_zoom;
    /* Programmatic moves; the default spring when no camera node gives one. */
    struct motion *motion;
    /* Values last applied from camera nodes, to apply only changed declarations. */
    bool declared_has[4];
    double declared[4];
    /* A world point held under a screen point while zoom animates. */
    bool anchored;
    double anchor_world_x, anchor_world_y, anchor_screen_x, anchor_screen_y;
    /* An unplaced camera maps world coordinates to output pixels. */
    bool placed;
    bool reported;
    double report[4];
};

static struct motion *default_motion(void) {
    static struct motion *motion;
    if (!motion) {
        motion = motion_create(MOTION_SPRING);
        motion->stiffness = 195;
        motion->damping = 25.7;
    }
    return motion;
}

struct camera *camera_create(void) {
    struct camera *camera = xcalloc(1, sizeof *camera);
    channel_init(&camera->x, 0, 1e-2);
    channel_init(&camera->y, 0, 1e-2);
    channel_init(&camera->zoom, 0, 1e-4);
    channel_init(&camera->rotation, 0, 1e-4);
    camera->min_zoom = 0.05;
    camera->max_zoom = 8;
    return camera;
}

void camera_destroy(struct camera *camera) {
    if (!camera) return;
    channel_finish(&camera->x);
    channel_finish(&camera->y);
    channel_finish(&camera->zoom);
    channel_finish(&camera->rotation);
    motion_unref(camera->motion);
    free(camera);
}

static double zoom_of(const struct camera *camera) {
    return exp(camera->zoom.value);
}

struct mat3 camera_transform(struct output *output) {
    struct camera *camera = output->camera;
    return view_transform(camera->x.value, camera->y.value, zoom_of(camera), camera->rotation.value,
                          output->width, output->height);
}

void camera_world_point(struct output *output, double x, double y, double *world_x,
                        double *world_y) {
    struct mat3 inverse;
    if (mat3_invert(camera_transform(output), &inverse)) {
        mat3_apply(inverse, x, y, world_x, world_y);
    } else {
        *world_x = x;
        *world_y = y;
    }
}

/* World-space displacement shown as the screen-space (dx, dy) at ZOOM. */
static void world_delta(const struct camera *camera, double dx, double dy, double zoom,
                        double *out_x, double *out_y) {
    double rotation = camera->rotation.value;
    *out_x = (cos(rotation) * dx - sin(rotation) * dy) / zoom;
    *out_y = (sin(rotation) * dx + cos(rotation) * dy) / zoom;
}

/* Camera centre keeping the anchor's world point under its screen point at ZOOM. */
static void anchored_center(const struct camera *camera, const struct output *output, double zoom,
                            double *x, double *y) {
    double dx, dy;
    world_delta(camera, camera->anchor_screen_x - output->width / 2,
                camera->anchor_screen_y - output->height / 2, zoom, &dx, &dy);
    *x = camera->anchor_world_x - dx;
    *y = camera->anchor_world_y - dy;
}

/* Keep the anchor under its screen point now, aiming x/y where it holds at the zoom target. */
static void follow_anchor(struct camera *camera, const struct output *output) {
    double x, y;
    anchored_center(camera, output, zoom_of(camera), &x, &y);
    channel_jump(&camera->x, x);
    channel_jump(&camera->y, y);
    anchored_center(camera, output, exp(camera->zoom.target), &x, &y);
    camera->x.target = x;
    camera->y.target = y;
}

void camera_sample(struct output *output, double time) {
    struct camera *camera = output->camera;
    bool zooming = channel_sample(&camera->zoom, time);
    channel_sample(&camera->rotation, time);
    if (camera->anchored) {
        follow_anchor(camera, output);
        if (!zooming) camera->anchored = false;
    } else {
        channel_sample(&camera->x, time);
        channel_sample(&camera->y, time);
    }
}

bool camera_moving(struct output *output) {
    struct camera *camera = output->camera;
    return channel_active(&camera->x) || channel_active(&camera->y) ||
           channel_active(&camera->zoom) || channel_active(&camera->rotation);
}

static double clamp_zoom(const struct camera *camera, double zoom) {
    return CLAMP(zoom, camera->min_zoom, camera->max_zoom);
}

void camera_center_unplaced(struct output *output) {
    struct camera *camera = output->camera;
    if (camera->placed) return;
    channel_jump(&camera->x, output->width / 2);
    channel_jump(&camera->y, output->height / 2);
}

void camera_move(struct output *output, const struct camera_move *move, double time) {
    struct camera *camera = output->camera;
    struct motion *motion = move->motion     ? move->motion
                            : camera->motion ? camera->motion
                                             : default_motion();
    camera->anchored = false;
    camera->placed = true;
    if (move->has[CAMERA_X]) channel_retarget(&camera->x, move->values[CAMERA_X], motion, time);
    if (move->has[CAMERA_Y]) channel_retarget(&camera->y, move->values[CAMERA_Y], motion, time);
    if (move->has[CAMERA_ZOOM])
        channel_retarget(&camera->zoom, log(clamp_zoom(camera, move->values[CAMERA_ZOOM])), motion,
                         time);
    if (move->has[CAMERA_ROTATION])
        channel_retarget(&camera->rotation, move->values[CAMERA_ROTATION], motion, time);
}

void camera_pan(struct output *output, double dx, double dy) {
    struct camera *camera = output->camera;
    camera->placed = true;
    if (camera->anchored) {
        /* Panning during a zoom moves the anchor's screen point with the content. */
        camera->anchor_screen_x += dx;
        camera->anchor_screen_y += dy;
        follow_anchor(camera, output);
        return;
    }
    double world_dx, world_dy;
    world_delta(camera, dx, dy, zoom_of(camera), &world_dx, &world_dy);
    channel_jump(&camera->x, camera->x.value - world_dx);
    channel_jump(&camera->y, camera->y.value - world_dy);
}

void camera_fling(struct output *output, double vx, double vy, double time) {
    struct camera *camera = output->camera;
    if (camera->anchored) return;
    double zoom = zoom_of(camera), world_x, world_y;
    /* Coast until less than half a screen pixel remains. */
    world_delta(camera, vx, vy, zoom, &world_x, &world_y);
    channel_fling(&camera->x, -world_x, FLING_TIME_CONSTANT, 0.5 / zoom, time);
    channel_fling(&camera->y, -world_y, FLING_TIME_CONSTANT, 0.5 / zoom, time);
}

void camera_settle(struct output *output, double time) {
    struct camera *camera = output->camera;
    channel_sample(&camera->x, time);
    channel_sample(&camera->y, time);
    channel_jump(&camera->x, camera->x.value);
    channel_jump(&camera->y, camera->y.value);
}

void camera_zoom_at(struct output *output, double factor, double x, double y, struct motion *motion,
                    double time) {
    struct camera *camera = output->camera;
    double target = clamp_zoom(camera, exp(camera->zoom.target) * factor);
    channel_sample(&camera->zoom, time);
    if (!(camera->anchored && camera->anchor_screen_x == x && camera->anchor_screen_y == y)) {
        camera_world_point(output, x, y, &camera->anchor_world_x, &camera->anchor_world_y);
        camera->anchor_screen_x = x;
        camera->anchor_screen_y = y;
        camera->anchored = true;
    }
    camera->placed = true;
    channel_retarget(&camera->zoom, log(target), motion, time);
    follow_anchor(camera, output);
    if (!channel_active(&camera->zoom)) camera->anchored = false;
}

/* A short glide between discrete wheel steps; continuous input zooms at once. */
struct motion *camera_wheel_motion(void) {
    static struct motion *motion;
    if (!motion) {
        motion = motion_create(MOTION_TWEEN);
        motion->duration = 0.14;
        motion->eased = true;
        motion->ease[0] = 0, motion->ease[1] = 0, motion->ease[2] = 0.58, motion->ease[3] = 1;
    }
    return motion;
}

void camera_apply_node(struct output *output, struct node *node, double time) {
    struct camera *camera = output->camera;
    static const enum prop_key keys[4] = {PROP_X, PROP_Y, PROP_ZOOM, PROP_ROTATION};
    camera->min_zoom = fmax(1e-4, node_number(node, PROP_MIN_ZOOM, 0.05));
    camera->max_zoom = fmax(camera->min_zoom, fmin(1e4, node_number(node, PROP_MAX_ZOOM, 8)));
    motion_unref(camera->motion);
    camera->motion = motion_ref(node->default_motion);
    struct camera_move move = {0};
    bool changed = false;
    for (int i = 0; i < 4; i++) {
        bool given = node_given(node, keys[i]);
        double value = node->props[keys[i]].number;
        if (given && !(camera->declared_has[i] && camera->declared[i] == value)) {
            move.has[i] = true;
            move.values[i] = value;
            changed = true;
        }
        camera->declared_has[i] = given;
        camera->declared[i] = value;
    }
    if (!changed) return;
    /* The first placement is immediate; later declarations animate. */
    struct motion *instant = NULL;
    if (!camera->placed) move.motion = instant = motion_create(MOTION_INSTANT);
    camera_move(output, &move, time);
    motion_unref(instant);
}

/* Where OUTPUT's camera is headed, as reported. */
static void camera_report_values(struct output *output, double report[4]) {
    struct camera *camera = output->camera;
    report[0] = camera->x.target;
    report[1] = camera->y.target;
    report[2] = exp(camera->zoom.target);
    report[3] = camera->rotation.target;
}

/* OUTPUT's camera as fields of the object WRITER has open, remembered as reported. */
static void camera_fields(struct output *output, struct json_writer *writer) {
    struct camera *camera = output->camera;
    double report[4];
    camera_report_values(output, report);
    camera->reported = true;
    memcpy(camera->report, report, sizeof report);
    json_key(writer, "output");
    json_string(writer, output_name(output));
    json_key(writer, "x");
    json_number(writer, report[0]);
    json_key(writer, "y");
    json_number(writer, report[1]);
    json_key(writer, "zoom");
    json_number(writer, report[2]);
    json_key(writer, "rotation");
    json_number(writer, report[3]);
}

void camera_describe(struct output *output, struct json_writer *writer) {
    json_object_begin(writer);
    camera_fields(output, writer);
    json_object_end(writer);
}

void cameras_report(struct server *server) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        double report[4];
        camera_report_values(output, report);
        if (output->camera->reported && !memcmp(report, output->camera->report, sizeof report))
            continue;
        struct message message;
        message_begin(&message, "camera");
        camera_fields(output, &message.writer);
        char key[96];
        snprintf(key, sizeof key, "camera/%s", output_name(output));
        message_send(server, &message, key);
    }
}
