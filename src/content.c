/*
 * Text and image nodes.
 *
 * A text node measures again only when a layout property changes, and keeps one
 * raster per output, made again when its text, color or raster scale changes.
 * While its on-screen scale changes from frame to frame the raster scale snaps
 * to half-octave steps; the first still frame renders it exactly. Text only
 * rescaled is rasterized on the media worker while the raster at hand is drawn
 * scaled; new text is rasterized at once while the frame has spare time, unless
 * it is large enough to take a frame's worth of it, which the worker does. Images
 * are shared by path, decode on the worker, and release their textures a while
 * after they were last on screen.
 *
 * The main thread decides what each texture holds (the raster mirror) and hands the
 * pixels to the frame as uploads, which the renderer puts in place where it draws.
 */
#include "content.h"

#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <math.h>

#include "display.h"
#include "link.h"
#include "stage.h"

/* Device pixels of new text rasterized during a frame; larger text goes to the worker. */
#define INLINE_TEXT_PIXELS (512 * 256)
/* Seconds a frame may spend rasterizing new text itself. */
#define TEXT_SPARE 0.003

struct text_cache {
    struct media_text_layout layout;
    /* The layout serial last reported through a measure event. */
    uint64_t reported;
};

struct image_cache {
    struct media_image *image;
    /* The image last reported through a load or error event. */
    struct media_image *reported;
};

/* Text the worker rasterizes for a raster slot: one per node and output. */
struct text_job {
    struct server *server;
    struct node *node;
    int output_index;
    uint64_t slot, key, family;
    struct media_job *job;
    bool done, failed;
    double done_at;
    struct media_text_raster raster;
};

static void text_cache_destroy(void *data) {
    struct text_cache *cache = data;
    media_text_layout_finish(&cache->layout);
    free(cache);
}

static void image_cache_destroy(void *data) {
    struct image_cache *cache = data;
    if (cache->image) media_image_release(cache->image);
    free(cache);
}

/* Text. */

static void text_style(const struct node *node, struct media_text_style *style) {
    *style = MEDIA_TEXT_STYLE_DEFAULT;
    style->text = node_string(node, PROP_TEXT);
    style->markup = node_bool(node, PROP_MARKUP);
    style->font = node_string(node, PROP_FONT);
    style->size = node_prop(node, PROP_FONT_SIZE)->number;
    style->weight = node_prop(node, PROP_FONT_WEIGHT)->number;
    style->italic = node_bool(node, PROP_ITALIC);
    style->align = (enum media_align)node_choice(node, PROP_ALIGN);
    /* Only the width animates; the layout follows it. */
    style->width = node_given(node, PROP_WIDTH) ? node_number(node, PROP_WIDTH, 0) : 0;
    style->line_height =
        node_given(node, PROP_LINE_HEIGHT) ? node->props[PROP_LINE_HEIGHT].number : 0;
    style->max_lines =
        node_given(node, PROP_MAX_LINES) ? (int)MIN(node->props[PROP_MAX_LINES].id, 10000) : 0;
}

const struct media_text_layout *content_text_layout(struct server *server, struct node *node) {
    if (node->kind != KIND_TEXT) return NULL;
    struct text_cache *cache = node->cache;
    if (!cache) {
        cache = xcalloc(1, sizeof *cache);
        node->cache = cache;
        node->cache_destroy = text_cache_destroy;
    }
    struct media_text_style style;
    text_style(node, &style);
    media_text_layout_update(server->media, &cache->layout, &style, node->revision);
    return &cache->layout;
}

double content_text_color(const struct node *node, double color[4]) {
    if (node_given(node, PROP_COLOR) || node->channels[PROP_COLOR].count) {
        node_color(node, PROP_COLOR, color);
    } else {
        color[0] = color[1] = color[2] = 0;
        color[3] = 1;
    }
    return color[3];
}

static uint64_t text_family(const struct media_text_layout *layout, const double color[4]) {
    uint64_t hash = hash_bytes(HASH_SEED, &layout->serial, sizeof layout->serial);
    return hash_bytes(hash, color, 4 * sizeof *color);
}

uint64_t content_text_key(const struct media_text_layout *layout, const double color[4],
                          double scale) {
    uint64_t family = text_family(layout, color);
    return hash_bytes(family, &scale, sizeof scale);
}

double content_raster_scale(double exact, bool changing, double extent) {
    /* Half-octave steps above the exact scale: a zoom re-renders a few times instead
     * of every frame, and never upsamples. */
    double raster = changing ? pow(2, ceil(2 * log2(exact)) / 2) : exact;
    return fmin(MEDIA_MAX_RASTER_PIXELS / fmax(1, extent), raster);
}

