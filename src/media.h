/*
 * Text and images for scene nodes. Pango lays text out in logical pixels with
 * metric hinting off, so a layout measures the same at every zoom and only its
 * raster scale changes. A worker thread decodes images and rasterizes text off
 * the owner thread, handing results back through an eventfd. Nothing here
 * touches GL or wlroots: callers upload the pixels it returns.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Longest edge of any text or image texture, in pixels. */
#define MEDIA_MAX_RASTER_PIXELS 4096
/* Seconds decoded image pixels wait to be drawn before they are released. */
#define MEDIA_IMAGE_LIFETIME 30.0

struct media;
struct media_job;
struct media_image;

/* Byte order of 8-bit premultiplied pixels. */
enum media_pixel_format {
    /* Cairo ARGB32 on little-endian: GL_BGRA_EXT, DRM_FORMAT_ARGB8888. */
    MEDIA_PIXELS_BGRA,
    /* gdk-pixbuf order: GL_RGBA, DRM_FORMAT_ABGR8888. */
    MEDIA_PIXELS_RGBA,
};

/* Premultiplied pixels this module allocated; DATA is NULL when there are none. */
struct media_pixels {
    uint8_t *data;
    int width, height, stride;
    enum media_pixel_format format;
    /* Private: what owns DATA and how to free it. */
    void *owner;
    void (*release)(void *owner);
};

/* Free PIXELS' memory and clear them; harmless on cleared pixels. */
void media_pixels_finish(struct media_pixels *pixels);

/*
 * The media state of a compositor: the owner thread's Pango context, the shared
 * images and the worker, which starts with the first job. IMAGE_DONE runs on
 * the owner thread, from media_dispatch, when a decode of a current image
 * finished; FIRST says its natural size has just become known. NULL when no
 * eventfd can be made.
 */
struct media *media_create(void (*image_done)(void *data, struct media_image *image, bool first),
                           void *data);
/*
 * Stop the worker, waiting for a job in progress, and free every job and result
 * not yet delivered. Job handles become invalid; images still acquired lose
 * their pixels and stay valid until released.
 */
void media_destroy(struct media *media);
/* An eventfd the event loop watches: readable when worker results wait for media_dispatch. */
int media_get_fd(struct media *media);
/* Deliver finished jobs on the owner thread, in completion order. */
void media_dispatch(struct media *media);
/*
 * Cancel JOB, wherever it is: a queued job never runs, a running one frees its
 * result when it ends, a finished one is freed undelivered. Inside the job's own
 * callback it does nothing; once that returns, the handle is gone.
 */
void media_job_cancel(struct media *media, struct media_job *job);

/* Text. */

enum media_align {
    MEDIA_ALIGN_START,
    MEDIA_ALIGN_CENTER,
    MEDIA_ALIGN_END,
};

/*
 * How a text lays out, as decoded from a node's props; strings are borrowed.
 * Values stay within what Pango's integer units hold: size within
 * [1, 2048], weight rounded into [100, 1000], width [1, 100000], line height
 * [0.1, 10], max lines at most 10000.
 */
struct media_text_style {
    const char *text; /* NULL: empty. */
    bool markup;      /* TEXT is Pango markup; markup that does not parse shows as plain text. */
    const char *font; /* Family list; NULL: "sans-serif". */
    double size;      /* Logical pixels. */
    double weight;    /* CSS weight. */
    bool italic;
    enum media_align align;
    double width;       /* Wrap width in logical pixels; <= 0: one line per paragraph. */
    double line_height; /* Line pitch as a multiple of SIZE, as in CSS; <= 0: the font's. */
    int max_lines;      /* With a width, end with an ellipsis after this many lines; 0: no limit. */
};

#define MEDIA_TEXT_STYLE_DEFAULT ((struct media_text_style){.size = 14, .weight = 400})

/* Straight-alpha color, each channel in [0, 1]. */
struct media_color {
    double r, g, b, a;
};

/* A laid-out text, in logical pixels relative to the layout's origin. */
struct media_text_metrics {
    /* Logical size: the box the text occupies, and what `measure` answers. */
    double width, height;
    /* Space added between lines for the style's line height. */
    double spacing;
    /* Rectangle covering every inked and logical pixel; may reach outside the box. */
    double left, top, right, bottom;
};

/* Where a raster at some scale sits: a logical rectangle and its size in pixels. */
struct media_text_box {
    double left, top, width, height;
    int pixel_width, pixel_height;
};

/* Text rasterized at SCALE device pixels per logical pixel, covering BOX. */
struct media_text_raster {
    struct media_pixels pixels; /* MEDIA_PIXELS_BGRA. */
    double scale;
    struct media_text_box box;
};

/*
 * A text node's layout, measured again only when its style changes. Zero it to
 * start; media_text_layout_finish frees it. Fields are read-only.
 */
