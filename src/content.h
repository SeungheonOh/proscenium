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
/* SLOT's raster for KEY on output OUTPUT_INDEX, or one at another scale while the
 * worker renders it. */
struct render_raster *content_text_raster(struct server *server, struct node *node,
                                          int output_index, uint64_t slot, uint64_t key,
                                          double scale, const double color[4]);

/* The image NODE shows, or NULL. */
struct media_image *content_image(struct server *server, struct node *node);
/* Whether IMAGE has pixels to draw now; released ones decode again. */
bool content_image_shown(struct server *server, struct media_image *image);
struct render_raster *content_image_raster(struct server *server, struct node *node);
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
