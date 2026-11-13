/*
 * Remote access transport: a thread that serves the remote viewer page over
 * HTTP and HTTPS on one port, streams the frames it is given as H.264 over a
 * WebSocket to every viewer, and hands viewers' input back. It encodes with
 * the first of the GPU's H.264 encoders libavcodec can open (VA-API, NVENC,
 * V4L2 memory-to-memory), else with x264 tuned for zero latency;
 * PROSCENIUM_REMOTE_ENCODER names one to use instead.
 *
 * Like screencast.c it never touches GL or the scene: the owner captures pixels
 * and pushes them, and reads viewer events behind an eventfd. With no viewer
 * nothing is encoded. A viewer whose connection falls behind skips frames until
 * the next keyframe instead of queueing them, so latency stays bounded.
 *
 * Browsers decode with WebCodecs, which they offer only on secure origins: a
 * viewer on another machine opens the https:// address, whose certificate the
 * thread makes itself on first use and keeps under $XDG_STATE_HOME/proscenium.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct stream_options {
    /* Address to listen on: NULL or "" for every interface. */
    const char *address;
    int port;
    /* Target bit rate in kilobits a second, and the most frames a second. */
    int bitrate;
    int fps;
};

enum stream_event_type {
    /* The number of viewers changed to `viewers`. */
    STREAM_EVENT_VIEWERS,
    /* A viewer moved the pointer to (x, y), each 0..1 across the frame. */
    STREAM_EVENT_MOTION,
    /* A viewer pressed or released pointer button `code` (evdev). */
    STREAM_EVENT_BUTTON,
    /* A viewer scrolled (dx, dy): wheel notches if `discrete`, else pixels. */
    STREAM_EVENT_SCROLL,
    /* A viewer pressed or released key `code` (evdev). */
    STREAM_EVENT_KEY,
    /* A viewer lost focus or left: release whatever it holds. */
    STREAM_EVENT_RELEASE,
    /* A swipe of `fingers` begins, moves by (dx, dy), ends, or is cancelled, by `phase`. */
    STREAM_EVENT_SWIPE,
    /* A pinch likewise: its centre moves by (dx, dy), `scale` since it began, `rotation` degrees since the last. */
    STREAM_EVENT_PINCH,
};

enum stream_phase { STREAM_BEGIN, STREAM_UPDATE, STREAM_END, STREAM_CANCEL };

struct stream_event {
    enum stream_event_type type;
    int viewers;
    double x, y, dx, dy;
    uint32_t code;
    bool pressed, discrete;
    enum stream_phase phase;
    uint32_t fingers;
    double scale, rotation;
};

enum stream_format {
    /* Bytes R, G, B, A, rows packed. */
    STREAM_RGBA,
    /* Planar 4:2:0, limited-range BT.709: Y, then U, then V, rows packed. */
    STREAM_I420,
};

/* Bytes in a WIDTH x HEIGHT frame of FORMAT. */
static inline size_t stream_frame_size(enum stream_format format, int width, int height) {
    size_t pixels = (size_t)width * height;
    return format == STREAM_I420 ? pixels * 3 / 2 : pixels * 4;
}

struct stream;

/* Listen, then start the thread. NULL, with the reason logged, when the port cannot be bound. */
struct stream *stream_create(const struct stream_options *options);
void stream_destroy(struct stream *stream);

/* Readable while events wait; drain with stream_next_event. */
int stream_get_fd(struct stream *stream);
bool stream_next_event(struct stream *stream, struct stream_event *event);

/*
 * Stream the frame in *PIXELS: WIDTH x HEIGHT of FORMAT, top row first, both sides
 * even, in a malloc'd buffer, which the thread takes, leaving in *PIXELS a buffer
 * of the same size for the next frame. A frame not yet encoded when the next
 * arrives is dropped for it.
 */
void stream_push_frame(struct stream *stream, uint8_t **pixels, enum stream_format format,
                       int width, int height);

/* The pointer's shape as a CSS cursor name, which viewers show over the stream. */
void stream_set_cursor(struct stream *stream, const char *name);

/* The URL viewers on this machine open, for the log. */
const char *stream_local_url(struct stream *stream);
