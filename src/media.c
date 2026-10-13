/*
 * Text layout and rasters, image decoding and the media worker.
 *
 * Every Pango context sits on its own font map and is used by one thread only:
 * the owner thread's for measuring and rasterizing at once, the worker's for
 * the jobs it runs. A job's inputs are copied when it is queued and never
 * change; its results belong to whoever holds the job, so a job cancelled or
 * left undelivered frees them.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE /* pthread_setname_np */
#endif
#include "media.h"
/* Before GLib, which redefines the same MIN and MAX. */
#include "util.h"

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <sys/eventfd.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cairo.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <pango/pangocairo.h>

enum job_kind { JOB_TEXT, JOB_IMAGE };

enum job_place { JOB_QUEUED, JOB_RUNNING, JOB_FINISHED, JOB_DELIVERING };

struct media_job {
    struct media_job *prev, *next;
    enum job_kind kind;
    enum job_place place;
    /* Set on the owner thread while the worker runs the job; read under the lock. */
    bool cancelled;

    /* Inputs. */
    struct media_text_style style; /* Owns its strings. */
    struct media_text_metrics metrics;
    struct media_color color;
    double scale;
    void (*text_done)(void *data, struct media_text_raster raster, const char *error);
    void *data;
    char *path;
    struct media_image *image; /* Owner thread only. */

    /* Results, written by the worker before it finishes the job. */
    struct media_text_raster raster;
    struct media_pixels pixels;
    int width, height;
    char *error;
};

struct job_list {
    struct media_job *head, *tail;
};

struct media {
    void (*image_done)(void *data, struct media_image *image, bool first);
    void *data;
    PangoContext *context;
    uint64_t text_serial, image_serial;
    /* struct media_image *, the current image for each path. */
    struct vec images;

    int fd;
    pthread_t thread;
    bool started;
    pthread_mutex_t lock;
    pthread_cond_t wake;
    struct job_list queue, finished;
    bool stopping;
};

static void list_push(struct job_list *list, struct media_job *job) {
    job->next = NULL;
    job->prev = list->tail;
    if (list->tail) list->tail->next = job;
    else list->head = job;
    list->tail = job;
}

static void list_unlink(struct job_list *list, struct media_job *job) {
    if (job->prev) job->prev->next = job->next;
    else list->head = job->next;
    if (job->next) job->next->prev = job->prev;
    else list->tail = job->prev;
    job->prev = job->next = NULL;
}

static struct media_job *list_pop(struct job_list *list) {
    struct media_job *job = list->head;
    if (job) list_unlink(list, job);
    return job;
}

void media_pixels_finish(struct media_pixels *pixels) {
    if (pixels->release) pixels->release(pixels->owner);
    *pixels = (struct media_pixels){0};
}

static void release_surface(void *surface) {
    cairo_surface_destroy(surface);
}

static void release_pixbuf(void *pixbuf) {
    g_object_unref(pixbuf);
}

/* Text. */

static PangoContext *text_context_new(void) {
    PangoFontMap *font_map = pango_cairo_font_map_new();
    cairo_font_options_t *options = cairo_font_options_create();
    /* Unhinted metrics keep glyph advances independent of the raster scale;
     * grayscale antialiasing survives any later transform. */
    cairo_font_options_set_hint_metrics(options, CAIRO_HINT_METRICS_OFF);
    cairo_font_options_set_hint_style(options, CAIRO_HINT_STYLE_SLIGHT);
    cairo_font_options_set_antialias(options, CAIRO_ANTIALIAS_GRAY);
    PangoContext *context = pango_font_map_create_context(font_map);
    pango_cairo_context_set_font_options(context, options);
    pango_context_set_round_glyph_positions(context, FALSE);
    cairo_font_options_destroy(options);
    g_object_unref(font_map);
    return context;
}

static PangoContext *owner_context(struct media *media) {
    if (!media->context) media->context = text_context_new();
    return media->context;
}

/* VALUE within [LOW, HIGH]; NaN becomes LOW. */
static double clamp(double value, double low, double high) {
    return value > low ? (value < high ? value : high) : low;
}