static void free_job(struct text_job *job) {
    media_pixels_finish(&job->raster.pixels);
    free(job);
}

static void text_done(void *data, struct media_text_raster raster, const char *error) {
    struct text_job *job = data;
    struct server *server = job->server;
    job->job = NULL;
    job->done = true;
    job->done_at = now_seconds();
    if (raster.pixels.data) job->raster = raster;
    else job->failed = true;
    /* Repaint where the text is shown; the text left the screen if it is not. */
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        if (output->index == job->output_index && display_damage_node(output, job->node)) return;
    }
    idmap_remove(&server->text_jobs, (int64_t)job->slot);
    free_job(job);
}

/* Rasters: what is uploaded where the renderer draws, as the main thread keeps track of it. */
struct raster_entry {
    uint64_t key, family;
    double scale, used, lifetime;
};

/* Put PIXELS in SLOT for KEY, by an upload the next frame takes; PIXELS go with it. */
static void install_raster(struct server *server, struct vec *uploads, uint64_t slot, uint64_t key,
                           uint64_t family, double scale, double lifetime,
                           struct media_pixels *pixels, GLenum format) {
    struct raster_entry *entry = idmap_get(&server->rasters, (int64_t)slot);
    if (!entry) {
        entry = xcalloc(1, sizeof *entry);
        idmap_put(&server->rasters, (int64_t)slot, entry);
    }
    *entry = (struct raster_entry){key, family, scale, now_seconds(), lifetime};
    struct content_upload *upload = vec_push(uploads);
    *upload = (struct content_upload){
        .kind = CONTENT_RASTER, .slot = slot, .pixels = *pixels, .format = format};
    *pixels = (struct media_pixels){0};
}

static struct raster_entry *raster_entry(struct server *server, uint64_t slot) {
    return idmap_get(&server->rasters, (int64_t)slot);
}

void content_touch_raster(struct server *server, uint64_t slot) {
    struct raster_entry *entry = raster_entry(server, slot);
    if (entry) entry->used = now_seconds();
}

struct text_request {
    struct server *server;
    struct node *node;
    const struct media_text_layout *layout;
    uint64_t family;
    double scale;
    struct media_color color;
    bool failed;
    struct text_job *job;
    struct raster_entry *current;
    int output_index;
    struct vec *uploads;
};

static void produce_text(uint64_t slot, uint64_t key, struct text_request *request) {
    struct server *server = request->server;
    /* Text only rescaled waits for the worker, as does new text once the frame's
     * spare time is spent, or text too large to raster within it; after the worker
     * failed, the owner tries itself. */
    struct media_text_box box = media_text_raster_box(&request->layout->metrics, request->scale);
    bool large = (double)box.pixel_width * box.pixel_height > INLINE_TEXT_PIXELS;
    bool defer = request->current ? request->current->family == request->family
                                  : large || !(server->text_spare > 0);
    if (!request->failed && defer) {
        /* One job a slot at a time: what it brings is closer, and the next draw asks for the rest.
         */
        if (request->job) return;
        struct text_job *job = xcalloc(1, sizeof *job);
        job->server = server;
        job->node = request->node;
        job->output_index = request->output_index;
        job->slot = slot;
        job->key = key;
        job->family = request->family;
        idmap_put(&server->text_jobs, (int64_t)slot, job);
        job->job =
            media_queue_text(server->media, &request->layout->style, &request->layout->metrics,
                             request->color, request->scale, text_done, job);
        return;
    }
    double since = now_seconds();
    struct media_text_raster raster;
    if (media_text_rasterize(server->media, &request->layout->style, &request->layout->metrics,
                             request->color, request->scale, &raster)) {
        install_raster(server, request->uploads, slot, key, request->family, raster.scale, 2.0,
                       &raster.pixels, GL_BGRA_EXT);
    }
    server->text_spare -= now_seconds() - since;
}

