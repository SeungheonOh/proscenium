/*
 * Pixels of what the scene shows: windows and output regions, for the
 * director's screenshots and for screen sharing.
 *
 * Everything renders into offscreen targets through the EGL context, so a
 * capture never forces an output frame. A screenshot leaves the compositor as
 * raw RGBA in a private file; the director encodes it, keeping compression off
 * the compositor's loop.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <unistd.h>
#include <wlr/types/wlr_output.h>
#include <wlr/util/log.h>

#include "display.h"
#include "link.h"
#include "stage.h"

/* Largest screenshot side, in pixels. */
#define CAPTURE_LIMIT 8192

void fit_size(int width, int height, int limit_width, int limit_height, int *out_width,
              int *out_height) {
    double factor =
        fmin(1, fmin((double)limit_width / MAX(1, width), (double)limit_height / MAX(1, height)));
    *out_width = MAX(1, (int)lround(factor * width));
    *out_height = MAX(1, (int)lround(factor * height));
}

static struct box source_region(const struct capture_source *source) {
    return source->has_region ? source->region
                              : (struct box){0, 0, source->output->width, source->output->height};
}

bool capture_source_size(const struct capture_source *source, int *x, int *y, int *width,
                         int *height, struct protocol_error *error) {
    if (source->window) {
        struct wlr_box bounds = window_bounds(source->window);
        if (bounds.width <= 0 || bounds.height <= 0)
            return protocol_fail(error, "Window %llu shows nothing.",
                                 (unsigned long long)source->window->id);
        double scale = fmax(1, window_scale(source->window));
        *x = *y = 0;
        *width = (int)lround(scale * bounds.width);
        *height = (int)lround(scale * bounds.height);
        return true;
    }
    struct output *output = source->output;
    struct box r = source_region(source);
    if (!(r.x >= 0 && r.y >= 0 && r.width >= 8 && r.height >= 8 &&
          box_right(r) <= output->width + 1e-6 && box_bottom(r) <= output->height + 1e-6))
        return protocol_fail(error, "The region lies outside output %s.", output_name(output));
    double scale = output->wlr_output->scale;
    *x = (int)lround(output->offset + r.x);
    *y = (int)lround(r.y);
    *width = (int)lround(r.width * scale);
    *height = (int)lround(r.height * scale);
    return true;
}

bool capture_read(struct server *server, const struct capture_source *source,
                  struct box window_bounds, int width, int height, void *pixels,
                  struct display_targets *targets) {
    if (source->window)
        return display_read_window(server, source->window, window_bounds, width, height, pixels,
                                   targets);
    return display_read_region(source->output, source_region(source), width, height, pixels,
                               targets);
}

static void send_captured(struct server *server, int64_t id, const char *path, int width,
                          int height, const char *error) {
    struct message message;
    message_begin(&message, "captured");
    struct json_writer *w = &message.writer;
    json_key(w, "id");
    json_int(w, id);
    if (error) {
        json_key(w, "error");
        json_string(w, error);
    } else {
        json_key(w, "path");
        json_string(w, path);
        json_key(w, "width");
        json_int(w, width);
        json_key(w, "height");
        json_int(w, height);
    }
    message_send(server, &message, NULL);
}

static bool write_file(const char *path, const void *bytes, size_t length) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    const char *p = bytes;
    while (length) {
        ssize_t written = write(fd, p, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) {
            close(fd);
            unlink(path);
            return false;
        }
        p += written;
        length -= (size_t)written;
    }
    return close(fd) == 0;
}

/* Write the source at full resolution to a private file and tell the director where;
 * the director owns the file from then on. */
void capture_for_director(struct server *server, int64_t id, const struct capture_source *source) {
    struct protocol_error error = {0};
    int x, y, source_width, source_height;
    if (!capture_source_size(source, &x, &y, &source_width, &source_height, &error)) {
        send_captured(server, id, NULL, 0, 0, error.message);
        return;
    }
    int width, height;
    fit_size(source_width, source_height, CAPTURE_LIMIT, CAPTURE_LIMIT, &width, &height);
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    char path[512];
    snprintf(path, sizeof path, "%s/proscenium-%d-capture-%lld.rgba", runtime ? runtime : "/tmp",
             getpid(), (long long)id);
    void *pixels = malloc((size_t)width * height * 4);
    struct display_targets targets = {0};
    bool read =
        pixels && server_gl_current(server) &&
        capture_read(server, source,
                     source->window ? box_of(window_bounds(source->window)) : (struct box){0},
                     width, height, pixels, &targets);
    if (server_gl_current(server)) display_release_targets(&targets);
    if (!read) send_captured(server, id, NULL, 0, 0, "The capture could not be rendered.");
    else if (!write_file(path, pixels, (size_t)width * height * 4))
        send_captured(server, id, NULL, 0, 0, strerror(errno));
    else send_captured(server, id, path, width, height, NULL);
    free(pixels);
}