/* STYLE with its defaults filled in and its values inside Pango's integer units. */
static struct media_text_style normalized(const struct media_text_style *style) {
    struct media_text_style result = *style;
    if (!result.text) result.text = "";
    if (!result.font) result.font = "sans-serif";
    result.size = clamp(result.size, 1, 2048);
    result.weight = clamp(nearbyint(result.weight), 100, 1000);
    result.width = result.width > 0 ? clamp(result.width, 1, 100000) : 0;
    result.line_height = result.line_height > 0 ? clamp(result.line_height, 0.1, 10) : 0;
    result.max_lines = result.max_lines > 0 ? MIN(result.max_lines, 10000) : 0;
    if (result.align != MEDIA_ALIGN_CENTER && result.align != MEDIA_ALIGN_END) {
        result.align = MEDIA_ALIGN_START;
    }
    return result;
}

/* Apply Pango MARKUP to LAYOUT; return false without changes when it does not parse. */
static bool set_markup(PangoLayout *layout, const char *markup) {
    PangoAttrList *attributes = NULL;
    char *text = NULL;
    if (!pango_parse_markup(markup, -1, 0, &attributes, &text, NULL, NULL)) return false;
    pango_layout_set_text(layout, text, -1);
    pango_layout_set_attributes(layout, attributes);
    pango_attr_list_unref(attributes);
    g_free(text);
    return true;
}

/* Configure LAYOUT for STYLE, which is normalized. */
static void configure_layout(PangoLayout *layout, const struct media_text_style *style,
                             double spacing) {
    if (!(style->markup && set_markup(layout, style->text))) {
        pango_layout_set_text(layout, style->text, -1);
    }
    PangoFontDescription *description = pango_font_description_new();
    pango_font_description_set_family(description, style->font);
    pango_font_description_set_absolute_size(description, style->size * PANGO_SCALE);
    pango_font_description_set_weight(description, (PangoWeight)style->weight);
    pango_font_description_set_style(description,
                                     style->italic ? PANGO_STYLE_ITALIC : PANGO_STYLE_NORMAL);
    pango_layout_set_font_description(layout, description);
    pango_font_description_free(description);
    pango_layout_set_width(layout,
                           style->width > 0 ? (int)nearbyint(style->width * PANGO_SCALE) : -1);
    /* Word wrapping, falling back to characters for words wider than a line. */
    pango_layout_set_wrap(layout, PANGO_WRAP_WORD_CHAR);
    if (style->width > 0 && style->max_lines > 0) {
        pango_layout_set_height(layout, -style->max_lines);
        pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_END);
    }
    static const PangoAlignment alignments[] = {
        [MEDIA_ALIGN_START] = PANGO_ALIGN_LEFT,
        [MEDIA_ALIGN_CENTER] = PANGO_ALIGN_CENTER,
        [MEDIA_ALIGN_END] = PANGO_ALIGN_RIGHT,
    };
    pango_layout_set_alignment(layout, alignments[style->align]);
    /* Pango's own line-spacing factor grows with the target's scale; fixed
     * spacing in layout units does not. */
    pango_layout_set_spacing(layout, (int)nearbyint(spacing * PANGO_SCALE));
}

static void layout_metrics(PangoLayout *layout, double spacing,
                           struct media_text_metrics *metrics) {
    PangoRectangle ink, logical;
    pango_layout_get_extents(layout, &ink, &logical);
    double unit = PANGO_SCALE;
    double ink_x = ink.x / unit, ink_y = ink.y / unit;
    double ink_right = ink_x + ink.width / unit, ink_bottom = ink_y + ink.height / unit;
    double x = logical.x / unit, y = logical.y / unit;
    double width = logical.width / unit, height = logical.height / unit;
    *metrics = (struct media_text_metrics){
        .width = width,
        .height = height,
        .spacing = spacing,
        .left = MIN(ink_x, x),
        .top = MIN(ink_y, y),
        .right = MAX(ink_right, x + width),
        .bottom = MAX(ink_bottom, y + height),
    };
}

