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

/*
 * A frame: built on the main thread, drawn where the renderer draws, shown by a commit.
 * It holds what it draws, so the main thread can build the next one while it draws.
 */
struct display_frame;
/* Build OUTPUT's next frame, to draw into BUFFER, which the caller holds until the frame
 * is freed, with motion as it is at TIME, when the frame will show. */
struct display_frame *display_build(struct output *output, struct wlr_buffer *buffer, double time);
/* Draw FRAME, then DONE(FRAME, DATA) on the main thread: at once when the main thread draws
 * or waits for it, else from the event loop once the render thread drew it. */
void display_draw(struct display_frame *frame,
                  void (*done)(struct display_frame *frame, void *data), void *data);
/* False when it changed nothing and no client waits for it, so it need not be shown. */
bool display_frame_shown(const struct display_frame *frame);
/* Whether its buffer holds it: drawn, or nothing to draw. False when the buffer could not
 * be drawn into, and must not be shown. */
bool display_frame_drew(const struct display_frame *frame);
/* The buffer region it changes. */
const pixman_region32_t *display_frame_damage(const struct display_frame *frame);
/* Milliseconds building it took on the main thread, and drawing it. */
void display_frame_times(const struct display_frame *frame, double *build_ms, double *draw_ms);
/* Before the commit: the surfaces it shows, which presentation feedback then reports. */
void display_frame_feedback(struct display_frame *frame);
/* After the commit: frame callbacks, or its damage back on failure. */
void display_frame_done(struct display_frame *frame, bool committed);
void display_frame_free(struct display_frame *frame);

void display_add_damage(struct output *output, const pixman_region32_t *damage);
/*
 * Have TAP(FRAMEBUFFER, WIDTH, HEIGHT, DATA) called after each frame of OUTPUT is
 * drawn: on the thread that drew it, its context current and FRAMEBUFFER (the
 * output buffer, WIDTH x HEIGHT pixels) bound, before software cursors go over
 * it. NULL stops it; frames already built may still call the old one.
 */
typedef void (*display_tap)(unsigned int framebuffer, int width, int height, void *data);
void display_set_tap(struct output *output, display_tap tap, void *data);
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
void display_release_targets(struct server *server, struct display_targets *targets);
/*
 * Read OUTPUT's REGION (output-logical pixels) as the scene presents it now,
 * scaled to WIDTH x HEIGHT, into PIXELS: RGBA, top row first. GL must be current.
 */
bool display_read_region(struct output *output, struct box region, int width, int height,
                         void *pixels, struct display_targets *targets);
/* Read WINDOW's content BOUNDS scaled to WIDTH x HEIGHT into PIXELS likewise. */
bool display_read_window(struct server *server, struct window *window, struct box bounds, int width,
                         int height, void *pixels, struct display_targets *targets);
