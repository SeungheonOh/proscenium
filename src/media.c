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

/*
 * Text the owner thread laid out, by the normalized style it lays out. Its lines are
 * laid out without spacing, and drawn SPACING (Pango units) further apart each, so a
 * line height never needs a second layout. Held by the text layouts showing it; the
 * rest go a while after their last use.
 */
struct media_laid_out {
    struct media *media;
    uint64_t hash;
    struct media_text_style style; /* Owned, normalized. */
    PangoLayout *layout;
    int spacing;
    struct media_text_metrics metrics;
    double used;
    int refs;
    /* Out of the table (media gone, or replaced by a colliding style): freed at its last release.
     */
    bool detached;
    /* Its glyphs (struct media_glyph), or NULL when Pango must draw it; found in glyph
     * generation GLYPHS_GENERATION, 0 for not yet. */
    struct vec *glyphs;
    uint64_t glyphs_generation;
    /* The style less its width, hashed: texts that differ only in width. */
    uint64_t family;
    /*
     * Any width from FIT, its widest line, up to LAID_WIDTH, the width LAYOUT was laid out
     * at, breaks its lines alike, for a REWRAPPABLE text: plain, left-aligned, left to
     * right, not ellipsized, without soft hyphens or tabs. Pango breaks such text
     * greedily, so a line that fit stays fitting and the text that did not join it still
     * does not; with the lines starting at 0, nothing moves.
     */
    bool rewrappable;
    double fit, laid_width;
};

/* A font glyphs were drawn from, held so its number keeps naming it. */
struct glyph_font {
    PangoFont *font;
    cairo_scaled_font_t *scaled;
};

/* Seconds laid-out text no layout holds is kept after its last use. */
#define LAID_OUT_LIFETIME 0.5
/* Laid-out text no layout holds kept at most; past it, the least recently used goes. */
#define LAID_OUT_SPARE 1024
/* Fonts glyphs are drawn from held at most; past it, glyphs start over. */
#define GLYPH_FONTS_MAX 256