void media_text_measure(struct media *media, const struct media_text_style *style,
                        struct media_text_metrics *metrics) {
    struct media_text_style normal = normalized(style);
    PangoLayout *layout = pango_layout_new(owner_context(media));
    configure_layout(layout, &normal, 0);
    layout_metrics(layout, 0, metrics);
    if (normal.line_height > 0) {
        int lines = MAX(1, pango_layout_get_line_count(layout));
        double spacing = normal.line_height * normal.size - metrics->height / lines;
        configure_layout(layout, &normal, spacing);
        layout_metrics(layout, spacing, metrics);
    }
    g_object_unref(layout);
}

static bool same_string(const char *left, const char *right) {
    return strcmp(left ? left : "", right ? right : "") == 0;
}

static bool same_style(const struct media_text_style *left, const struct media_text_style *right) {
    return same_string(left->text, right->text) && left->markup == right->markup &&
           same_string(left->font, right->font) && left->size == right->size &&
           left->weight == right->weight && left->italic == right->italic &&
           left->align == right->align && left->width == right->width &&
           left->line_height == right->line_height && left->max_lines == right->max_lines;
}

static void copy_style(struct media_text_style *copy, const struct media_text_style *style) {
    *copy = *style;
    copy->text = style->text ? xstrdup(style->text) : NULL;
    copy->font = style->font ? xstrdup(style->font) : NULL;
}

static void free_style(struct media_text_style *style) {
    free((char *)style->text);
    free((char *)style->font);
    *style = (struct media_text_style){0};
}

bool media_text_layout_update(struct media *media, struct media_text_layout *layout,
                              const struct media_text_style *style, uint64_t prop_revision) {
    /* The width alone animates without a new prop revision. */
    if (layout->serial && layout->prop_revision == prop_revision &&
        layout->style.width == style->width) {
        return false;
    }
    bool changed = !layout->serial || !same_style(&layout->style, style);
    if (changed) {
        struct media_text_metrics metrics;
        media_text_measure(media, style, &metrics);
        free_style(&layout->style);
        copy_style(&layout->style, style);
        layout->metrics = metrics;
        layout->serial = ++media->text_serial;
    }
    layout->prop_revision = prop_revision;
    return changed;
}

void media_text_layout_finish(struct media_text_layout *layout) {
    free_style(&layout->style);
    *layout = (struct media_text_layout){0};
}

void media_text_layout_size(const struct media_text_layout *layout, double *width, double *height) {
    struct media_text_style normal = normalized(&layout->style);
    *width = normal.width > 0 ? normal.width : layout->metrics.width;
    *height = layout->metrics.height;
}

static int pixel_count(double length) {
    double pixels = ceil(length);
    /* Cairo refuses far smaller rasters; the bound keeps the conversion defined. */
    return pixels >= 1 ? (int)MIN(pixels, 1 << 20) : 1;
}

struct media_text_box media_text_raster_box(const struct media_text_metrics *metrics,
                                            double scale) {
    /* One device pixel of padding keeps antialiased edges off the texture border. */
    double pad = 1 / scale;
    struct media_text_box box = {
        .left = metrics->left - pad,
        .top = metrics->top - pad,
        .width = metrics->right - metrics->left + 2 * pad,
        .height = metrics->bottom - metrics->top + 2 * pad,
    };
    box.pixel_width = pixel_count(box.width * scale);
    box.pixel_height = pixel_count(box.height * scale);
    return box;
}

