/* Text measuring and rasters, image decoding and the media worker. */
#include "media.h"
#include "util.h"

#include <dirent.h>
#include <glob.h>
#include <math.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

static int failures;

#define CHECK(condition, ...)                                                                      \
    do {                                                                                           \
        if (!(condition)) {                                                                        \
            failures++;                                                                            \
            fprintf(stderr, "%s:%d: failed: %s: ", __FILE__, __LINE__, #condition);                \
            fprintf(stderr, __VA_ARGS__);                                                          \
            fputc('\n', stderr);                                                                   \
        }                                                                                          \
    } while (0)

static const char *paragraph =
    "Proscenium lays text out with Pango at its logical size, so a layout measures the same "
    "at every zoom and only the raster scale changes when the camera moves.";

static struct media_text_style style_of(const char *text) {
    struct media_text_style style = MEDIA_TEXT_STYLE_DEFAULT;
    style.text = text;
    return style;
}

static bool near(double a, double b, double tolerance) {
    return fabs(a - b) <= tolerance;
}

/* Check a raster of STYLE at SCALE against its metrics; return its pixel width. */
static int check_raster(struct media *media, const char *name, const struct media_text_style *style,
                        const struct media_text_metrics *metrics, double scale) {
    struct media_text_raster raster;
    struct media_color red = {1, 0, 0, 1};
    if (!media_text_rasterize(media, style, metrics, red, scale, &raster)) {
        CHECK(false, "%s: no raster at scale %g", name, scale);
        return 0;
    }
    struct media_pixels *pixels = &raster.pixels;
    struct media_text_box box = media_text_raster_box(metrics, scale);
    CHECK(pixels->format == MEDIA_PIXELS_BGRA, "%s", name);
    CHECK(pixels->width == box.pixel_width && pixels->height == box.pixel_height,
          "%s: %dx%d vs box %dx%d", name, pixels->width, pixels->height, box.pixel_width,
          box.pixel_height);
    CHECK(raster.scale == scale && raster.box.left == box.left, "%s", name);
    CHECK(pixels->stride >= 4 * pixels->width, "%s", name);
    /* The raster holds the logical box, the ink beyond it and a pixel of padding a side. */
    int logical = (int)ceil(metrics->width * scale);
    int overhang = (int)ceil((metrics->right - metrics->left - metrics->width) * scale);
    CHECK(pixels->width >= logical && pixels->width <= logical + 2 + overhang + 1,
          "%s @%g: raster width %d, logical %d, overhang %d", name, scale, pixels->width, logical,
          overhang);
    CHECK(pixels->height >= (int)ceil(metrics->height * scale), "%s @%g: height %d < %g", name,
          scale, pixels->height, metrics->height * scale);
    int inked = 0, wrong = 0, border = 0;
    for (int y = 0; y < pixels->height; y++) {
        const uint8_t *row = pixels->data + (size_t)y * pixels->stride;
        for (int x = 0; x < pixels->width; x++) {
            const uint8_t *p = row + 4 * x;
            /* Premultiplied red in BGRA: blue and green empty, red equal to alpha. */
            if (p[0] || p[1] || p[2] != p[3]) wrong++;
            if (p[3]) inked++;
            bool edge = x == 0 || y == 0 || x == pixels->width - 1 || y == pixels->height - 1;
            if (edge && p[3]) border++;
        }
    }
    CHECK(inked > 0, "%s @%g: no ink", name, scale);
    CHECK(wrong == 0, "%s @%g: %d pixels not premultiplied red", name, scale, wrong);
    CHECK(border == 0, "%s @%g: %d inked pixels on the padding", name, scale, border);
    int width = pixels->width;
    media_pixels_finish(pixels);
    CHECK(!pixels->data, "%s", name);
    return width;
}

static void check_text(struct media *media, const char *name, const struct media_text_style *style,
                       struct media_text_metrics *metrics) {
    media_text_measure(media, style, metrics);
    printf("  %-12s %7.2f x %6.2f  ink+logical [%.2f %.2f %.2f %.2f]\n", name, metrics->width,
           metrics->height, metrics->left, metrics->top, metrics->right, metrics->bottom);
    CHECK(metrics->width > 0 && metrics->height > 0, "%s: empty", name);
    int one = check_raster(media, name, style, metrics, 1);
    int two = check_raster(media, name, style, metrics, 2);
    CHECK(abs(two - 2 * one) <= 3, "%s: %d at scale 2, %d at scale 1", name, two, one);
    check_raster(media, name, style, metrics, 0.75);
}

static void test_text(struct media *media) {
    printf("text\n");
    struct media_text_metrics plain, bold, markup, broken, broken_plain;
    struct media_text_style style = style_of("Hello, world");
    check_text(media, "plain", &style, &plain);
    CHECK(plain.width > 40 && plain.width < 120, "plain width %g", plain.width);
    CHECK(plain.height >= 14 && plain.height < 25, "plain height %g", plain.height);
    double line = plain.height;

    style = style_of("Hello bold world");
    media_text_measure(media, &style, &bold);
    style = style_of("Hello <b>bold</b> world");
    style.markup = true;
    check_text(media, "markup", &style, &markup);
    CHECK(markup.width > bold.width, "bold span %g not wider than plain %g", markup.width,
          bold.width);
    CHECK(near(markup.height, bold.height, 0.01), "%g vs %g", markup.height, bold.height);

    style = style_of("<b>unclosed");
    style.markup = true;
    media_text_measure(media, &style, &broken);
    style.markup = false;
    media_text_measure(media, &style, &broken_plain);
    CHECK(broken.width == broken_plain.width, "markup that does not parse shows as text");

    struct media_text_metrics wrapped, ellipsized, two_lines, spaced, centered, single;
    style = style_of(paragraph);
    media_text_measure(media, &style, &single);
    style.width = 120;
    check_text(media, "wrapped", &style, &wrapped);
    CHECK(wrapped.width <= 120.01, "wrapped width %g", wrapped.width);
    CHECK(wrapped.height >= 4 * line - 0.01, "wrapped height %g", wrapped.height);
    style.align = MEDIA_ALIGN_CENTER;
    media_text_measure(media, &style, &centered);
    CHECK(centered.width == wrapped.width && centered.height == wrapped.height, "centered size");

    style = style_of(paragraph);
    style.width = 120;
    style.max_lines = 1;
    check_text(media, "ellipsized", &style, &ellipsized);
    CHECK(near(ellipsized.height, line, 0.01), "ellipsized height %g, line %g", ellipsized.height,
          line);
    CHECK(ellipsized.width <= 120.01 && ellipsized.width > 60, "ellipsized width %g",
          ellipsized.width);
    style.max_lines = 2;
    check_text(media, "maxLines 2", &style, &two_lines);
    CHECK(near(two_lines.height, 2 * line, 0.5), "two lines %g, line %g", two_lines.height, line);
    /* Without a width, maxLines has nothing to ellipsize against. */
    style.width = 0;
    struct media_text_metrics unlimited;
    media_text_measure(media, &style, &unlimited);
    CHECK(unlimited.width == single.width && unlimited.height == single.height, "no width");

    style = style_of("one\ntwo\nthree");
    style.line_height = 2;
    check_text(media, "lineHeight 2", &style, &spaced);
    CHECK(near(spaced.height, line + 2 * 28, 0.5), "spaced height %g, line %g", spaced.height,
          line);
    CHECK(near(spaced.spacing, 28 - line, 0.01), "spacing %g", spaced.spacing);

    style = style_of("Italic, larger");
    style.size = 32;
    style.italic = true;
    style.weight = 700;
    style.font = "serif";
    struct media_text_metrics italic;
    check_text(media, "italic 32", &style, &italic);
    CHECK(italic.height > 32, "italic height %g", italic.height);

    /* A layout measures again only when its style changes. */
    struct media_text_layout layout = {0};
    style = style_of(paragraph);
    CHECK(media_text_layout_update(media, &layout, &style, 1), "first update measures");
    uint64_t serial = layout.serial;
    CHECK(!media_text_layout_update(media, &layout, &style, 1), "same revision");
    CHECK(!media_text_layout_update(media, &layout, &style, 2), "same style, new revision");
    CHECK(layout.serial == serial && layout.prop_revision == 2, "serial kept");
    style.width = 120;
    CHECK(media_text_layout_update(media, &layout, &style, 2), "an animated width");
    CHECK(layout.serial != serial && layout.metrics.height == wrapped.height, "rewrapped");
    double width, height;
    media_text_layout_size(&layout, &width, &height);
    CHECK(width == 120 && height == wrapped.height, "node size %g x %g", width, height);
    char edited[256];
    snprintf(edited, sizeof edited, "%s", paragraph);
    style.text = edited;
    CHECK(!media_text_layout_update(media, &layout, &style, 3), "equal text in other memory");
    edited[0] = 'p';
    CHECK(media_text_layout_update(media, &layout, &style, 4), "edited text");
    style.width = 0;
    media_text_layout_update(media, &layout, &style, 5);
    media_text_layout_size(&layout, &width, &height);
    CHECK(width > 1000 && width == layout.metrics.width && height == line, "unwrapped size %g",
          width);
    media_text_layout_finish(&layout);

    double start = now_seconds();
    char text[64];
    for (int i = 0; i < 200; i++) {
        snprintf(text, sizeof text, "Label number %d", i);
        style = style_of(text);
        struct media_text_metrics metrics;
        media_text_measure(media, &style, &metrics);
    }
    printf("  measure: %.1f us a text\n", (now_seconds() - start) / 200 * 1e6);
}

static const char *find_file(const char *const *patterns) {
    static char found[4096];
    for (const char *const *pattern = patterns; *pattern; pattern++) {
        glob_t matches;
        if (glob(*pattern, 0, NULL, &matches) == 0 && matches.gl_pathc > 0) {
            snprintf(found, sizeof found, "%s", matches.gl_pathv[0]);
            globfree(&matches);
            return found;
        }
        globfree(&matches);
    }
    return NULL;
}

static void check_premultiplied(const char *name, const struct media_pixels *pixels) {
    int wrong = 0, translucent = 0;
    for (int y = 0; y < pixels->height; y++) {
        const uint8_t *row = pixels->data + (size_t)y * pixels->stride;
        for (int x = 0; x < pixels->width; x++) {
            const uint8_t *p = row + 4 * x;
            if (p[0] > p[3] || p[1] > p[3] || p[2] > p[3]) wrong++;
            if (p[3] < 255) translucent++;
        }
    }
    CHECK(wrong == 0, "%s: %d pixels brighter than their alpha", name, wrong);
    printf("  %s: %d of %d pixels translucent\n", name, translucent,
           pixels->width * pixels->height);
}

static void test_images(char *png, char *svg) {
    printf("images\n");
    struct media_pixels pixels;
    int width, height;
    char *error;
    bool decoded = media_decode_image(png, &pixels, &width, &height, &error);
    CHECK(decoded, "%s: %s", png, error ? error : "");
    if (decoded) {
        printf("  png %s: %dx%d\n", png, width, height);
        CHECK(pixels.format == MEDIA_PIXELS_RGBA && pixels.stride >= 4 * pixels.width, "png");
        CHECK(pixels.width == width && pixels.height == height, "a bitmap decodes at its size");
        check_premultiplied("png", &pixels);
        media_pixels_finish(&pixels);
    }
    free(error);

    decoded = media_decode_image(svg, &pixels, &width, &height, &error);
    CHECK(decoded, "%s: %s", svg, error ? error : "");
    if (decoded) {
        int natural = MAX(1, MAX(width, height));
        int limit = MIN(MEDIA_MAX_RASTER_PIXELS, MAX(natural, MIN(1024, MAX(256, 4 * natural))));
        printf("  svg %s: %dx%d, pixels %dx%d\n", svg, width, height, pixels.width, pixels.height);
        CHECK(MAX(pixels.width, pixels.height) == limit, "svg raster %dx%d, expected side %d",
              pixels.width, pixels.height, limit);
        check_premultiplied("svg", &pixels);
        media_pixels_finish(&pixels);
    }
    free(error);

    const char *others[] = {"/usr/share/pixmaps/faces/coffee2.jpg",
                            "/usr/share/cups/doc-root/images/wait.gif",
                            "/usr/share/backgrounds/moskalenko-v-Snowy_Ubuntu_Light.webp", NULL};
    for (const char *const *path = others; *path; path++) {
        if (access(*path, R_OK) != 0) continue;
        double start = now_seconds();
        decoded = media_decode_image(*path, &pixels, &width, &height, &error);
        printf("  %s: %s %dx%d (pixels %dx%d) in %.0f ms\n", *path, decoded ? "decoded" : error,
               width, height, pixels.width, pixels.height, (now_seconds() - start) * 1e3);
        if (decoded) {
            CHECK(MAX(pixels.width, pixels.height) <= MEDIA_MAX_RASTER_PIXELS, "%s", *path);
            check_premultiplied(*path, &pixels);
        }
        media_pixels_finish(&pixels);
        free(error);
    }

    CHECK(!media_decode_image("/etc/hostname", &pixels, &width, &height, &error), "text file");
    CHECK(error && !pixels.data, "an error for a text file");
    free(error);
    CHECK(!media_decode_image("/nonexistent.png", &pixels, &width, &height, &error), "missing");
    free(error);
}

/* The worker. */

struct text_result {
    int delivered;
    struct media_text_raster raster;
    char *error;
};

static int text_count;

static void text_done(void *data, struct media_text_raster raster, const char *error) {
    struct text_result *result = data;
    result->delivered++;
    result->raster = raster;
    result->error = error ? xstrdup(error) : NULL;
    text_count++;
}

static int image_count, first_count;
static struct media_image *last_image;

static void image_done(void *data, struct media_image *image, bool first) {
    image_count++;
    first_count += first;
    last_image = image;
}

static bool wait_until(struct media *media, int *counter, int target, double seconds) {
    double deadline = now_seconds() + seconds;
    while (*counter < target) {
        int left = (int)((deadline - now_seconds()) * 1000);
        if (left <= 0) return false;
        struct pollfd poll_fd = {.fd = media_get_fd(media), .events = POLLIN};
        if (poll(&poll_fd, 1, left) > 0) media_dispatch(media);
    }
    return true;
}

static bool fd_readable(struct media *media, int milliseconds) {
    struct pollfd poll_fd = {.fd = media_get_fd(media), .events = POLLIN};
    return poll(&poll_fd, 1, milliseconds) > 0;
}

/* Context switches of the thread named NAME, or -1. */
static long thread_switches(const char *name) {
    DIR *tasks = opendir("/proc/self/task");
    long switches = -1;
    struct dirent *entry;
    while (tasks && (entry = readdir(tasks))) {
        char path[300], line[256];
        snprintf(path, sizeof path, "/proc/self/task/%s/status", entry->d_name);
        FILE *status = fopen(path, "r");
        if (!status) continue;
        bool match = false;
        long total = 0, value;
        while (fgets(line, sizeof line, status)) {
            char thread[64];
            if (sscanf(line, "Name: %63s", thread) == 1) match = strcmp(thread, name) == 0;
            if (sscanf(line, "voluntary_ctxt_switches: %ld", &value) == 1) total += value;
            if (sscanf(line, "nonvoluntary_ctxt_switches: %ld", &value) == 1) total += value;
        }
        fclose(status);
        if (match) switches = total;
    }
    if (tasks) closedir(tasks);
    return switches;
}

static void test_worker(char *png, char *svg) {
    printf("worker\n");
    struct media *media = media_create(image_done, NULL);
    CHECK(media && media_get_fd(media) >= 0, "media");
    CHECK(!fd_readable(media, 0), "nothing to dispatch");

    /* Worker rasters match the owner thread's, pixel for pixel. */
    struct media_text_style styles[3] = {style_of("Hello, world"), style_of(paragraph),
                                         style_of("Hello <b>bold</b> world")};
    styles[1].width = 150;
    styles[1].max_lines = 2;
    styles[2].markup = true;
    struct media_color color = {0.2, 0.4, 0.8, 0.9};
    struct media_text_metrics metrics[3];
    struct text_result results[6] = {0};
    for (int i = 0; i < 6; i++) {
        media_text_measure(media, &styles[i / 2], &metrics[i / 2]);
        media_queue_text(media, &styles[i / 2], &metrics[i / 2], color, i % 2 ? 2.5 : 1, text_done,
                         &results[i]);
    }
    struct text_result cancelled = {0};
    struct media_job *job =
        media_queue_text(media, &styles[0], &metrics[0], color, 3, text_done, &cancelled);
    media_job_cancel(media, job);
    CHECK(wait_until(media, &text_count, 6, 10), "text jobs: %d of 6", text_count);
    for (int i = 0; i < 6; i++) {
        struct media_text_raster *raster = &results[i].raster;
        struct media_text_raster local;
        CHECK(results[i].delivered == 1 && raster->pixels.data, "job %d: %s", i,
              results[i].error ? results[i].error : "");
        if (!raster->pixels.data) continue;
        media_text_rasterize(media, &styles[i / 2], &metrics[i / 2], color, raster->scale, &local);
        CHECK(raster->pixels.width == local.pixels.width &&
                  raster->pixels.height == local.pixels.height &&
                  raster->box.left == local.box.left && raster->box.width == local.box.width,
              "job %d size", i);
        bool same = raster->pixels.width == local.pixels.width;
        for (int y = 0; same && y < local.pixels.height; y++) {
            same = memcmp(raster->pixels.data + (size_t)y * raster->pixels.stride,
                          local.pixels.data + (size_t)y * local.pixels.stride,
                          4 * (size_t)local.pixels.width) == 0;
        }
        CHECK(same, "job %d: worker pixels differ from the owner's", i);
        media_pixels_finish(&local.pixels);
        media_pixels_finish(&raster->pixels);
    }
    CHECK(cancelled.delivered == 0, "a cancelled job was delivered");

    /* A finished job its owner dropped before the drain is freed undelivered. */
    struct text_result orphan = {0};
    job = media_queue_text(media, &styles[1], &metrics[1], color, 1, text_done, &orphan);
    CHECK(fd_readable(media, 5000), "orphan finished");
    media_job_cancel(media, job);
    media_dispatch(media);
    CHECK(orphan.delivered == 0, "an orphaned job was delivered");

    /* Shared images. */
    struct media_image *image = media_image_acquire(media, png);
    CHECK(media_image_acquire(media, png) == image && image->refs == 2, "shared by path");
    media_image_release(image);
    CHECK(image->state == MEDIA_IMAGE_DECODING && !media_image_loaded(image), "decoding");
    CHECK(!media_image_show(image, false), "nothing to show while decoding");
    CHECK(wait_until(media, &image_count, 1, 10), "png decode");
    CHECK(last_image == image && first_count == 1, "first decode");
    CHECK(image->state == MEDIA_IMAGE_DECODED && image->pixels.data && media_image_loaded(image),
          "decoded: %s", image->error ? image->error : "");
    CHECK(media_image_current(image), "current");
    CHECK(media_image_show(image, false), "decoded pixels show");
    double touched = image->touched;
    media_release_stale(media, touched + 1);
    CHECK(image->state == MEDIA_IMAGE_DECODED && image->pixels.data, "fresh pixels stay");
    media_image_uploaded(image);
    CHECK(image->state == MEDIA_IMAGE_READY && !image->pixels.data, "uploaded");
    CHECK(media_image_show(image, true), "texture shows");
    /* The texture went away: decode again. */
    CHECK(!media_image_show(image, false) && image->state == MEDIA_IMAGE_DECODING, "redecode");
    CHECK(wait_until(media, &image_count, 2, 10), "png decode again");
    CHECK(first_count == 1 && image->state == MEDIA_IMAGE_DECODED, "second decode");
    media_release_stale(media, image->touched + MEDIA_IMAGE_LIFETIME + 1);
    CHECK(image->state == MEDIA_IMAGE_IDLE && !image->pixels.data, "stale pixels released");

    struct media_image *relative = media_image_acquire(media, "icons/x.png");
    CHECK(relative->state == MEDIA_IMAGE_FAILED && relative->error, "relative path");
    media_image_release(relative);

    /* An image forgotten while it decodes never reports. */
    int before = image_count;
    struct media_image *forgotten = media_image_acquire(media, svg);
    media_image_release(forgotten);
    struct media_image *missing = media_image_acquire(media, "/nonexistent/image.png");
    CHECK(wait_until(media, &image_count, before + 1, 10), "missing file reports");
    CHECK(last_image == missing && missing->state == MEDIA_IMAGE_FAILED && missing->error,
          "missing file fails");
    printf("  missing file: %s\n", missing->error);
    CHECK(image_count == before + 1, "the forgotten image reported");
    media_image_release(missing);

    /* Settled, the worker sleeps: no wakeups at all. */
    long switches = thread_switches("media");
    usleep(300000);
    CHECK(switches >= 0 && thread_switches("media") == switches, "idle worker woke: %ld -> %ld",
          switches, thread_switches("media"));
    CHECK(!fd_readable(media, 0), "nothing left to dispatch");

    /* Destroying with work queued and results waiting frees them all. */
    struct text_result late[4] = {0};
    for (int i = 0; i < 4; i++) {
        media_queue_text(media, &styles[1], &metrics[1], color, 1 + i, text_done, &late[i]);
    }
    struct media_image *pending = media_image_acquire(media, svg);
    usleep(20000);
    media_destroy(media);
    CHECK(!pending->registered && !pending->pixels.data, "detached");
    media_image_release(pending);
    media_image_release(image);
    for (int i = 0; i < 4; i++) CHECK(late[i].delivered == 0, "delivered after destroy");
    for (int i = 0; i < 6; i++) free(results[i].error);
}

int main(void) {
    const char *png_patterns[] = {"/usr/share/icons/hicolor/48x48/apps/*.png",
                                  "/usr/share/icons/*/48x48/*/*.png", "/usr/share/pixmaps/*.png",
                                  NULL};
    const char *svg_patterns[] = {"/usr/share/icons/hicolor/scalable/apps/*.svg",
                                  "/usr/share/icons/*/scalable/*/*.svg", NULL};
    const char *found = find_file(png_patterns);
    char *png = found ? xstrdup(found) : NULL;
    found = find_file(svg_patterns);
    char *svg = found ? xstrdup(found) : NULL;
    CHECK(png && svg, "no PNG or SVG under /usr/share/icons");

    struct media *media = media_create(NULL, NULL);
    test_text(media);
    media_destroy(media);
    if (png && svg) {
        test_images(png, svg);
        test_worker(png, svg);
    }
    free(png);
    free(svg);
    if (failures) {
        fprintf(stderr, "%d checks failed\n", failures);
        return 1;
    }
    printf("all media checks passed\n");
    return 0;
}
