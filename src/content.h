/*
 * Text and image nodes on top of the media module: cached layouts, rasters per
 * output at the scale they are seen, and images shared by path.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "geometry.h"
#include "media.h"
#include "render.h"
#include "server.h"

void content_init(struct server *server);
/* The size of the text that PROPS, a JSON object of Text props or NULL, declares. */
bool content_measure_text(struct server *server, const struct json_value *props, double *width,
                          double *height, struct protocol_error *error);
void content_finish(struct server *server);

/* NODE's text layout, measured again only after its style changed; NULL for none. */
const struct media_text_layout *content_text_layout(struct server *server, struct node *node);
/* Straight-alpha text color into COLOR; undeclared text is black. Return its alpha. */
double content_text_color(const struct node *node, double color[4]);
/* Identifies a raster of LAYOUT in COLOR at SCALE. */
uint64_t content_text_key(const struct media_text_layout *layout, const double color[4],
                          double scale);
/* The raster scale for text drawn at EXACT device pixels per logical pixel, with
 * EXTENT its largest logical side: EXACT once still, in half-octave steps while it
 * is CHANGING. */
double content_raster_scale(double exact, bool changing, double extent);
/*
 * Frames. The main thread decides what is uploaded where the renderer draws: rasters by
 * slot. What a frame needs goes with it as uploads, put in place before it draws, in
 * order.
 */
enum content_upload_kind {
    CONTENT_RASTER,
    CONTENT_DROP_RASTER,
};

struct content_upload {
    enum content_upload_kind kind;
    uint64_t slot;
    /* A raster's pixels, owned, in FORMAT. */
    struct media_pixels pixels;
    GLenum format;
};

/* Keep SLOT's raster, if any: its text is shown, if not drawn again. */
void content_touch_raster(struct server *server, uint64_t slot);
/* Start preparing a frame: UPLOADS takes what earlier work left (rasters dropped), and the
 * frame's time for rasterizing new text starts. */
void content_frame_begin(struct server *server, struct vec *uploads);
/* Put UPLOADS in place, where the renderer draws. */
void content_apply_uploads(struct renderer *renderer, const struct vec *uploads);
/* Free what UPLOADS hold, on the main thread. */
void content_free_uploads(struct vec *uploads);

/*
 * Whether SLOT holds a raster of NODE's text to draw: KEY's, or one at another scale
 * while the worker renders it, at RASTER_SCALE; with what it needs in UPLOADS.
 */
bool content_text_prepare_raster(struct server *server, struct node *node, int output_index,
                                 uint64_t slot, uint64_t key, double scale, const double color[4],
                                 struct vec *uploads, double *raster_scale);

/* The image NODE shows, or NULL. */
struct media_image *content_image(struct server *server, struct node *node);
/* Whether IMAGE has pixels to draw now; released ones decode again. */
bool content_image_shown(struct server *server, struct media_image *image);
/* Whether NODE's image has a raster to draw, in SLOT, with what it needs in UPLOADS. */
bool content_image_prepare(struct server *server, struct node *node, struct vec *uploads,
                           uint64_t *slot);
/* Local quad and corner UVs presenting IMAGE in a WIDTH x HEIGHT box for FIT. */
void content_image_fit(int fit, const struct media_image *image, double width, double height,
                       struct box *quad, double uv[8]);

/* Measure or resolve NODE after a commit, reporting results its handlers wait for. */
void content_refresh_node(struct server *server, struct node *node);
void content_node_dead(struct server *server, struct node *node);
/* Release pixels no frame drew for a while. */
void content_release_stale(struct server *server);
/* A text or image node's size. */
void content_node_size(struct server *server, struct node *node, double *width, double *height);
