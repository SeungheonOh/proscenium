/*
 * Per-output display lists, damage, frames and pick targets.
 *
 * Each frame flattens the scene into draw items in buffer space. Comparing
 * their signatures with the previous frame yields exactly the damage from scene
 * edits and animation; client damage is projected through the same transforms.
 * The walk also records pick targets, so input resolves against what was last
 * presented.
 */
#pragma once

#include <pixman.h>
#include <stdbool.h>

#include "geometry.h"
#include "server.h"

struct wlr_buffer;
struct wlr_surface;

struct display *display_create(struct output *output);
/* Start building SHADER's program, if the renderer can now, on the driver's threads. */
void display_prepare_shader(struct server *server, struct shader *shader);
void display_destroy(struct display *display);

/* Draw OUTPUT's frame into BUFFER, whose framebuffer is bound; DAMAGE receives the
 * buffer region the frame changed. False when the frame changed nothing and no
 * client waits for it, so it need not be shown. */
bool display_render(struct output *output, struct wlr_buffer *buffer, pixman_region32_t *damage);
/* Before the commit: the surfaces the frame shows, which presentation feedback then reports. */
void display_frame_feedback(struct output *output);
/* After the commit: frame callbacks, or the damage back on failure. */
void display_frame_done(struct output *output, bool committed, const pixman_region32_t *damage);

void display_add_damage(struct output *output, const pixman_region32_t *damage);
void display_damage_whole(struct output *output);
void display_invalidate(struct output *output);

/* Pick targets for OUTPUT, topmost first, as the scene presents now; while a frame is
 * on its way, those of the frame on screen. */
struct hit *display_hits(struct output *output, size_t *count);
/* Whether OUTPUT's display has shaders reading the pointer, which its motion rebuilds. */
bool display_pointer_shaders(struct output *output);

/* WINDOW's content to OUTPUT's logical pixels, as last presented. */
bool display_window_logical_transform(struct output *output, struct window *window,
                                      struct mat3 *out);
/* Project damage in CLIENT's content coordinates (a struct window or struct web_page)
 * onto every output showing it. */
void displays_damage_client(struct server *server, void *client, const pixman_region32_t *damage);
void displays_forget_window(struct server *server, struct window *window);
void displays_forget_surface(struct server *server, struct wlr_surface *surface);
bool display_shows_client(struct output *output, void *client);
void display_forget_client(struct output *output, void *client);
/* Whether OUTPUT's last frame showed something moving; endless loops wake only these. */
bool display_animating(struct output *output);
/* Repaint where NODE's text shows on OUTPUT; inside an effect, the effect paints it.
 * False when the node is not shown there. */
bool display_damage_node(struct output *output, struct node *node);
/* The earliest time any output's cached display was built. */
double displays_built_at(struct server *server);
/* Offscreen targets a capture reuses while its size stays. */
struct display_targets {
    struct render_target *full, *scaled;
};
void display_release_targets(struct display_targets *targets);
/*
 * Read OUTPUT's REGION (output-logical pixels) as the scene presents it now,
 * scaled to WIDTH x HEIGHT, into PIXELS: RGBA, top row first. GL must be current.
 */
bool display_read_region(struct output *output, struct box region, int width, int height,
                         void *pixels, struct display_targets *targets);
/* Read WINDOW's content BOUNDS scaled to WIDTH x HEIGHT into PIXELS likewise. */
bool display_read_window(struct server *server, struct window *window, struct box bounds, int width,
                         int height, void *pixels, struct display_targets *targets);