bool content_text_prepare_raster(struct server *server, struct node *node, int output_index,
                                 uint64_t slot, uint64_t key, double scale, const double color[4],
                                 struct vec *uploads, double *raster_scale) {
    struct text_cache *cache = node->cache;
    if (!cache) return false;
    uint64_t family = text_family(&cache->layout, color);
    struct text_job *job = idmap_get(&server->text_jobs, (int64_t)slot);
    bool failed = false;
    /* A raster the worker finished replaces the one at hand, at whatever scale. */
    if (job && job->done) {
        idmap_remove(&server->text_jobs, (int64_t)slot);
        failed = job->failed;
        if (job->raster.pixels.data && job->family == family)
            install_raster(server, uploads, slot, job->key, family, job->raster.scale, 2.0,
                           &job->raster.pixels, GL_BGRA_EXT);
        free_job(job);
        job = NULL;
    }
    struct raster_entry *entry = raster_entry(server, slot);
    if (!entry || entry->key != key) {
        struct text_request request = {
            .server = server,
            .node = node,
            .layout = &cache->layout,
            .family = family,
            .scale = scale,
            .color = {color[0], color[1], color[2], color[3]},
            .failed = failed,
            .job = job,
            .current = entry,
            .output_index = output_index,
            .uploads = uploads,
        };
        produce_text(slot, key, &request);
        entry = raster_entry(server, slot);
    }
    /* At another scale, it shows until the worker's arrives. */
    if (!entry || (entry->key != key && entry->family != family)) return false;
    entry->used = now_seconds();
    entry->lifetime = 2;
    *raster_scale = entry->scale;
    return true;
}

/* Images. */

static void report_image(struct server *server, struct node *node, struct media_image *image) {
    struct event event;
    if (image->state == MEDIA_IMAGE_FAILED) {
        if (!event_begin(server, &event, node, EVENT_ERROR)) return;
        json_key(&event.writer, "message");
        json_string(&event.writer, image->error ? image->error : "");
        event_end(server, &event);
    } else if (media_image_loaded(image)) {
        if (!event_begin(server, &event, node, EVENT_LOAD)) return;
        json_key(&event.writer, "width");
        json_int(&event.writer, image->width);
        json_key(&event.writer, "height");
        json_int(&event.writer, image->height);
        event_end(server, &event);
    }
}

struct image_report {
    struct server *server;
    struct media_image *image;
};

static void report_to_node(struct node *node, void *data) {
    struct image_report *report = data;
    struct image_cache *cache = node->kind == KIND_IMAGE ? node->cache : NULL;
    if (cache && cache->image == report->image) {
        cache->reported = report->image;
        report_image(report->server, node, report->image);
    }
}

static void image_done(void *data, struct media_image *image, bool first) {
    struct server *server = data;
    if (first || image->state == MEDIA_IMAGE_FAILED) {
        struct image_report report = {server, image};
        scene_for_each(&server->scene, report_to_node, &report);
    }
    scene_changed(server);
}

struct media_image *content_image(struct server *server, struct node *node) {
    const char *path = node_string(node, PROP_SRC);
    struct image_cache *cache = node->cache;
    if (!cache) {
        cache = xcalloc(1, sizeof *cache);
        node->cache = cache;
        node->cache_destroy = image_cache_destroy;
    }
    if (cache->image && path && !strcmp(cache->image->path, path) &&
        media_image_current(cache->image))
        return cache->image;
    if (cache->image) media_image_release(cache->image);
    cache->image = path ? media_image_acquire(server->media, path) : NULL;
    return cache->image;
}

static uint64_t image_slot(const struct media_image *image) {
    uint64_t values[2] = {0x696d616765ull, image->serial};
    return hash_bytes(HASH_SEED, values, sizeof values);
}

bool content_image_shown(struct server *server, struct media_image *image) {
    if (!media_image_loaded(image)) return false;
    struct raster_entry *entry = raster_entry(server, image_slot(image));
    bool has_texture = entry && entry->key == image->serial;
    if (has_texture) entry->used = now_seconds();
    return media_image_show(image, has_texture);
}

bool content_image_prepare(struct server *server, struct node *node, struct vec *uploads,
                           uint64_t *slot) {
    struct image_cache *cache = node->cache;
    struct media_image *image = cache ? cache->image : NULL;
    if (!image) return false;
    *slot = image_slot(image);
    struct raster_entry *entry = raster_entry(server, *slot);
    if (!entry || entry->key != image->serial) {
        if (image->state != MEDIA_IMAGE_DECODED || !image->pixels.data) return false;
        /* The pixels go with the upload: uploaded is what the image becomes. */
        install_raster(server, uploads, *slot, image->serial, 0, 1, MEDIA_IMAGE_LIFETIME,
                       &image->pixels, GL_RGBA);
        media_image_uploaded(image);
        entry = raster_entry(server, *slot);
    }
    entry->used = now_seconds();
    entry->lifetime = MEDIA_IMAGE_LIFETIME;
    return true;
}

/* Uploads. */