struct media_text_layout {
    struct media_text_style style; /* Owned copy of the style measured. */
    struct media_text_metrics metrics;
    /* Identifies the measured style, e.g. in raster keys; 0 until measured. */
    uint64_t serial;
    /* The node prop revision it was last found current for. */
    uint64_t prop_revision;
};

/* Lay STYLE out on the owner thread and return its metrics, as a text node would show it. */
void media_text_measure(struct media *media, const struct media_text_style *style,
                        struct media_text_metrics *metrics);
/*
 * Bring LAYOUT up to date with STYLE for a node at PROP_REVISION; return whether
 * it was measured anew (a new serial). An unchanged revision and width skip the
 * comparison, so it is cheap to ask every frame while only the width animates.
 */
bool media_text_layout_update(struct media *media, struct media_text_layout *layout,
                              const struct media_text_style *style, uint64_t prop_revision);
void media_text_layout_finish(struct media_text_layout *layout);
/* The node's size: its declared width or else the logical width, and the logical height. */
void media_text_layout_size(const struct media_text_layout *layout, double *width, double *height);
/*
 * The rectangle a raster of METRICS at SCALE covers: the ink and logical union
 * with one device pixel of padding, and its pixel size, at least 1x1.
 */
struct media_text_box media_text_raster_box(const struct media_text_metrics *metrics, double scale);
/*
 * Rasterize STYLE, laid out to METRICS, in COLOR at SCALE on the owner thread.
 * Return false with RASTER cleared when the raster cannot be allocated.
 */
bool media_text_rasterize(struct media *media, const struct media_text_style *style,
                          const struct media_text_metrics *metrics, struct media_color color,
                          double scale, struct media_text_raster *raster);
/*
 * Rasterize on the worker; DONE runs from media_dispatch with the raster, which
 * the callee then owns, or with a cleared raster and an error. The job copies
 * its inputs, and its handle is valid until DONE runs or it is cancelled.
 */
struct media_job *
media_queue_text(struct media *media, const struct media_text_style *style,
                 const struct media_text_metrics *metrics, struct media_color color, double scale,
                 void (*done)(void *data, struct media_text_raster raster, const char *error),
                 void *data);

/* Images. */

enum media_image_state {
    MEDIA_IMAGE_DECODING, /* The worker is decoding it. */
    MEDIA_IMAGE_DECODED,  /* PIXELS await upload. */
    MEDIA_IMAGE_READY,    /* Uploaded; pixels released. */
    MEDIA_IMAGE_IDLE,     /* Size known, pixels released; decoded again when shown. */
    MEDIA_IMAGE_FAILED,   /* ERROR says why. */
};

/* An image file shared by every node showing its path. Fields are read-only. */
struct media_image {
    char *path;
    /* Identifies the image in signatures and texture slots. */
    uint64_t serial;
    enum media_image_state state;
    /* When a frame last presented it, or its pixels arrived (now_seconds). */
    double touched;
    /* Natural size in logical pixels, oriented; 0 until first decoded. */
    int width, height;
    /* Premultiplied RGBA, at most MEDIA_MAX_RASTER_PIXELS a side, while DECODED. */
    struct media_pixels pixels;
    char *error;
    /* Private. */
    struct media *media;
    struct media_job *job;
    int64_t stamp_seconds, stamp_nanoseconds;
    int refs;
    bool registered;
};

/*
 * Decode PATH into premultiplied RGBA at most MEDIA_MAX_RASTER_PIXELS a side,
 * vector images at four times their natural size (256 to 1024 pixels), with
 * EXIF orientation applied. Return its natural size, or false and an error the
 * caller frees. Safe on any thread.
 */
bool media_decode_image(const char *path, struct media_pixels *pixels, int *width, int *height,
                        char **error);
/*
 * A reference to the shared image for PATH, decoding it on the worker when new
 * or when the file changed since it was last acquired. A relative path fails.
 */
struct media_image *media_image_acquire(struct media *media, const char *path);
/* Drop a reference; the last one forgets the image, cancelling its decode. */
void media_image_release(struct media_image *image);
/* Whether IMAGE is still the shared one for its path; a changed file replaces it. */
bool media_image_current(const struct media_image *image);
/* Whether IMAGE's natural size is known, even while its pixels are released. */
bool media_image_loaded(const struct media_image *image);
/*
 * Whether IMAGE has pixels to draw now, its texture (HAS_TEXTURE) or decoded
 * pixels, marking it presented if so. Released pixels and texture start a
 * decode, and IMAGE_DONE says when it finished.
 */
bool media_image_show(struct media_image *image, bool has_texture);
/* Release the pixels of a DECODED image once uploaded; it becomes READY. */
void media_image_uploaded(struct media_image *image);
/* Release pixels decoded MEDIA_IMAGE_LIFETIME before NOW and never drawn since. */
void media_release_stale(struct media *media, double now);
