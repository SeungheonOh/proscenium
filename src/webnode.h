/*
 * Web nodes: pages rendered by Chromium inside the scene.
 *
 * Each web node owns one page; a replacement node with the same source adopts
 * it, so reloading the world keeps its pages running. A page is drawn like a
 * window's surface and takes input like one. A page no output shows is hidden,
 * so Chromium stops painting it, and its raster scale follows its on-screen
 * scale once that settles.
 */
#pragma once

#include <stdbool.h>

#include "geometry.h"
#include "render.h"
#include "server.h"

struct web_page;

/* The page NODE shows, or NULL. */
struct web_page *web_node_page(struct node *node);
bool web_page_has_frame(struct web_page *page);
/* Page coordinates to NODE's local WIDTH x HEIGHT box. */
struct mat3 web_node_content(struct web_page *page, double width, double height);
/* OUTPUT's frame shows NODE's page at SCALE device pixels per local unit; SETTLED once
 * that scale stopped changing. The page rasters at it once it has held still a moment. */
void web_node_presented(struct node *node, struct output *output, double scale, bool settled,
                        double width);
/* Draw NODE's page over its WIDTH x HEIGHT box through TRANSFORM, through FILTER unless it
 * is NULL. */
void web_node_draw(struct server *server, struct node *node, struct mat3 transform, double width,
                   double height, double radius, double opacity,
                   const struct render_shading *filter, struct render_report *report);
/* Give every web node its page after a commit: pages of nodes that left go to new nodes
 * with the same source; the rest close. */
void web_refresh_nodes(struct server *server, struct vec *nodes);
void web_node_dead(struct server *server, struct node *node);
/*
 * A node with a frameTag moves with its page's frames: while the page shows a frame
 * marked with an earlier number of the node's, CHAIN, WIDTH and HEIGHT become the
 * transform and size the node had with that number, kept within SPACE (the camera's, for
 * the canvas), so each frame shows where it was drawn for as the camera moves, and the
 * node moves the moment the frame drawn for its new place comes. A frame with a number
 * it does not remember, or after a second, shows where the node is.
 */
void web_node_hold(struct node *node, const struct mat4 *space, const struct mat4 *space_inverse,
                   struct mat4 *chain, double *width, double *height);
/* Upload new frames of the pages OUTPUT shows, damaging what changed wherever they show. */
void web_prepare(struct server *server, struct output *output);
/* Record which pages OUTPUT's frame showed; hide those no output shows. */
void web_sync_presence(struct server *server, struct output *output);
void web_output_removed(struct server *server, struct output *output);
void web_finish(struct server *server);