void content_apply_uploads(struct renderer *renderer, const struct vec *uploads) {
    VEC_FOR(uploads, struct content_upload, upload) {
        switch (upload->kind) {
        case CONTENT_RASTER:
            render_install_raster(renderer, upload->slot, upload->pixels.data,
                                  upload->pixels.width, upload->pixels.height, upload->format);
            break;
        case CONTENT_DROP_RASTER: render_drop_raster(renderer, upload->slot); break;
        }
    }
}

void content_free_uploads(struct vec *uploads) {
    VEC_FOR(uploads, struct content_upload, upload) media_pixels_finish(&upload->pixels);
    vec_clear(uploads);
}

void content_frame_begin(struct server *server, struct vec *uploads) {
    /* Rasters dropped since the last frame go before anything it uploads. */
    VEC_FOR(&server->pending_uploads, struct content_upload, upload)
        *(struct content_upload *)vec_push(uploads) = *upload;
    vec_clear(&server->pending_uploads);
    server->text_spare = TEXT_SPARE;
}

void content_image_fit(int fit, const struct media_image *image, double width, double height,
                       struct box *quad, double uv[8]) {
    double natural_width = fmax(1, image->width), natural_height = fmax(1, image->height);
    double scale_x = width / natural_width, scale_y = height / natural_height;
    memcpy(uv, RENDER_FULL_UV, 8 * sizeof *uv);
    if (fit == FIT_CONTAIN) {
        double scale = fmin(scale_x, scale_y);
        double quad_width = natural_width * scale, quad_height = natural_height * scale;
        *quad = (struct box){(width - quad_width) / 2, (height - quad_height) / 2, quad_width,
                             quad_height};
    } else if (fit == FIT_COVER) {
        double scale = fmax(scale_x, scale_y);
        double u = width / (natural_width * scale) / 2, v = height / (natural_height * scale) / 2;
        *quad = (struct box){0, 0, width, height};
        double cover[8] = {0.5 - u, 0.5 - v, 0.5 + u, 0.5 - v, 0.5 - u, 0.5 + v, 0.5 + u, 0.5 + v};
        memcpy(uv, cover, sizeof cover);
    } else {
        *quad = (struct box){0, 0, width, height};
    }
}

void content_node_size(struct server *server, struct node *node, double *width, double *height) {
    if (node->kind == KIND_TEXT) {
        const struct media_text_layout *layout = content_text_layout(server, node);
        media_text_layout_size(layout, width, height);
        return;
    }
    /* A missing dimension follows the image's aspect ratio once loaded. */
    bool has_width = node_has_number(node, PROP_WIDTH),
         has_height = node_has_number(node, PROP_HEIGHT);
    *width = node_number(node, PROP_WIDTH, 0);
    *height = node_number(node, PROP_HEIGHT, 0);
    struct media_image *image = content_image(server, node);
    if (!image || !media_image_loaded(image) || (has_width && has_height)) return;
    double natural_width = image->width, natural_height = image->height;
    if (has_width) *height = *width * natural_height / natural_width;
    else if (has_height) *width = *height * natural_width / natural_height;
    else *width = natural_width, *height = natural_height;
}

void content_refresh_node(struct server *server, struct node *node) {
    if (node->kind == KIND_TEXT) {
        const struct media_text_layout *layout = content_text_layout(server, node);
        struct text_cache *cache = node->cache;
        if (layout && layout->serial != cache->reported) {
            cache->reported = layout->serial;
            double width, height;
            media_text_layout_size(layout, &width, &height);
            struct event event;
            if (event_begin(server, &event, node, EVENT_MEASURE)) {
                json_key(&event.writer, "width");
                json_number(&event.writer, width);
                json_key(&event.writer, "height");
                json_number(&event.writer, height);
                event_end(server, &event);
            }
        }
    } else if (node->kind == KIND_IMAGE) {
        struct media_image *image = content_image(server, node);
        struct image_cache *cache = node->cache;
        if (image && image != cache->reported &&
            (media_image_loaded(image) || image->state == MEDIA_IMAGE_FAILED)) {
            cache->reported = image;
            report_image(server, node, image);
        }
    }
}

void content_node_dead(struct server *server, struct node *node) {
    if (node->kind != KIND_TEXT) return;
    size_t index = 0;
    int64_t slot;
    void *value;
    while (idmap_next(&server->text_jobs, &index, &slot, &value)) {
        struct text_job *job = value;
        if (job->node != node) continue;
        if (job->job) media_job_cancel(server->media, job->job);
        idmap_remove(&server->text_jobs, slot);
        free_job(job);
    }
}

