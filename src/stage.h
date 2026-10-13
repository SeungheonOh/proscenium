/*
 * What the director protocol asks of the compositor's modules: cameras, window
 * and output descriptions, screenshots, shares, the clipboard and text sizes.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include <wlr/util/box.h>

#include "json.h"
#include "props.h"
#include "server.h"

struct display_targets;
struct motion;

static inline struct box box_of(struct wlr_box b) {
    return (struct box){b.x, b.y, b.width, b.height};
}

/* What a screenshot or a share shows: a window, or an output or a region of one. */
struct capture_source {
    struct window *window;
    struct output *output;
    bool has_region;
    struct box region; /* output-logical pixels */
};

/* A programmatic camera move; fields not given keep the camera's target. */
enum { CAMERA_X, CAMERA_Y, CAMERA_ZOOM, CAMERA_ROTATION };
struct camera_move {
    bool has[4];
    double values[4];
    struct motion *motion;
};

/* camera.c */
struct camera *camera_create(void);
void camera_destroy(struct camera *camera);
void camera_move(struct output *output, const struct camera_move *move, double time);
/* OUTPUT's camera as an object, which counts as reporting it. */
void camera_describe(struct output *output, struct json_writer *writer);
/* Report each camera headed elsewhere than last reported. */
void cameras_report(struct server *server);
/* World space to OUTPUT's logical space, as the camera shows it now. */
struct mat3 camera_transform(struct output *output);
bool camera_moving(struct output *output);
void camera_sample(struct output *output, double time);
void camera_apply_node(struct output *output, struct node *node, double time);
void camera_center_unplaced(struct output *output);
/* Native manipulation of a camera: pan by a logical delta, zoom about a point. */
void camera_pan(struct output *output, double dx, double dy);
/* Zoom about a point with MOTION, or at once without. */
void camera_zoom_at(struct output *output, double factor, double x, double y, struct motion *motion,
                    double time);
/* The short glide between notches of a wheel zoom. */
struct motion *camera_wheel_motion(void);
void camera_fling(struct output *output, double vx, double vy, double time);
void camera_settle(struct output *output, double time);
void camera_world_point(struct output *output, double x, double y, double *world_x,
                        double *world_y);

/* link.c and the modules it reaches */
bool link_scene_active(struct link *link);
void director_detached(struct server *server, bool was_active);
void modifiers_write(uint32_t modifiers, struct json_writer *writer);
void windows_describe(struct server *server, struct json_writer *writer);

/* stage.c */
/* The scene's callbacks, DATA being the server. */
bool stage_natural_value(void *data, struct node *node, enum prop_key key, double *out);
void stage_node_size(void *data, const struct node *node, double *width, double *height);
void stage_node_dead(void *data, struct node *node);
/* Tell the director, once per shader, that SHADER of NODE failed to build. */
void shader_report_error(struct server *server, struct node *node, const struct shader *shader,
                         const char *error);

/* share.c */
void share_init(struct server *server);
void share_finish(struct server *server);
void shares_describe(struct server *server, struct json_writer *writer);
bool share_accept(struct server *server, uint32_t id, const struct capture_source *source,
                  struct protocol_error *error);
void share_cancel(struct server *server, uint32_t id);
/* OUTPUT presented a frame changing DAMAGE, in buffer pixels. */
void share_output_presented(struct server *server, struct output *output,
                            const pixman_region32_t *damage);
void share_output_removed(struct server *server, struct output *output);
void share_window_changed(struct server *server, struct window *window);
void share_window_gone(struct server *server, struct window *window);

/* capture.c */
void capture_for_director(struct server *server, int64_t id, const struct capture_source *source);
/* WIDTH x HEIGHT scaled down, keeping its aspect, to fit LIMIT_WIDTH x LIMIT_HEIGHT. */
void fit_size(int width, int height, int limit_width, int limit_height, int *out_width,
              int *out_height);
/* The source's layout position and size in pixels at the scale it is shown at. */
bool capture_source_size(const struct capture_source *source, int *x, int *y, int *width,
                         int *height, struct protocol_error *error);
/* Read the source, a window's content WINDOW_BOUNDS, scaled to WIDTH x HEIGHT RGBA. */
bool capture_read(struct server *server, const struct capture_source *source,
                  struct box window_bounds, int width, int height, void *pixels,
                  struct display_targets *targets);

/* clipboard.c */
void clipboard_set_text(struct server *server, const char *text, size_t length);
/* Offer the file at PATH, which the director handed over in its runtime directory, as
 * MIME; the compositor reads and deletes it. */
bool clipboard_set_file(struct server *server, const char *mime, const char *path,
                        struct protocol_error *error);
