/*
 * Screen sharing transport: the desktop portal's ScreenCast backend on the
 * session bus and one PipeWire stream per running share, served by a thread of
 * its own. What to share and its pixels are the owner's business (`share.c`);
 * this module never touches GL or the scene. The owner thread never blocks on
 * it: requests arrive as events behind an eventfd, answers and frames leave as
 * queued commands. With no share running nothing wakes, and PipeWire is only
 * connected while a stream exists.
 *
 * Install `data/proscenium.portal` and `data/proscenium-portals.conf` so the
 * portal frontend routes ScreenCast here (see `data/README.md`).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SCREENCAST_BUS_NAME "org.freedesktop.impl.portal.desktop.proscenium"
/* Largest stream; larger sources should be scaled down to fit. */
#define SCREENCAST_MAX_WIDTH 3840
#define SCREENCAST_MAX_HEIGHT 2160

/* Portal source types, also the bits of a request's `sources`. */
enum screencast_source {
    SCREENCAST_MONITOR = 1,
    SCREENCAST_WINDOW = 2,
};

enum screencast_event_type {
    /* A client asks to share one of `sources`: screencast_accept or screencast_close it. */
    SCREENCAST_EVENT_REQUEST,
    /* The share ended (client, portal, PipeWire, a refusal or screencast_close); forget its id. */
    SCREENCAST_EVENT_CLOSED,
    /* A consumer started reading the stream; send a frame now even if the source is still. */
    SCREENCAST_EVENT_STREAMING,
    /* No consumer reads the stream any more; frames may stop until it streams again. */
    SCREENCAST_EVENT_PAUSED,
};

struct screencast_event {
    enum screencast_event_type type;
    uint32_t id;
    /* SCREENCAST_MONITOR and/or SCREENCAST_WINDOW: what the client accepts. */
    uint32_t sources;
    /* The requesting application's id as the portal knows it; often empty. */
    char app[256];
};

struct screencast;

/*
 * Start the bridge thread, which owns SCREENCAST_BUS_NAME on the session bus and
 * serves the portal. Returns at once; a bus that is missing or a name owned by
 * someone else is logged by the thread, and then no request ever arrives. NULL
 * only when the thread could not start.
 */
struct screencast *screencast_create(void);

/* Close every share (clients see their sessions close), release the bus name, join the thread. */
void screencast_destroy(struct screencast *screencast);

/* Readable while events wait; watch it in the event loop and drain with screencast_next_event. */
int screencast_get_fd(struct screencast *screencast);

/* Take the oldest event into *EVENT. False when none is left; call until it is. */
bool screencast_next_event(struct screencast *screencast, struct screencast_event *event);

/*
 * Grant request ID a WIDTH x HEIGHT stream (at most SCREENCAST_MAX_*) of SOURCE,
 * which must be one of the request's sources; a monitor reports its layout
 * position X, Y to the client, a window ignores them. An answer the request does
 * not allow refuses it instead. The client's Start returns once PipeWire exported
 * the stream; until the first frame arrives it shows black.
 */
void screencast_accept(struct screencast *screencast, uint32_t id, enum screencast_source source,
                       int32_t x, int32_t y, uint32_t width, uint32_t height);

/* Refuse request ID or stop its stream; the client sees its session close. */
void screencast_close(struct screencast *screencast, uint32_t id);

/*
 * Send share ID the frame in *PIXELS: WIDTH x HEIGHT RGBA pixels (bytes R, G, B, A;
 * top row first, rows packed) in a malloc'd buffer, which the bridge takes,
 * leaving in *PIXELS a buffer of the same size for the next frame. A frame of
 * another size than the accepted one is dropped, and a frame still queued for the
 * same share is replaced. The stream repeats nothing by itself: consumers see a
 * new frame only when one is pushed or repeated.
 */
void screencast_push_frame(struct screencast *screencast, uint32_t id, uint8_t **pixels,
                           uint32_t width, uint32_t height);
/* Send share ID's last frame again, which keeps a still stream alive without a copy. */
void screencast_repeat_frame(struct screencast *screencast, uint32_t id);