void content_release_stale(struct server *server) {
    double time = now_seconds();
    media_release_stale(server->media, time);
    /* Rasters unused for their lifetime go with the next frame's uploads. One an output's
     * cached display draws was touched when that display was built. */
    double built_at = displays_built_at(server);
    size_t at = 0;
    int64_t raster_slot;
    void *raster;
    while (idmap_next(&server->rasters, &at, &raster_slot, &raster)) {
        struct raster_entry *entry = raster;
        if (built_at - entry->used <= entry->lifetime) continue;
        idmap_remove(&server->rasters, raster_slot);
        free(entry);
        *(struct content_upload *)vec_push(&server->pending_uploads) =
            (struct content_upload){.kind = CONTENT_DROP_RASTER, .slot = (uint64_t)raster_slot};
    }
    /* Text the worker finished after it left the screen, before a draw installed it. */
    size_t index = 0;
    int64_t slot;
    void *value;
    while (idmap_next(&server->text_jobs, &index, &slot, &value)) {
        struct text_job *job = value;
        if (job->done && time - job->done_at > 2) {
            idmap_remove(&server->text_jobs, slot);
            free_job(job);
        }
    }
}

bool content_measure_text(struct server *server, const struct json_value *props, double *width,
                          double *height, struct protocol_error *error) {
    enum { TEXT, MARKUP, FONT, SIZE, WEIGHT, ITALIC, ALIGN, WIDTH, LINE_HEIGHT, MAX_LINES, COUNT };
    static const enum prop_key keys[COUNT] = {
        [TEXT] = PROP_TEXT,          [MARKUP] = PROP_MARKUP,      [FONT] = PROP_FONT,
        [SIZE] = PROP_FONT_SIZE,     [WEIGHT] = PROP_FONT_WEIGHT, [ITALIC] = PROP_ITALIC,
        [ALIGN] = PROP_ALIGN,        [WIDTH] = PROP_WIDTH,        [LINE_HEIGHT] = PROP_LINE_HEIGHT,
        [MAX_LINES] = PROP_MAX_LINES};
    struct prop_value v[COUNT] = {0};
    bool ok = true;
    for (int k = 0; ok && k < COUNT; k++)
        ok = prop_decode(keys[k], props ? json_get(props, PROP_SPECS[keys[k]].name) : NULL, &v[k],
                         error);
    if (ok) {
        struct media_text_style style = MEDIA_TEXT_STYLE_DEFAULT;
        style.text = v[TEXT].given ? v[TEXT].string : NULL;
        style.markup = v[MARKUP].given && v[MARKUP].boolean;
        style.font = v[FONT].given ? v[FONT].string : NULL;
        if (v[SIZE].given) style.size = v[SIZE].number;
        if (v[WEIGHT].given) style.weight = v[WEIGHT].number;
        style.italic = v[ITALIC].given && v[ITALIC].boolean;
        style.align = v[ALIGN].given ? (enum media_align)v[ALIGN].choice : MEDIA_ALIGN_START;
        style.width = v[WIDTH].given ? v[WIDTH].number : 0;
        style.line_height = v[LINE_HEIGHT].given ? v[LINE_HEIGHT].number : 0;
        style.max_lines = v[MAX_LINES].given ? (int)MIN(v[MAX_LINES].id, 10000) : 0;
        struct media_text_metrics metrics;
        media_text_measure(server->media, &style, &metrics);
        *width = metrics.width;
        *height = metrics.height;
    }
    for (int k = 0; k < COUNT; k++) prop_value_finish(keys[k], &v[k]);
    return ok;
}

static int media_ready(int fd, uint32_t mask, void *data) {
    struct server *server = data;
    media_dispatch(server->media);
    return 0;
}

void content_init(struct server *server) {
    idmap_init(&server->text_jobs);
    idmap_init(&server->rasters);
    vec_init(&server->pending_uploads, sizeof(struct content_upload));
    server->media = media_create(image_done, server);
    if (server->media)
        server->media_source = wl_event_loop_add_fd(server->loop, media_get_fd(server->media),
                                                    WL_EVENT_READABLE, media_ready, server);
}

void content_finish(struct server *server) {
    size_t index = 0;
    int64_t slot;
    void *value;
    while (idmap_next(&server->text_jobs, &index, &slot, &value)) free_job(value);
    idmap_finish(&server->text_jobs);
    index = 0;
    while (idmap_next(&server->rasters, &index, &slot, &value)) free(value);
    idmap_finish(&server->rasters);
    content_free_uploads(&server->pending_uploads);
    vec_finish(&server->pending_uploads);
    if (server->media_source) wl_event_source_remove(server->media_source);
    if (server->media) media_destroy(server->media);
    server->media = NULL;
}