static bool render_text(PangoContext *context, const struct media_text_style *style,
                        const struct media_text_metrics *metrics, struct media_color color,
                        double scale, struct media_text_raster *raster, char **error) {
    *raster = (struct media_text_raster){0};
    char message[96];
    if (!(scale > 0) || !isfinite(scale)) {
        snprintf(message, sizeof message, "Text cannot be rasterized at scale %g.", scale);
        *error = xstrdup(message);
        return false;
    }
    struct media_text_box box = media_text_raster_box(metrics, scale);
    cairo_surface_t *surface =
        cairo_image_surface_create(CAIRO_FORMAT_ARGB32, box.pixel_width, box.pixel_height);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        snprintf(message, sizeof message, "Cairo could not allocate a %dx%d text raster.",
                 box.pixel_width, box.pixel_height);
        *error = xstrdup(message);
        return false;
    }
    cairo_t *cairo = cairo_create(surface);
    cairo_scale(cairo, scale, scale);
    cairo_translate(cairo, -box.left, -box.top);
    cairo_set_source_rgba(cairo, color.r, color.g, color.b, color.a);
    /* Pango lays out at the logical size and Cairo scales the outlines. Told the
     * scale, Pango would look the font up again for each one, which takes
     * milliseconds. */
    struct media_text_style normal = normalized(style);
    PangoLayout *layout = pango_layout_new(context);
    configure_layout(layout, &normal, metrics->spacing);
    pango_cairo_show_layout(cairo, layout);
    g_object_unref(layout);
    cairo_destroy(cairo);
    cairo_surface_flush(surface);
    *raster = (struct media_text_raster){
        .pixels =
            {
                .data = cairo_image_surface_get_data(surface),
                .width = box.pixel_width,
                .height = box.pixel_height,
                .stride = cairo_image_surface_get_stride(surface),
                .format = MEDIA_PIXELS_BGRA,
                .owner = surface,
                .release = release_surface,
            },
        .scale = scale,
        .box = box,
    };
    return true;
}

bool media_text_rasterize(struct media *media, const struct media_text_style *style,
                          const struct media_text_metrics *metrics, struct media_color color,
                          double scale, struct media_text_raster *raster) {
    char *error = NULL;
    bool done = render_text(owner_context(media), style, metrics, color, scale, raster, &error);
    free(error);
    return done;
}

/* Images. */

/* NUMERATOR / DENOMINATOR rounded half to even, so a downscaled image's sides never
 * depend on floating-point error. */
static int64_t round_ratio(int64_t numerator, int64_t denominator) {
    int64_t quotient = numerator / denominator, remainder = numerator % denominator;
    if (2 * remainder > denominator || (2 * remainder == denominator && (quotient & 1))) {
        quotient++;
    }
    return quotient;
}

static void premultiply(uint8_t *pixels, int width, int height, int stride) {
    for (int y = 0; y < height; y++) {
        uint8_t *pixel = pixels + (size_t)y * stride;
        for (int x = 0; x < width; x++, pixel += 4) {
            unsigned alpha = pixel[3];
            if (alpha == 255) continue;
            for (int channel = 0; channel < 3; channel++) {
                pixel[channel] = (uint8_t)((pixel[channel] * alpha + 127) / 255);
            }
        }
    }
}

bool media_decode_image(const char *path, struct media_pixels *pixels, int *width, int *height,
                        char **error) {
    *pixels = (struct media_pixels){0};
    *width = *height = 0;
    *error = NULL;
    int natural_width = 0, natural_height = 0;
    GdkPixbufFormat *format = gdk_pixbuf_get_file_info(path, &natural_width, &natural_height);
    if (!format) {
        *error = xstrdup("not a supported image");
        return false;
    }
    natural_width = MAX(natural_width, 0);
    natural_height = MAX(natural_height, 0);
    int64_t natural = MAX(1, MAX(natural_width, natural_height));
    /* Vector images get four times their natural size, at least 256 pixels:
     * sharp when shown larger or zoomed, small for icons. */
    int64_t limit = natural;
    if (gdk_pixbuf_format_is_scalable(format)) {
        limit = MAX(natural, MIN(1024, MAX(256, 4 * natural)));
    }
    limit = MIN(limit, MEDIA_MAX_RASTER_PIXELS);
    GError *failure = NULL;
    GdkPixbuf *decoded = gdk_pixbuf_new_from_file_at_scale(
        path, (int)MAX(1, round_ratio(limit * natural_width, natural)),
        (int)MAX(1, round_ratio(limit * natural_height, natural)), TRUE, &failure);
    if (!decoded) {
        *error = xstrdup(failure ? failure->message : "decoding failed");
        if (failure) g_error_free(failure);
        return false;
    }
    GdkPixbuf *oriented = gdk_pixbuf_apply_embedded_orientation(decoded);
    /* A quarter turn turns the natural size too. */
    bool turned = oriented && gdk_pixbuf_get_width(oriented) != gdk_pixbuf_get_width(decoded);
    g_object_unref(decoded);
    /* A private RGBA copy, so premultiplying cannot touch shared pixels. */
    GdkPixbuf *rgba = oriented ? gdk_pixbuf_add_alpha(oriented, FALSE, 0, 0, 0) : NULL;
    if (oriented) g_object_unref(oriented);
    if (!rgba) {
        *error = xstrdup("not enough memory for the decoded pixels");
        return false;
    }
    *pixels = (struct media_pixels){
        .data = gdk_pixbuf_get_pixels(rgba),
        .width = gdk_pixbuf_get_width(rgba),
        .height = gdk_pixbuf_get_height(rgba),
        .stride = gdk_pixbuf_get_rowstride(rgba),
        .format = MEDIA_PIXELS_RGBA,
        .owner = rgba,
        .release = release_pixbuf,
    };
    premultiply(pixels->data, pixels->width, pixels->height, pixels->stride);
    *width = turned ? natural_height : natural_width;
    *height = turned ? natural_width : natural_height;
    return true;
}