struct media {
    void (*image_done)(void *data, struct media_image *image, bool first);
    void *data;
    PangoContext *context;
    uint64_t text_serial, image_serial;
    /* struct media_laid_out *, by hash; and how many no layout holds. */
    struct idmap laid_out;
    size_t laid_out_spare;
    /* The newest struct media_laid_out * of each family. */
    struct idmap families;
    /* struct glyph_font, numbered from 1; their numbers by PangoFont pointer. Numbers name
     * fonts within one glyph generation. */
    struct vec glyph_fonts;
    struct idmap glyph_font_numbers;
    uint64_t glyph_generation;
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

/*
 * METRICS of LAYOUT, laid out without spacing, with SPACING Pango units between its
 * lines: what Pango gives the layout given that spacing, as line breaks do not depend
 * on it. The logical box grows by the spacing between lines; each line's ink moves
 * down by the spacing above it.
 */
static void spaced_metrics(PangoLayout *layout, int spacing, double spacing_pixels,
                           struct media_text_metrics *metrics) {
    PangoRectangle ink = {0}, logical;
    pango_layout_get_extents(layout, NULL, &logical);
    int lines = pango_layout_get_line_count(layout);
    logical.height += MAX(0, lines - 1) * spacing;
    PangoLayoutIter *iter = pango_layout_get_iter(layout);
    int index = 0;
    do {
        /* As Pango unites them: every line's ink box, empty ones too. */
        PangoRectangle line;
        pango_layout_iter_get_line_extents(iter, &line, NULL);
        line.y += index * spacing;
        if (!index++) {
            ink = line;
        } else {
            int left = MIN(ink.x, line.x), top = MIN(ink.y, line.y);
            ink.width = MAX(ink.x + ink.width, line.x + line.width) - left;
            ink.height = MAX(ink.y + ink.height, line.y + line.height) - top;
            ink.x = left;
            ink.y = top;
        }
    } while (pango_layout_iter_next_line(iter));
    pango_layout_iter_free(iter);
    double unit = PANGO_SCALE;
    double ink_x = ink.x / unit, ink_y = ink.y / unit;
    double ink_right = ink_x + ink.width / unit, ink_bottom = ink_y + ink.height / unit;
    double x = logical.x / unit, y = logical.y / unit;
    double width = logical.width / unit, height = logical.height / unit;
    *metrics = (struct media_text_metrics){
        .width = width,
        .height = height,
        .spacing = spacing_pixels,
        .left = MIN(ink_x, x),
        .top = MIN(ink_y, y),
        .right = MAX(ink_right, x + width),
        .bottom = MAX(ink_bottom, y + height),
    };
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

/* A hash of STYLE, which is normalized. */
static uint64_t style_hash(const struct media_text_style *style) {
    uint64_t hash = hash_bytes(HASH_SEED, style->text, strlen(style->text) + 1);
    hash = hash_bytes(hash, style->font, strlen(style->font) + 1);
    double numbers[5] = {style->size, style->weight, style->width, style->line_height,
                         style->max_lines};
    hash = hash_bytes(hash, numbers, sizeof numbers);
    int flags[3] = {style->markup, style->italic, (int)style->align};
    return hash_bytes(hash, flags, sizeof flags);
}

static void free_laid_out(struct media_laid_out *laid) {
    if (laid->glyphs) {
        vec_finish(laid->glyphs);
        free(laid->glyphs);
    }
    g_object_unref(laid->layout);
    free_style(&laid->style);
    free(laid);
}

/* Take LAID out of the table; it goes now unless a layout holds it. */
static void detach_laid_out(struct media *media, struct media_laid_out *laid) {
    idmap_remove(&media->laid_out, (int64_t)laid->hash);
    if (idmap_get(&media->families, (int64_t)laid->family) == laid)
        idmap_remove(&media->families, (int64_t)laid->family);
    laid->detached = true;
    if (laid->refs) return;
    media->laid_out_spare--;
    free_laid_out(laid);
}

static int compare_used(const void *a, const void *b) {
    double x = (*(struct media_laid_out *const *)a)->used,
           y = (*(struct media_laid_out *const *)b)->used;
    return (x > y) - (x < y);
}

/* Past LAID_OUT_SPARE laid-out texts no layout holds, drop the least recently used half. */
static void trim_laid_out(struct media *media) {
    if (media->laid_out_spare <= LAID_OUT_SPARE) return;
    struct vec spare;
    vec_init(&spare, sizeof(struct media_laid_out *));
    size_t index = 0;
    int64_t key;
    void *value;
    while (idmap_next(&media->laid_out, &index, &key, &value)) {
        struct media_laid_out *laid = value;
        if (!laid->refs) *(struct media_laid_out **)vec_push(&spare) = laid;
    }
    qsort(spare.data, spare.length, sizeof(struct media_laid_out *), compare_used);
    for (size_t i = 0; i + LAID_OUT_SPARE / 2 < spare.length; i++)
        detach_laid_out(media, *(struct media_laid_out **)vec_at(&spare, i));
    vec_finish(&spare);
}

/* A hash of STYLE, which is normalized, less its width. */
static uint64_t family_hash(const struct media_text_style *style) {
    struct media_text_style widthless = *style;
    widthless.width = 0;
    return style_hash(&widthless);
}

/* Whether LAYOUT, laid out for STYLE, breaks alike at any width from its widest line up. */
static bool rewrappable(PangoLayout *layout, const struct media_text_style *style) {
    if (!(style->width > 0) || style->align != MEDIA_ALIGN_START || style->markup ||
        pango_layout_is_ellipsized(layout))
        return false;
    /* Soft hyphens (U+00AD, and U+1806 for Mongolian) show only where a line breaks at
     * them; a tab's width is settled after the line breaks, and can make it wider. */
    const char *text = pango_layout_get_text(layout);
    if (strchr(text, '\t') || strstr(text, "\u00AD") || strstr(text, "\u1806")) return false;
    for (GSList *line = pango_layout_get_lines_readonly(layout); line; line = line->next) {
        if (((PangoLayoutLine *)line->data)->resolved_dir != PANGO_DIRECTION_LTR) return false;
    }
    return true;
}

/* STYLE laid out on the owner thread: the one at hand, or a new one. */
static struct media_laid_out *lay_out(struct media *media, const struct media_text_style *style) {
    struct media_text_style normal = normalized(style);
    uint64_t hash = style_hash(&normal);
    struct media_laid_out *laid = idmap_get(&media->laid_out, (int64_t)hash);
    double now = now_seconds();
    if (laid && same_style(&laid->style, &normal)) {
        laid->used = now;
        return laid;
    }
    if (laid) detach_laid_out(media, laid);
    laid = xcalloc(1, sizeof *laid);
    laid->media = media;
    laid->hash = hash;
    laid->family = family_hash(&normal);
    laid->used = now;
    copy_style(&laid->style, &normal);
    struct media_laid_out *sibling = idmap_get(&media->families, (int64_t)laid->family);
    if (sibling && sibling->rewrappable && normal.width > 0 && normal.width >= sibling->fit &&
        normal.width <= sibling->laid_width) {
        /* Laid out alike at this width: share it. A colliding family fails the style check. */
        struct media_text_style widthless = sibling->style;
        widthless.width = normal.width;
        if (!same_style(&widthless, &normal)) sibling = NULL;
    } else {
        sibling = NULL;
    }
    if (sibling) {
        laid->layout = g_object_ref(sibling->layout);
        laid->spacing = sibling->spacing;
        laid->metrics = sibling->metrics;
        laid->rewrappable = true;
        laid->fit = sibling->fit;
        laid->laid_width = sibling->laid_width;
    } else {
        laid->layout = pango_layout_new(owner_context(media));
        configure_layout(laid->layout, &normal, 0);
        spaced_metrics(laid->layout, 0, 0, &laid->metrics);
        laid->rewrappable = rewrappable(laid->layout, &normal);
        laid->fit = laid->metrics.width;
        laid->laid_width = normal.width;
        if (normal.line_height > 0) {
            int lines = MAX(1, pango_layout_get_line_count(laid->layout));
            double spacing = normal.line_height * normal.size - laid->metrics.height / lines;
            /* As configure_layout sets it. */
            laid->spacing = (int)nearbyint(spacing * PANGO_SCALE);
            spaced_metrics(laid->layout, laid->spacing, spacing, &laid->metrics);
        }
    }
    /* Trimmed before it joins, the new text is never the one dropped. */
    trim_laid_out(media);
    idmap_put(&media->families, (int64_t)laid->family, laid);
    idmap_put(&media->laid_out, (int64_t)hash, laid);
    media->laid_out_spare++;
    return laid;
}

static void hold_laid_out(struct media_laid_out *laid) {
    if (!laid->refs++) laid->media->laid_out_spare--;
}

static void release_laid_out(struct media_laid_out *laid) {
    if (--laid->refs) return;
    if (laid->detached) {
        free_laid_out(laid);
        return;
    }
    struct media *media = laid->media;
    laid->used = now_seconds();
    media->laid_out_spare++;
    trim_laid_out(media);
}

void media_text_measure(struct media *media, const struct media_text_style *style,
                        struct media_text_metrics *metrics) {
    *metrics = lay_out(media, style)->metrics;
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
        struct media_laid_out *laid = lay_out(media, style);
        hold_laid_out(laid);
        if (layout->laid_out) release_laid_out(layout->laid_out);
        layout->laid_out = laid;
        free_style(&layout->style);
        copy_style(&layout->style, style);
        layout->metrics = laid->metrics;
        layout->serial = ++media->text_serial;
    }
    layout->prop_revision = prop_revision;
    return changed;
}

void media_text_layout_finish(struct media_text_layout *layout) {
    if (layout->laid_out) release_laid_out(layout->laid_out);
    free_style(&layout->style);
    *layout = (struct media_text_layout){0};
}

void media_text_layout_size(const struct media_text_layout *layout, double *width, double *height) {
    struct media_text_style normal = normalized(&layout->style);
    *width = normal.width > 0 ? normal.width : layout->metrics.width;
    *height = layout->metrics.height;
}

static int pixel_count(double pixels) {
    /* Cairo refuses far smaller rasters; the bound keeps the conversion defined. */
    return pixels >= 1 ? (int)MIN(pixels, 1 << 20) : 1;
}

struct media_text_box media_text_raster_box(const struct media_text_metrics *metrics,
                                            double scale) {
    /* Whole device pixels from the layout's origin, so a raster drawn at its scale with
     * the origin on a pixel corner puts each texel on one pixel. At least one pixel of
     * padding keeps antialiased edges off the texture border. */
    double left = floor(metrics->left * scale) - 1, top = floor(metrics->top * scale) - 1;
    double right = ceil(metrics->right * scale) + 1, bottom = ceil(metrics->bottom * scale) + 1;
    return (struct media_text_box){
        .left = left / scale,
        .top = top / scale,
        .width = (right - left) / scale,
        .height = (bottom - top) / scale,
        .pixel_width = pixel_count(right - left),
        .pixel_height = pixel_count(bottom - top),
    };
}

/* Draw LAYOUT's lines from the user-space origin, SPACING Pango units further apart each,
 * as pango_cairo_show_layout draws a layout given that spacing. */
static void show_spaced(cairo_t *cairo, PangoLayout *layout, int spacing) {
    PangoLayoutIter *iter = pango_layout_get_iter(layout);
    int index = 0;
    do {
        PangoRectangle logical;
        pango_layout_iter_get_line_extents(iter, NULL, &logical);
        int baseline = pango_layout_iter_get_baseline(iter) + index++ * spacing;
        /* Moved by translating: a current point would round the line's origin to cairo's
         * fixed point, which can move its glyphs a quarter pixel. */
        cairo_save(cairo);
        cairo_translate(cairo, logical.x / (double)PANGO_SCALE, baseline / (double)PANGO_SCALE);
        pango_cairo_show_layout_line(cairo, pango_layout_iter_get_line_readonly(iter));
        cairo_restore(cairo);
    } while (pango_layout_iter_next_line(iter));
    pango_layout_iter_free(iter);
}

/* Rasterize STYLE in CONTEXT, or LAID, the owner thread's layout of it, when given. */
static bool render_text(PangoContext *context, const struct media_laid_out *laid,
                        const struct media_text_style *style,
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
    /* The box's corner lies whole pixels from the origin; taken in pixels, it stays exact. */
    cairo_translate(cairo, -rint(box.left * scale), -rint(box.top * scale));
    cairo_scale(cairo, scale, scale);
    cairo_set_source_rgba(cairo, color.r, color.g, color.b, color.a);
    /* Pango lays out at the logical size and Cairo scales the outlines. Told the
     * scale, Pango would look the font up again for each one, which takes
     * milliseconds. */
    if (laid) {
        show_spaced(cairo, laid->layout, laid->spacing);
    } else {
        struct media_text_style normal = normalized(style);
        PangoLayout *layout = pango_layout_new(context);
        configure_layout(layout, &normal, metrics->spacing);
        pango_cairo_show_layout(cairo, layout);
        g_object_unref(layout);
    }
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
    bool done = render_text(owner_context(media), lay_out(media, style), style, metrics, color,
                            scale, raster, &error);
    free(error);
    return done;
}

/* Glyphs. */

/* MEDIA's number for FONT, held from now on. */
static uint32_t glyph_font_number(struct media *media, PangoFont *font) {
    uint32_t number =
        (uint32_t)(uintptr_t)idmap_get(&media->glyph_font_numbers, (int64_t)(uintptr_t)font);
    if (number) return number;
    struct glyph_font *entry = vec_push(&media->glyph_fonts);
    entry->font = g_object_ref(font);
    entry->scaled = pango_cairo_font_get_scaled_font(PANGO_CAIRO_FONT(font));
    number = (uint32_t)media->glyph_fonts.length;
    idmap_put(&media->glyph_font_numbers, (int64_t)(uintptr_t)font, (void *)(uintptr_t)number);
    return number;
}

/* LAID's glyphs, in the order Pango's renderer draws them; false when only Pango can. */
static bool find_glyphs(struct media *media, struct media_laid_out *laid, struct vec *out) {
    if (laid->style.markup) return false;
    PangoLayoutIter *iter = pango_layout_get_iter(laid->layout);
    PangoLayoutLine *line = NULL;
    int line_index = -1;
    bool ok = true;
    do {
        /* Lines count before runs: an empty line has none, but its spacing. */
        PangoLayoutLine *current = pango_layout_iter_get_line_readonly(iter);
        if (current != line) {
            line = current;
            line_index++;
        }
        PangoLayoutRun *run = pango_layout_iter_get_run_readonly(iter);
        if (!run) continue;
        PangoRectangle logical;
        pango_layout_iter_get_run_extents(iter, NULL, &logical);
        /* Lines lie SPACING further apart each, as show_spaced draws them. */
        int baseline = pango_layout_iter_get_baseline(iter) + line_index * laid->spacing;
        if (run->y_offset || run->start_x_offset || run->end_x_offset ||
            !run->item->analysis.font) {
            ok = false;
            break;
        }
        uint32_t font = glyph_font_number(media, run->item->analysis.font);
        int x = logical.x;
        for (int i = 0; i < run->glyphs->num_glyphs; i++) {
            const PangoGlyphInfo *info = &run->glyphs->glyphs[i];
            if (info->glyph & PANGO_GLYPH_UNKNOWN_FLAG) {
                ok = false;
                break;
            }
            if (info->glyph != PANGO_GLYPH_EMPTY) {
                struct media_glyph *glyph = vec_push(out);
                *glyph = (struct media_glyph){
                    .font = font,
                    .glyph = info->glyph,
                    .x = (x + info->geometry.x_offset) / (double)PANGO_SCALE,
                    .y = (baseline + info->geometry.y_offset) / (double)PANGO_SCALE,
                };
            }
            x += info->geometry.width;
        }
    } while (ok && pango_layout_iter_next_run(iter));
    pango_layout_iter_free(iter);
    return ok;
}

const struct media_glyph *media_text_glyphs(struct media *media,
                                            const struct media_text_layout *layout, size_t *count) {
    struct media_laid_out *laid = layout->laid_out;
    *count = 0;
    if (!laid) return NULL;
    if (laid->glyphs_generation != media->glyph_generation) {
        /* Found in an earlier generation, they name its fonts: find them again. */
        laid->glyphs_generation = media->glyph_generation;
        if (!laid->glyphs) {
            laid->glyphs = xcalloc(1, sizeof *laid->glyphs);
            vec_init(laid->glyphs, sizeof(struct media_glyph));
        }
        vec_clear(laid->glyphs);
        if (!find_glyphs(media, laid, laid->glyphs)) {
            vec_finish(laid->glyphs);
            free(laid->glyphs);
            laid->glyphs = NULL;
        }
    }
    if (!laid->glyphs) return NULL;
    /* Text without glyphs is not NULL: there is nothing for Pango to draw either. */
    static const struct media_glyph none;
    *count = laid->glyphs->length;
    return *count ? laid->glyphs->data : &none;
}

/* FONT at SCALE device pixels per logical pixel: its face and options through a CTM of
 * SCALE. Cairo keeps the scaled fonts last let go, so making one again finds it. */
static cairo_scaled_font_t *device_font(struct media *media, uint32_t font, double scale) {
    cairo_scaled_font_t *base =
        ((struct glyph_font *)vec_at(&media->glyph_fonts, font - 1))->scaled;
    cairo_matrix_t font_matrix, ctm;
    cairo_scaled_font_get_font_matrix(base, &font_matrix);
    cairo_matrix_init_scale(&ctm, scale, scale);
    cairo_font_options_t *options = cairo_font_options_create();
    cairo_scaled_font_get_font_options(base, options);
    cairo_scaled_font_t *scaled = cairo_scaled_font_create(cairo_scaled_font_get_font_face(base),
                                                           &font_matrix, &ctm, options);
    cairo_font_options_destroy(options);
    return scaled;
}

bool media_glyphs_start_over(struct media *media) {
    if (media->glyph_fonts.length <= GLYPH_FONTS_MAX) return false;
    VEC_FOR(&media->glyph_fonts, struct glyph_font, entry) g_object_unref(entry->font);
    vec_clear(&media->glyph_fonts);
    idmap_clear(&media->glyph_font_numbers);
    media->glyph_generation++;
    return true;
}

bool media_glyph_rasterize(struct media *media, uint32_t font, uint32_t glyph, double scale,
                           int phase_x, int phase_y, struct media_glyph_mask *mask) {
    *mask = (struct media_glyph_mask){0};
    if (!font || font > media->glyph_fonts.length || !(scale > 0) || !isfinite(scale) ||
        phase_x < 0 || phase_x > 3 || phase_y < 0 || phase_y > 3)
        return false;
    cairo_scaled_font_t *scaled = device_font(media, font, scale);
    /* A font in error gives zero extents. */
    cairo_text_extents_t extents;
    cairo_glyph_t at_origin = {glyph, 0, 0};
    cairo_scaled_font_glyph_extents(scaled, &at_origin, 1, &extents);
    bool usable = cairo_scaled_font_status(scaled) == CAIRO_STATUS_SUCCESS;
    bool inked = usable && extents.width > 0 && extents.height > 0;
    /* Room for the ink at any phase, and a margin for antialiasing and hinting: checked
     * before it becomes a surface's size. */
    double left_room = ceil(fmax(0, -extents.x_bearing) * scale) + 4;
    double top_room = ceil(fmax(0, -extents.y_bearing) * scale) + 4;
    double full_width = left_room + ceil(fmax(0, extents.x_bearing + extents.width) * scale) + 5;
    double full_height = top_room + ceil(fmax(0, extents.y_bearing + extents.height) * scale) + 5;
    if (!inked || !(full_width <= 4096 && full_height <= 4096)) {
        cairo_scaled_font_destroy(scaled);
        /* A glyph without ink comes out 0x0. */
        return usable && !inked;
    }
    int origin_x = (int)left_room, origin_y = (int)top_room;
    int width = (int)full_width, height = (int)full_height;
    cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        cairo_scaled_font_destroy(scaled);
        return false;
    }
    cairo_t *cairo = cairo_create(surface);
    /* Through the same CTM as the text's raster. */
    cairo_scale(cairo, scale, scale);
    cairo_set_scaled_font(cairo, scaled);
    cairo_scaled_font_destroy(scaled);
    cairo_set_source_rgba(cairo, 1, 1, 1, 1);
    cairo_glyph_t placed = {glyph, (origin_x + phase_x / 4.0) / scale,
                            (origin_y + phase_y / 4.0) / scale};
    cairo_show_glyphs(cairo, &placed, 1);
    cairo_destroy(cairo);
    cairo_surface_flush(surface);
    const uint8_t *data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    /* The ink's bounds. */
    int left = width, top = height, right = -1, bottom = -1;
    for (int y = 0; y < height; y++) {
        const uint32_t *row = (const uint32_t *)(data + (size_t)y * stride);
        for (int x = 0; x < width; x++) {
            if (!row[x]) continue;
            left = MIN(left, x);
            right = MAX(right, x);
            top = MIN(top, y);
            bottom = MAX(bottom, y);
        }
    }
    if (right < 0) {
        cairo_surface_destroy(surface);
        return true;
    }
    int ink_width = right - left + 1, ink_height = bottom - top + 1;
    uint8_t *pixels = malloc((size_t)ink_width * ink_height * 4);
    if (!pixels) {
        cairo_surface_destroy(surface);
        return false;
    }
    bool colored = false;
    for (int y = 0; y < ink_height; y++) {
        const uint8_t *row = data + (size_t)(top + y) * stride + (size_t)left * 4;
        uint8_t *out = pixels + (size_t)y * ink_width * 4;
        for (int x = 0; x < ink_width; x++, row += 4, out += 4) {
            /* Cairo's ARGB32 is B, G, R, A in memory; white ink has every channel at alpha. */
            out[0] = row[2];
            out[1] = row[1];
            out[2] = row[0];
            out[3] = row[3];
            colored = colored || row[0] != row[3] || row[1] != row[3] || row[2] != row[3];
        }
    }
    cairo_surface_destroy(surface);
    *mask = (struct media_glyph_mask){
        .pixels = pixels,
        .width = ink_width,
        .height = ink_height,
        .left = left - origin_x,
        .top = top - origin_y,
        .colored = colored,
    };
    return true;
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
        render_text(*context, NULL, &job->style, &job->metrics, job->color, job->scale,
                    &job->raster, &job->error);
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
    size_t index = 0;
    int64_t key;
    void *value;
    while (idmap_next(&media->laid_out, &index, &key, &value)) {
        struct media_laid_out *laid = value;
        /* Removing keeps the walk valid: the map is walked by slot. */
        if (!laid->refs && now > laid->used + LAID_OUT_LIFETIME) detach_laid_out(media, laid);
    }
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
    idmap_init(&media->laid_out);
    idmap_init(&media->families);
    vec_init(&media->glyph_fonts, sizeof(struct glyph_font));
    idmap_init(&media->glyph_font_numbers);
    /* Laid-out text starts at generation 0: none has its glyphs found yet. */
    media->glyph_generation = 1;
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
    /* Laid-out text a layout still holds goes at its last release. */
    size_t index = 0;
    int64_t key;
    void *value;
    while (idmap_next(&media->laid_out, &index, &key, &value)) {
        struct media_laid_out *laid = value;
        laid->detached = true;
        if (!laid->refs) free_laid_out(laid);
    }
    idmap_finish(&media->laid_out);
    idmap_finish(&media->families);
    VEC_FOR(&media->glyph_fonts, struct glyph_font, entry) g_object_unref(entry->font);
    vec_finish(&media->glyph_fonts);
    idmap_finish(&media->glyph_font_numbers);
    if (media->context) g_object_unref(media->context);
    close(media->fd);
    pthread_mutex_destroy(&media->lock);
    pthread_cond_destroy(&media->wake);
    free(media);
}

int media_get_fd(struct media *media) {
    return media->fd;
}
