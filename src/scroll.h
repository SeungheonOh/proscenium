/*
 * Scroll containers whose offset the compositor owns, as CSS `overflow: auto`:
 * a group with `scroll` moves its children by the offset and clips them to its
 * box. Wheel notches glide, fingers track one to one and leave momentum when
 * they lift, a pull past an end stretches and settles back, and what one
 * container cannot take passes to the one around it. Thumbs are ordinary child
 * nodes with `scrollThumb`, which the compositor places along the track and
 * shows while scrolling.
 */
#pragma once

#include <stdbool.h>

#include "server.h"

struct wlr_pointer_axis_event;
struct motion;

/* Whether NODE or an ancestor scrolls. */
bool scroll_inside(const struct node *node);
/* The offset NODE's children show at, rounded to OUTPUT's pixels; false when NODE does not
 * scroll. */
bool scroll_offset(struct output *output, const struct node *node, double *x, double *y);
/* Where THUMB, a scroll thumb, shows in its container: its box and how much it shows.
 * False when THUMB is not one. */
bool scroll_thumb_place(const struct node *thumb, double *x, double *y, double *width,
                        double *height, double *opacity);
/* The thumb NODE is or lies in, or NULL. */
struct node *scroll_thumb_of(const struct node *node);

/* A wheel or finger EVENT over NODE: the containers around it take what they can, the
 * innermost first. True when one took it. */
bool scroll_axis(struct server *server, struct node *node,
                 const struct wlr_pointer_axis_event *event);
/* After a commit: NODE's offset keeps within its content, or to its end with stickToEnd. */
void scroll_refresh(struct server *server, struct node *node);
/* Move NODE's offset to X and Y where HAS says, with MOTION or at once. */
bool scroll_to(struct server *server, struct node *node, const bool has[2], const double at[2],
               struct motion *motion, struct protocol_error *error);
/* Scroll the containers around NODE so its box is in view, as keyboard focus does. */
void scroll_into_view(struct server *server, struct node *node);

/* The pointer is over HIT now (or nothing): a thumb under it stays shown. */
void scroll_hover(struct server *server, struct node *hit);
/* A press on THUMB at (X, Y) in its container's space starts dragging it. */
void scroll_drag_begin(struct server *server, struct node *thumb, double x, double y);
/* The thumb's container, while one is dragged. */
struct node *scroll_dragged(void);
/* The pointer at (X, Y) in the container's space drags the thumb on. */
void scroll_drag_update(struct server *server, double x, double y);
void scroll_drag_end(struct server *server);
void scroll_node_dead(struct server *server, struct node *node);
void scroll_finish(struct server *server);