/* The worker. */

static void free_job(struct media_job *job) {
    free_style(&job->style);
    free(job->path);
    free(job->error);
    media_pixels_finish(&job->raster.pixels);
    media_pixels_finish(&job->pixels);
    free(job);
}

static void run_job(struct media_job *job, PangoContext **context) {
    if (job->kind == JOB_TEXT) {
        if (!*context) *context = text_context_new();
        render_text(*context, &job->style, &job->metrics, job->color, job->scale, &job->raster,
                    &job->error);
    } else {
        media_decode_image(job->path, &job->pixels, &job->width, &job->height, &job->error);
    }
}

static void *worker_main(void *argument) {
    struct media *media = argument;
    /* The worker's own context, on its own font map: Pango objects are not
     * shared across threads. */
    PangoContext *context = NULL;
    pthread_mutex_lock(&media->lock);
    for (;;) {
        while (!media->stopping && !media->queue.head) {
            pthread_cond_wait(&media->wake, &media->lock);
        }
        if (media->stopping) break;
        struct media_job *job = list_pop(&media->queue);
        job->place = JOB_RUNNING;
        pthread_mutex_unlock(&media->lock);
        run_job(job, &context);
        pthread_mutex_lock(&media->lock);
        if (job->cancelled || media->stopping) {
            /* Unlocked: releasing a large image takes a while. */
            pthread_mutex_unlock(&media->lock);
            free_job(job);
            pthread_mutex_lock(&media->lock);
            continue;
        }
        job->place = JOB_FINISHED;
        /* One wakeup per batch: the owner drains the whole list once woken. */
        bool wake = !media->finished.head;
        list_push(&media->finished, job);
        if (wake) {
            uint64_t one = 1;
            ssize_t written = write(media->fd, &one, sizeof one);
            (void)written;
        }
    }
    pthread_mutex_unlock(&media->lock);
    if (context) g_object_unref(context);
    return NULL;
}

static void start_worker(struct media *media) {
    /* Signals stay with the threads that handle them. */
    sigset_t all, previous;
    sigfillset(&all);
    pthread_sigmask(SIG_SETMASK, &all, &previous);
    int error = pthread_create(&media->thread, NULL, worker_main, media);
    pthread_sigmask(SIG_SETMASK, &previous, NULL);
    if (error) {
        fprintf(stderr, "proscenium: cannot start the media worker: %s\n", strerror(error));
        abort();
    }
    pthread_setname_np(media->thread, "media");
    media->started = true;
}

static void queue_job(struct media *media, struct media_job *job) {
    if (!media->started) start_worker(media);
    pthread_mutex_lock(&media->lock);
    job->place = JOB_QUEUED;
    list_push(&media->queue, job);
    pthread_cond_signal(&media->wake);
    pthread_mutex_unlock(&media->lock);
}

void media_job_cancel(struct media *media, struct media_job *job) {
    pthread_mutex_lock(&media->lock);
    switch (job->place) {
    case JOB_QUEUED: list_unlink(&media->queue, job); break;
    case JOB_FINISHED: list_unlink(&media->finished, job); break;
    case JOB_RUNNING:
        job->cancelled = true;
        job = NULL;
        break;
    case JOB_DELIVERING: job = NULL; break;
    }
    pthread_mutex_unlock(&media->lock);
    if (job) free_job(job);
}

struct media_job *
media_queue_text(struct media *media, const struct media_text_style *style,
                 const struct media_text_metrics *metrics, struct media_color color, double scale,
                 void (*done)(void *data, struct media_text_raster raster, const char *error),
                 void *data) {
    struct media_job *job = xcalloc(1, sizeof *job);
    job->kind = JOB_TEXT;
    copy_style(&job->style, style);
    job->metrics = *metrics;
    job->color = color;
    job->scale = scale;
    job->text_done = done;
    job->data = data;
    queue_job(media, job);
    return job;
}

static void queue_decode(struct media *media, struct media_image *image) {
    struct media_job *job = xcalloc(1, sizeof *job);
    job->kind = JOB_IMAGE;
    job->path = xstrdup(image->path);
    job->image = image;
    image->state = MEDIA_IMAGE_DECODING;
    image->job = job;
    queue_job(media, job);
}

static void finish_image(struct media *media, struct media_job *job) {
    struct media_image *image = job->image;
    image->job = NULL;
    bool first = image->width == 0;
    bool decoded = job->pixels.data != NULL;
    media_pixels_finish(&image->pixels);
    image->pixels = job->pixels;
    job->pixels = (struct media_pixels){0};
    free(image->error);
    image->error = job->error;
    job->error = NULL;
    image->state = decoded ? MEDIA_IMAGE_DECODED : MEDIA_IMAGE_FAILED;
    image->touched = now_seconds();
    if (decoded) {
        image->width = job->width;
        image->height = job->height;
    }
    if (media->image_done) media->image_done(media->data, image, first && decoded);
}

void media_dispatch(struct media *media) {
    /* Reset the eventfd first: a job finishing during the drain wakes the loop again. */
    uint64_t count;
    while (read(media->fd, &count, sizeof count) < 0 && errno == EINTR) continue;
    for (;;) {
        pthread_mutex_lock(&media->lock);
        /* One at a time, so a callback may cancel jobs still waiting here. */
        struct media_job *job = list_pop(&media->finished);
        if (job) job->place = JOB_DELIVERING;
        pthread_mutex_unlock(&media->lock);
        if (!job) return;
        if (job->kind == JOB_TEXT) {
            struct media_text_raster raster = job->raster;
            job->raster = (struct media_text_raster){0};
            job->text_done(job->data, raster, raster.pixels.data ? NULL : job->error);
        } else {
            finish_image(media, job);
        }
        free_job(job);
    }
}

/* Shared images. */

static void file_stamp(const char *path, int64_t *seconds, int64_t *nanoseconds) {
    struct stat info;
    if (stat(path, &info) == 0) {
        *seconds = info.st_mtim.tv_sec;
        *nanoseconds = info.st_mtim.tv_nsec;
    } else {
        *seconds = INT64_MIN;
        *nanoseconds = 0;
    }
}

/* Release IMAGE's pixels; a DECODED or READY image becomes IDLE. */
static void drop_pixels(struct media_image *image) {
    media_pixels_finish(&image->pixels);
    if (image->state == MEDIA_IMAGE_DECODED || image->state == MEDIA_IMAGE_READY) {
        image->state = MEDIA_IMAGE_IDLE;
    }
}

static void unregister_image(struct media_image *image) {
    struct media *media = image->media;
    for (size_t i = 0; i < media->images.length; i++) {
        if (*(struct media_image **)vec_at(&media->images, i) == image) {
            vec_remove(&media->images, i);
            break;
        }
    }
    image->registered = false;
    if (image->job) media_job_cancel(media, image->job);
    image->job = NULL;
    drop_pixels(image);
}

struct media_image *media_image_acquire(struct media *media, const char *path) {
    int64_t seconds, nanoseconds;
    file_stamp(path, &seconds, &nanoseconds);
    VEC_FOR(&media->images, struct media_image *, slot) {
        struct media_image *existing = *slot;
        if (strcmp(existing->path, path) != 0) continue;
        if (existing->stamp_seconds == seconds && existing->stamp_nanoseconds == nanoseconds) {
            existing->refs++;
            return existing;
        }
        /* Nodes still holding the old image resolve the new one when next asked. */
        unregister_image(existing);
        break;
    }
    struct media_image *image = xcalloc(1, sizeof *image);
    image->path = xstrdup(path);
    image->serial = ++media->image_serial;
    image->media = media;
    image->stamp_seconds = seconds;
    image->stamp_nanoseconds = nanoseconds;
    image->refs = 1;
    image->registered = true;
    *(struct media_image **)vec_push(&media->images) = image;
    if (path[0] == '/') {
        queue_decode(media, image);
    } else {
        image->state = MEDIA_IMAGE_FAILED;
        image->error = xstrdup("src must be an absolute path");
    }
    return image;
}

void media_image_release(struct media_image *image) {
    if (--image->refs > 0) return;
    if (image->registered) unregister_image(image);
    media_pixels_finish(&image->pixels);
    free(image->path);
    free(image->error);
    free(image);
}

bool media_image_current(const struct media_image *image) {
    return image->registered;
}

bool media_image_loaded(const struct media_image *image) {
    return image->width > 0;
}

bool media_image_show(struct media_image *image, bool has_texture) {
    if (image->state == MEDIA_IMAGE_READY && !has_texture) image->state = MEDIA_IMAGE_IDLE;
    if (image->state == MEDIA_IMAGE_IDLE && image->registered) queue_decode(image->media, image);
    bool shown = image->state == MEDIA_IMAGE_DECODED || image->state == MEDIA_IMAGE_READY;
    if (shown) image->touched = now_seconds();
    return shown;
}

void media_image_uploaded(struct media_image *image) {
    if (image->state != MEDIA_IMAGE_DECODED) return;
    media_pixels_finish(&image->pixels);
    image->state = MEDIA_IMAGE_READY;
}

void media_release_stale(struct media *media, double now) {
    VEC_FOR(&media->images, struct media_image *, slot) {
        struct media_image *image = *slot;
        if (image->state == MEDIA_IMAGE_DECODED && now > image->touched + MEDIA_IMAGE_LIFETIME)
            drop_pixels(image);
    }
}

/* Lifetime. */

struct media *media_create(void (*image_done)(void *data, struct media_image *image, bool first),
                           void *data) {
    int fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (fd < 0) return NULL;
    struct media *media = xcalloc(1, sizeof *media);
    media->image_done = image_done;
    media->data = data;
    media->fd = fd;
    vec_init(&media->images, sizeof(struct media_image *));
    pthread_mutex_init(&media->lock, NULL);
    pthread_cond_init(&media->wake, NULL);
    return media;
}

void media_destroy(struct media *media) {
    if (media->started) {
        pthread_mutex_lock(&media->lock);
        media->stopping = true;
        pthread_cond_broadcast(&media->wake);
        pthread_mutex_unlock(&media->lock);
        pthread_join(media->thread, NULL);
    }
    struct media_job *job;
    while ((job = list_pop(&media->queue))) free_job(job);
    while ((job = list_pop(&media->finished))) free_job(job);
    VEC_FOR(&media->images, struct media_image *, slot) {
        struct media_image *image = *slot;
        image->registered = false;
        image->job = NULL;
        image->media = NULL;
        drop_pixels(image);
    }
    vec_finish(&media->images);
    if (media->context) g_object_unref(media->context);
    close(media->fd);
    pthread_mutex_destroy(&media->lock);
    pthread_cond_destroy(&media->wake);
    free(media);
}

int media_get_fd(struct media *media) {
    return media->fd;
}
