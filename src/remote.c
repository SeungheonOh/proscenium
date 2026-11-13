/*
 * Remote access: one output streamed as H.264 to browsers, and their pointer
 * and keyboard driving the seat as if they were plugged in.
 *
 * stream.c serves viewers and encodes on a thread of its own. Here frames are
 * taken from the output itself: right after the renderer draws a frame, while
 * someone watches and at most PROSCENIUM_REMOTE_FPS (60) times a second, the
 * GPU scales a copy of the output buffer to the stream's size and starts
 * reading it into a pixel buffer behind a fence (a "tap" on the display). The
 * compositor's loop collects the pixels once the fence passes, so it never
 * waits on the GPU or draws the scene twice, and a still output sends nothing.
 * Software cursors go over the buffer after the tap, so the stream has none:
 * viewers draw the pointer themselves, in the shape it has here, and it moves
 * without waiting for a frame. Contexts without GLES 3, and rotated outputs,
 * fall back to reading the output back from the display list.
 *
 * Viewers' input arrives as events and plays through a pointer and a keyboard
 * of the remote's own, attached like any other device, so shortcuts, bindings,
 * gestures on the scene and clients all see it as they see local input.
 */
#include <GLES3/gl3.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wlr/interfaces/wlr_keyboard.h>
#include <wlr/interfaces/wlr_pointer.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_output.h>
#include <wlr/util/log.h>

#include "display.h"
#include "gl.h"
#include "input.h"
#include "stage.h"
#include "stream.h"

/* Largest stream; larger outputs are scaled down to fit. */
#define REMOTE_WIDTH 2560
#define REMOTE_HEIGHT 1600
/* Logical pixels a wheel notch scrolls, as libinput reports them. */
#define NOTCH 15.0
/* evdev codes: buttons from BTN_LEFT, keys below KEY_MAX. */
#define BUTTON_BASE 0x110
#define BUTTON_COUNT 8
#define KEY_COUNT 0x300
/* Readbacks in flight at once. */
#define SLOTS 3
/* How often to look whether a readback finished. */
#define COLLECT_MS 1

enum slot_state { SLOT_FREE, SLOT_FILLING, SLOT_FLIGHT };

struct slot {
    enum slot_state state;
    GLuint buffer;
    GLsync fence;
    int width, height;
    size_t capacity;
    /* STREAM_I420, converted on the GPU, or STREAM_RGBA where the shader would not build. */
    enum stream_format format;
    /* Taps fill slots in order; the oldest in flight is collected first. */
    uint64_t sequence;
};

/* What the tap shares between the thread that draws and the compositor's loop. */
struct tap {
    pthread_mutex_t lock;
    /* Under the lock. */
    bool enabled;
    int width, height;
    double interval, last;
    /* A frame was drawn but not taken, as it came too soon or no slot was free. */
    bool missed;
    /* The context has no GLES 3: the compositor's loop reads frames back itself. */
    bool unsupported;
    struct slot slots[SLOTS];
    uint64_t sequence;
    /* The drawing thread's own: the frame scaled to the stream's size, the same in I420
     * planes, and the program that converts it. */
    bool checked, shader_failed;
    struct render_target *target, *planes;
    GLuint program, vao;
    GLint source_uniform, size_uniform;
};

struct remote {
    struct server *server;
    struct stream *stream;
    struct wl_event_source *readable, *timer, *collector;
    int viewers;
    double interval;
    /* PROSCENIUM_REMOTE_OUTPUT, or the first output. */
    char wanted[64];
    /* The streamed output, and the one tapped, which differ while it changes. */
    struct output *output, *tapped;
    /* The stream's size for the output now. */
    int width, height;
    /* Pixels for the next frame pushed; the stream trades them for a buffer of the same size. */
    uint8_t *pixels;
    size_t pixels_size;
    /* The fallback: a change to read back from the display list, and when the last was. */
    bool dirty;
    double submitted_at;
    struct display_targets targets;
    struct tap tap;
    struct wlr_pointer pointer;
    struct wlr_keyboard keyboard;
    bool buttons[BUTTON_COUNT];
    bool keys[KEY_COUNT];
    /* The swipe or pinch a viewer is making, so one that leaves can be cancelled. */
    enum stream_event_type gesture;
    bool gesturing;
    char cursor[32];
};

static const struct wlr_pointer_impl pointer_impl = {.name = "proscenium-remote-pointer"};
static const struct wlr_keyboard_impl keyboard_impl = {.name = "proscenium-remote-keyboard"};

static uint32_t time_msec(void) {
    return (uint32_t)(int64_t)(now_seconds() * 1000);
}

/* The tap, on the thread that draws. */

static bool has_gles3(void) {
    const char *version = (const char *)glGetString(GL_VERSION);
    int major = 0;
    return version && sscanf(version, "OpenGL ES %d", &major) == 1 && major >= 3;
}

/*
 * The frame, scaled to WIDTH x HEIGHT (multiples of 8 and 4), as I420: the Y plane, then
 * U, then V, rows packed, written four bytes a texel into a WIDTH/4 x HEIGHT*3/2 target,
 * so reading it back gives the encoder's input as is. Limited-range BT.709, chroma
 * averaged over each 2x2 block.
 */
static const char vertex_source[] =
    "#version 300 es\n"
    "void main() {\n"
    "    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
    "    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
    "}\n";

static const char fragment_source[] =
    "#version 300 es\n"
    "precision highp float;\n"
    "precision highp int;\n"
    "uniform sampler2D source;\n"
    "uniform ivec2 size;\n"
    "out vec4 color;\n"
    "const vec3 toY = vec3(0.1826, 0.6142, 0.0620);\n"
    "const vec3 toU = vec3(-0.1006, -0.3386, 0.4392);\n"
    "const vec3 toV = vec3(0.4392, -0.3989, -0.0403);\n"
    "float luma(int x, int y) { return dot(texelFetch(source, ivec2(x, y), 0).rgb, toY) + 16.0 / 255.0; }\n"
    "float chroma(int x, int y, vec3 k) {\n"
    "    ivec2 p = ivec2(2 * x, 2 * y);\n"
    "    vec3 c = texelFetch(source, p, 0).rgb + texelFetch(source, p + ivec2(1, 0), 0).rgb +\n"
    "             texelFetch(source, p + ivec2(0, 1), 0).rgb + texelFetch(source, p + ivec2(1, 1), 0).rgb;\n"
    "    return dot(c * 0.25, k) + 128.0 / 255.0;\n"
    "}\n"
    "void main() {\n"
    "    ivec2 p = ivec2(gl_FragCoord.xy);\n"
    "    int w = size.x, h = size.y;\n"
    "    if (p.y < h) {\n"
    "        int x = p.x * 4;\n"
    "        color = vec4(luma(x, p.y), luma(x + 1, p.y), luma(x + 2, p.y), luma(x + 3, p.y));\n"
    "        return;\n"
    "    }\n"
    "    int quarter = h / 4;\n"
    "    int plane = (p.y - h) / quarter;\n"
    "    int r = p.y - h - plane * quarter;\n"
    "    bool v = plane > 0;\n"
    "    int span = w / 8;\n"
    "    int row = 2 * r + (p.x >= span ? 1 : 0);\n"
    "    int x = (p.x % span) * 4;\n"
    /* An arithmetic select: some drivers (virgl) miscompile a ternary between constants. */
    "    vec3 k = mix(toU, toV, float(v));\n"
    "    color = vec4(chroma(x, row, k), chroma(x + 1, row, k), chroma(x + 2, row, k),\n"
    "                 chroma(x + 3, row, k));\n"
    "}\n";

static GLuint compile(GLenum type, const char *source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[512] = "";
        glGetShaderInfoLog(shader, sizeof log, NULL, log);
        wlr_log(WLR_ERROR, "remote: the I420 shader does not build: %s", log);
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

static bool build_program(struct tap *tap) {
    if (tap->program) return true;
    if (tap->shader_failed) return false;
    GLuint vertex = compile(GL_VERTEX_SHADER, vertex_source);
    GLuint fragment = vertex ? compile(GL_FRAGMENT_SHADER, fragment_source) : 0;
    if (fragment) {
        GLuint program = glCreateProgram();
        glAttachShader(program, vertex);
        glAttachShader(program, fragment);
        glLinkProgram(program);
        GLint ok = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &ok);
        if (ok) {
            tap->program = program;
            tap->source_uniform = glGetUniformLocation(program, "source");
            tap->size_uniform = glGetUniformLocation(program, "size");
            glGenVertexArrays(1, &tap->vao);
        } else {
            wlr_log(WLR_ERROR, "remote: the I420 shader does not link");
            glDeleteProgram(program);
        }
    }
    if (vertex) glDeleteShader(vertex);
    if (fragment) glDeleteShader(fragment);
    tap->shader_failed = !tap->program;
    if (tap->shader_failed) wlr_log(WLR_INFO, "remote: converting frames on the CPU instead");
    return tap->program;
}

static struct render_target *fitted(struct render_target **slot, int width, int height) {
    if (*slot && (*slot)->width == width && (*slot)->height == height) return *slot;
    render_target_destroy(*slot);
    *slot = render_target_create(width, height, false);
    if (*slot) {
        glBindTexture(GL_TEXTURE_2D, (*slot)->texture);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glBindTexture(GL_TEXTURE_2D, 0);
    }
    return *slot;
}

/* Draw TAP's target into its I420 planes, leaving the renderer's state as it was. */
static bool convert(struct tap *tap, int width, int height) {
    if (!build_program(tap) || !fitted(&tap->planes, width / 4, height * 3 / 2)) return false;
    GLint program, vao, active, texture, sampler;
    glGetIntegerv(GL_CURRENT_PROGRAM, &program);
    glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
    glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
    glActiveTexture(GL_TEXTURE0);
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
    glGetIntegerv(GL_SAMPLER_BINDING, &sampler);
    GLboolean blend = glIsEnabled(GL_BLEND), scissor = glIsEnabled(GL_SCISSOR_TEST),
              depth = glIsEnabled(GL_DEPTH_TEST), cull = glIsEnabled(GL_CULL_FACE);
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glBindFramebuffer(GL_FRAMEBUFFER, tap->planes->framebuffer);
    glViewport(0, 0, width / 4, height * 3 / 2);
    glUseProgram(tap->program);
    glBindVertexArray(tap->vao);
    glBindSampler(0, 0);
    glBindTexture(GL_TEXTURE_2D, tap->target->texture);
    glUniform1i(tap->source_uniform, 0);
    glUniform2i(tap->size_uniform, width, height);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindTexture(GL_TEXTURE_2D, (GLuint)texture);
    glBindSampler(0, (GLuint)sampler);
    glActiveTexture((GLenum)active);
    glBindVertexArray((GLuint)vao);
    glUseProgram((GLuint)program);
    if (blend) glEnable(GL_BLEND);
    if (scissor) glEnable(GL_SCISSOR_TEST);
    if (depth) glEnable(GL_DEPTH_TEST);
    if (cull) glEnable(GL_CULL_FACE);
    return true;
}

/* Scale the frame in FRAMEBUFFER, convert it where the GPU can, and start reading it into SLOT. */
static bool fill_slot(struct tap *tap, struct slot *slot, GLuint framebuffer, int buffer_width,
                      int buffer_height, int width, int height, enum stream_format *format) {
    if (!fitted(&tap->target, width, height)) return false;
    struct gl_binding saved;
    gl_save_binding(&saved);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, tap->target->framebuffer);
    glBlitFramebuffer(0, 0, buffer_width, buffer_height, 0, 0, width, height, GL_COLOR_BUFFER_BIT,
                      GL_LINEAR);
    *format = convert(tap, width, height) ? STREAM_I420 : STREAM_RGBA;
    struct render_target *read = *format == STREAM_I420 ? tap->planes : tap->target;
    glBindFramebuffer(GL_FRAMEBUFFER, read->framebuffer);
    size_t size = stream_frame_size(*format, width, height);
    if (!slot->buffer) glGenBuffers(1, &slot->buffer);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, slot->buffer);
    if (slot->capacity != size) {
        glBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)size, NULL, GL_STREAM_READ);
        slot->capacity = size;
    }
    GLint alignment = 4;
    glGetIntegerv(GL_PACK_ALIGNMENT, &alignment);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, read->width, read->height, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glPixelStorei(GL_PACK_ALIGNMENT, alignment);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    slot->fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    /* The compositor's context waits on the fence: it must reach the GPU. */
    glFlush();
    gl_restore_binding(&saved);
    return slot->fence != NULL;
}

static void tap_frame(unsigned int framebuffer, int buffer_width, int buffer_height, void *data) {
    struct tap *tap = data;
    if (!tap->checked) {
        tap->checked = true;
        if (!has_gles3()) {
            pthread_mutex_lock(&tap->lock);
            tap->unsupported = true;
            pthread_mutex_unlock(&tap->lock);
            wlr_log(WLR_INFO, "remote: no GLES 3; frames are read back from the display list");
        }
    }
    double now = now_seconds();
    pthread_mutex_lock(&tap->lock);
    struct slot *slot = NULL;
    /* A little early is fine: frames come on the refresh, which jitters around the interval. */
    if (tap->enabled && !tap->unsupported && now - tap->last >= tap->interval * 0.75) {
        for (int i = 0; i < SLOTS && !slot; i++) {
            if (tap->slots[i].state == SLOT_FREE) slot = &tap->slots[i];
        }
    }
    if (!slot) {
        tap->missed = tap->enabled;
        pthread_mutex_unlock(&tap->lock);
        return;
    }
    slot->state = SLOT_FILLING;
    int width = tap->width, height = tap->height;
    pthread_mutex_unlock(&tap->lock);

    enum stream_format format = STREAM_RGBA;
    bool filled = fill_slot(tap, slot, framebuffer, buffer_width, buffer_height, width, height,
                            &format);
    pthread_mutex_lock(&tap->lock);
    if (filled) {
        slot->state = SLOT_FLIGHT;
        slot->width = width;
        slot->height = height;
        slot->format = format;
        slot->sequence = ++tap->sequence;
        tap->last = now;
    } else {
        slot->state = SLOT_FREE;
        tap->missed = true;
    }
    pthread_mutex_unlock(&tap->lock);
}

/* Free the tap's GL objects, on the thread that draws: framebuffers are not shared. */
static void tap_release(void *data) {
    struct tap *tap = data;
    render_target_destroy(tap->target);
    render_target_destroy(tap->planes);
    tap->target = tap->planes = NULL;
    if (tap->program) glDeleteProgram(tap->program);
    if (tap->vao) glDeleteVertexArrays(1, &tap->vao);
    tap->program = tap->vao = 0;
    for (int i = 0; i < SLOTS; i++) {
        struct slot *slot = &tap->slots[i];
        if (slot->fence) glDeleteSync(slot->fence);
        if (slot->buffer) glDeleteBuffers(1, &slot->buffer);
        *slot = (struct slot){0};
    }
}

/* What is streamed. */

static struct output *pick_output(struct remote *remote) {
    struct output *output, *first = NULL;
    wl_list_for_each(output, &remote->server->outputs, link) {
        if (!first) first = output;
        if (remote->wanted[0] && !strcmp(output_name(output), remote->wanted)) return output;
    }
    return first;
}

/* Whether frames come from the tap: GLES 3, and an upright output whose buffer is the picture. */
static bool tapping(struct remote *remote) {
    pthread_mutex_lock(&remote->tap.lock);
    bool unsupported = remote->tap.unsupported;
    pthread_mutex_unlock(&remote->tap.lock);
    return !unsupported && remote->output &&
           remote->output->wlr_output->transform == WL_OUTPUT_TRANSFORM_NORMAL;
}

/* The stream's size for the output: its pixels, fit to the largest stream, even. */
static void measure(struct remote *remote) {
    int width = 0, height = 0;
    if (remote->output) {
        struct wlr_output *wlr_output = remote->output->wlr_output;
        fit_size(wlr_output->width, wlr_output->height, REMOTE_WIDTH, REMOTE_HEIGHT, &width, &height);
        if (wlr_output->transform & WL_OUTPUT_TRANSFORM_90) {
            int swap = width;
            width = height;
            height = swap;
        }
    }
    /* I420 planes pack four bytes a texel and two chroma rows a texel row. */
    remote->width = MAX(8, width & ~7);
    remote->height = MAX(4, height & ~3);
}

static void release_targets(struct remote *remote) {
    if ((remote->targets.full || remote->targets.scaled) && server_gl_current(remote->server))
        display_release_targets(remote->server, &remote->targets);
    remote->targets = (struct display_targets){0};
}

static void schedule(struct remote *remote);

/* Have the output draw again, whole, so the tap sees what it shows now. */
static void redraw(struct remote *remote) {
    if (!remote->output) return;
    display_damage_whole(remote->output);
    output_request_frame(remote->output);
}

/* Tap the streamed output while someone watches; nothing otherwise. */
static void update_tap(struct remote *remote) {
    struct output *want = remote->viewers > 0 ? remote->output : NULL;
    if (want != remote->tapped) {
        if (remote->tapped) display_set_tap(remote->tapped, NULL, NULL);
        if (want) display_set_tap(want, tap_frame, &remote->tap);
        remote->tapped = want;
    }
    measure(remote);
    pthread_mutex_lock(&remote->tap.lock);
    remote->tap.enabled = want != NULL;
    remote->tap.width = remote->width;
    remote->tap.height = remote->height;
    pthread_mutex_unlock(&remote->tap.lock);
}

/* Follow the output to stream, and the pointer onto it. */
static void retarget(struct remote *remote) {
    struct output *output = pick_output(remote);
    if (output == remote->output) return;
    release_targets(remote);
    remote->output = output;
    remote->dirty = true;
    wlr_cursor_map_input_to_output(remote->server->cursor, &remote->pointer.base,
                                   output ? output->wlr_output : NULL);
    update_tap(remote);
    redraw(remote);
    if (output) wlr_log(WLR_INFO, "remote: streaming output %s", output_name(output));
}

static uint8_t *frame_buffer(struct remote *remote, size_t size) {
    if (remote->pixels_size != size) {
        free(remote->pixels);
        remote->pixels = xmalloc(size);
        remote->pixels_size = size;
    }
    return remote->pixels;
}

/* Push the oldest finished readback; whether any is still on its way. */
static bool collect(struct remote *remote) {
    struct tap *tap = &remote->tap;
    if (!server_gl_current(remote->server)) return false;
    for (;;) {
        pthread_mutex_lock(&tap->lock);
        struct slot *oldest = NULL;
        for (int i = 0; i < SLOTS; i++) {
            struct slot *slot = &tap->slots[i];
            if (slot->state == SLOT_FLIGHT && (!oldest || slot->sequence < oldest->sequence))
                oldest = slot;
        }
        bool filling = false;
        for (int i = 0; i < SLOTS; i++) filling = filling || tap->slots[i].state == SLOT_FILLING;
        pthread_mutex_unlock(&tap->lock);
        if (!oldest) return filling;
        /* Slots in flight are the compositor's until freed: the tap takes only free ones. */
        GLenum status = glClientWaitSync(oldest->fence, 0, 0);
        if (status == GL_TIMEOUT_EXPIRED) return true;
        if (status != GL_WAIT_FAILED) {
            glBindBuffer(GL_PIXEL_PACK_BUFFER, oldest->buffer);
            size_t size = stream_frame_size(oldest->format, oldest->width, oldest->height);
            const void *mapped =
                glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, (GLsizeiptr)size, GL_MAP_READ_BIT);
            if (mapped && remote->viewers > 0) {
                memcpy(frame_buffer(remote, size), mapped, size);
                stream_push_frame(remote->stream, &remote->pixels, oldest->format, oldest->width,
                                  oldest->height);
            }
            if (mapped) glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
            glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        }
        glDeleteSync(oldest->fence);
        pthread_mutex_lock(&tap->lock);
        oldest->fence = NULL;
        oldest->state = SLOT_FREE;
        pthread_mutex_unlock(&tap->lock);
    }
}

/* The fallback: read the output back from the display list, which draws it again. */
static bool read_back(struct remote *remote) {
    struct server *server = remote->server;
    struct capture_source source = {.output = remote->output};
    uint8_t *pixels =
        frame_buffer(remote, stream_frame_size(STREAM_RGBA, remote->width, remote->height));
    if (!server_gl_current(server) ||
        !capture_read(server, &source, (struct box){0}, remote->width, remote->height, pixels,
                      &remote->targets))
        return false;
    stream_push_frame(remote->stream, &remote->pixels, STREAM_RGBA, remote->width, remote->height);
    return true;
}

static int tick(void *data) {
    struct remote *remote = data;
    double time = now_seconds();
    if (remote->viewers > 0 && remote->output && !tapping(remote) && remote->dirty &&
        remote->submitted_at + remote->interval <= time) {
        measure(remote);
        if (!read_back(remote))
            wlr_log(WLR_ERROR, "remote: cannot read output %s back", output_name(remote->output));
        remote->dirty = false;
        remote->submitted_at = time;
    }
    /* A change the tap skipped, coming too soon after the last, is drawn again once due. */
    if (remote->viewers > 0 && tapping(remote)) {
        pthread_mutex_lock(&remote->tap.lock);
        bool missed = remote->tap.missed && time - remote->tap.last >= remote->tap.interval;
        if (missed) remote->tap.missed = false;
        pthread_mutex_unlock(&remote->tap.lock);
        if (missed) redraw(remote);
    }
    schedule(remote);
    return 0;
}

static void schedule(struct remote *remote) {
    int delay = 0;
    if (remote->viewers > 0 && remote->output) {
        if (tapping(remote)) {
            pthread_mutex_lock(&remote->tap.lock);
            bool missed = remote->tap.missed;
            double due = remote->tap.last + remote->tap.interval;
            pthread_mutex_unlock(&remote->tap.lock);
            if (missed) delay = MAX(1, (int)ceil(1000 * (due - now_seconds())));
        } else if (remote->dirty) {
            delay = MAX(1, (int)ceil(1000 * (remote->submitted_at + remote->interval -
                                              now_seconds())));
        }
    }
    wl_event_source_timer_update(remote->timer, delay);
}

static int collect_tick(void *data) {
    struct remote *remote = data;
    if (collect(remote)) wl_event_source_timer_update(remote->collector, COLLECT_MS);
    schedule(remote);
    return 0;
}

void remote_output_presented(struct server *server, struct output *output,
                             const pixman_region32_t *damage) {
    struct remote *remote = server->remote;
    if (!remote || output != remote->output || remote->viewers == 0) return;
    /* What the tap took of this frame is on its way back. */
    if (tapping(remote)) {
        if (collect(remote)) wl_event_source_timer_update(remote->collector, COLLECT_MS);
        schedule(remote);
        return;
    }
    if (remote->dirty || !pixman_region32_not_empty((pixman_region32_t *)damage)) return;
    remote->dirty = true;
    schedule(remote);
}

void remote_output_added(struct server *server) {
    if (server->remote) retarget(server->remote);
}

void remote_output_removed(struct server *server, struct output *output) {
    struct remote *remote = server->remote;
    if (!remote) return;
    if (remote->tapped == output) {
        display_set_tap(output, NULL, NULL);
        remote->tapped = NULL;
    }
    if (remote->output != output) return;
    release_targets(remote);
    /* Another output, if any is left once this one is gone. */
    struct output *next, *other = NULL;
    wl_list_for_each(next, &server->outputs, link) {
        if (next != output && !other) other = next;
    }
    remote->output = other;
    wlr_cursor_map_input_to_output(server->cursor, &remote->pointer.base,
                                   other ? other->wlr_output : NULL);
    remote->dirty = true;
    update_tap(remote);
    redraw(remote);
    schedule(remote);
}

void remote_cursor(struct server *server, const char *name) {
    struct remote *remote = server->remote;
    if (!remote || !strcmp(remote->cursor, name)) return;
    snprintf(remote->cursor, sizeof remote->cursor, "%s", name);
    stream_set_cursor(remote->stream, name);
}

/* Input. */

static void pointer_frame(struct remote *remote) {
    wl_signal_emit_mutable(&remote->pointer.events.frame, &remote->pointer);
}

static void button(struct remote *remote, uint32_t code, bool pressed) {
    uint32_t index = code - BUTTON_BASE;
    if (index >= BUTTON_COUNT || remote->buttons[index] == pressed) return;
    remote->buttons[index] = pressed;
    struct wlr_pointer_button_event event = {
        .pointer = &remote->pointer,
        .time_msec = time_msec(),
        .button = code,
        .state = pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED,
    };
    wlr_pointer_notify_button(&remote->pointer, &event);
    pointer_frame(remote);
}

static void key(struct remote *remote, uint32_t code, bool pressed) {
    if (code >= KEY_COUNT || remote->keys[code] == pressed) return;
    remote->keys[code] = pressed;
    struct wlr_keyboard_key_event event = {
        .time_msec = time_msec(),
        .keycode = code,
        .update_state = true,
        .state = pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED,
    };
    wlr_keyboard_notify_key(&remote->keyboard, &event);
}

static void scroll_axis(struct remote *remote, enum wl_pointer_axis orientation, double amount,
                        bool discrete) {
    if (amount == 0) return;
    struct wlr_pointer_axis_event event = {
        .pointer = &remote->pointer,
        .time_msec = time_msec(),
        .source = discrete ? WL_POINTER_AXIS_SOURCE_WHEEL : WL_POINTER_AXIS_SOURCE_FINGER,
        .orientation = orientation,
        .relative_direction = WL_POINTER_AXIS_RELATIVE_DIRECTION_IDENTICAL,
        .delta = discrete ? amount * NOTCH : amount,
        /* In 120ths of a notch. */
        .delta_discrete = discrete ? (int32_t)lround(amount * 120) : 0,
    };
    wl_signal_emit_mutable(&remote->pointer.events.axis, &event);
}

/* A swipe or pinch from a viewer's touchpad or touchscreen, played as a touchpad's. */
static void gesture(struct remote *remote, const struct stream_event *event) {
    struct wlr_pointer *pointer = &remote->pointer;
    uint32_t time = time_msec();
    bool swipe = event->type == STREAM_EVENT_SWIPE;
    if (event->phase == STREAM_BEGIN) {
        /* A new gesture cancels one left open. */
        if (remote->gesturing) {
            struct stream_event cancel = {.type = remote->gesture, .phase = STREAM_CANCEL};
            gesture(remote, &cancel);
        }
        remote->gesturing = true;
        remote->gesture = event->type;
        if (swipe) {
            struct wlr_pointer_swipe_begin_event begin = {pointer, time, event->fingers};
            wl_signal_emit_mutable(&pointer->events.swipe_begin, &begin);
        } else {
            struct wlr_pointer_pinch_begin_event begin = {pointer, time, event->fingers};
            wl_signal_emit_mutable(&pointer->events.pinch_begin, &begin);
        }
        return;
    }
    if (!remote->gesturing || remote->gesture != event->type) return;
    if (event->phase == STREAM_UPDATE) {
        if (swipe) {
            struct wlr_pointer_swipe_update_event update = {pointer, time, event->fingers,
                                                            event->dx, event->dy};
            wl_signal_emit_mutable(&pointer->events.swipe_update, &update);
        } else {
            struct wlr_pointer_pinch_update_event update = {
                pointer, time, event->fingers, event->dx, event->dy, event->scale, event->rotation};
            wl_signal_emit_mutable(&pointer->events.pinch_update, &update);
        }
        return;
    }
    remote->gesturing = false;
    bool cancelled = event->phase == STREAM_CANCEL;
    if (swipe) {
        struct wlr_pointer_swipe_end_event end = {pointer, time, cancelled};
        wl_signal_emit_mutable(&pointer->events.swipe_end, &end);
    } else {
        struct wlr_pointer_pinch_end_event end = {pointer, time, cancelled};
        wl_signal_emit_mutable(&pointer->events.pinch_end, &end);
    }
}

static void release_all(struct remote *remote) {
    if (remote->gesturing) {
        struct stream_event cancel = {.type = remote->gesture, .phase = STREAM_CANCEL};
        gesture(remote, &cancel);
    }
    for (uint32_t i = 0; i < BUTTON_COUNT; i++) button(remote, BUTTON_BASE + i, false);
    for (uint32_t i = 0; i < KEY_COUNT; i++) key(remote, i, false);
}

static void play(struct remote *remote, const struct stream_event *event) {
    switch (event->type) {
    case STREAM_EVENT_VIEWERS: {
        bool joined = event->viewers > remote->viewers;
        remote->viewers = event->viewers;
        update_tap(remote);
        /* Someone new sees the output as it is now, still or not. */
        if (joined) {
            remote->dirty = true;
            remote->submitted_at = 0;
            redraw(remote);
        }
        if (remote->viewers == 0) release_targets(remote);
        break;
    }
    case STREAM_EVENT_MOTION: {
        if (!remote->output) break;
        struct wlr_pointer_motion_absolute_event motion = {
            .pointer = &remote->pointer,
            .time_msec = time_msec(),
            .x = event->x,
            .y = event->y,
        };
        wl_signal_emit_mutable(&remote->pointer.events.motion_absolute, &motion);
        pointer_frame(remote);
        break;
    }
    case STREAM_EVENT_BUTTON: button(remote, event->code, event->pressed); break;
    case STREAM_EVENT_SCROLL:
        scroll_axis(remote, WL_POINTER_AXIS_VERTICAL_SCROLL, event->dy, event->discrete);
        scroll_axis(remote, WL_POINTER_AXIS_HORIZONTAL_SCROLL, event->dx, event->discrete);
        pointer_frame(remote);
        break;
    case STREAM_EVENT_KEY: key(remote, event->code, event->pressed); break;
    case STREAM_EVENT_RELEASE: release_all(remote); break;
    case STREAM_EVENT_SWIPE:
    case STREAM_EVENT_PINCH: gesture(remote, event); break;
    }
}

static int handle_events(int fd, uint32_t mask, void *data) {
    struct remote *remote = data;
    struct stream_event event;
    while (stream_next_event(remote->stream, &event)) play(remote, &event);
    schedule(remote);
    return 0;
}

static int env_int(const char *name, int fallback) {
    const char *value = getenv(name);
    return value && *value ? atoi(value) : fallback;
}

void remote_init(struct server *server, const char *listen) {
    /* PORT, or ADDRESS:PORT; an IPv6 address goes in brackets. */
    char address[256] = "";
    const char *colon = strrchr(listen, ':');
    int port = atoi(colon ? colon + 1 : listen);
    if (colon) {
        const char *start = listen, *end = colon;
        if (*start == '[' && end > start && end[-1] == ']') {
            start++;
            end--;
        }
        snprintf(address, sizeof address, "%.*s",
                 (int)MIN((size_t)(end - start), sizeof address - 1), start);
    }
    if (port <= 0 || port > 65535) {
        wlr_log(WLR_ERROR, "remote: %s names no port; remote access is off", listen);
        return;
    }
    int fps = CLAMP(env_int("PROSCENIUM_REMOTE_FPS", 60), 1, 240);
    struct stream_options options = {
        .address = address,
        .port = port,
        .bitrate = env_int("PROSCENIUM_REMOTE_BITRATE", 0),
        .fps = fps,
    };
    struct stream *stream = stream_create(&options);
    if (!stream) {
        wlr_log(WLR_ERROR, "remote access is unavailable");
        return;
    }
    struct remote *remote = xcalloc(1, sizeof *remote);
    remote->server = server;
    remote->stream = stream;
    remote->interval = 1.0 / fps;
    pthread_mutex_init(&remote->tap.lock, NULL);
    remote->tap.interval = remote->interval;
    remote->tap.last = -INFINITY;
    const char *wanted = getenv("PROSCENIUM_REMOTE_OUTPUT");
    if (wanted) snprintf(remote->wanted, sizeof remote->wanted, "%s", wanted);
    remote->readable = wl_event_loop_add_fd(server->loop, stream_get_fd(stream), WL_EVENT_READABLE,
                                            handle_events, remote);
    remote->timer = wl_event_loop_add_timer(server->loop, tick, remote);
    remote->collector = wl_event_loop_add_timer(server->loop, collect_tick, remote);
    wlr_pointer_init(&remote->pointer, &pointer_impl, pointer_impl.name);
    wlr_keyboard_init(&remote->keyboard, &keyboard_impl, keyboard_impl.name);
    server->remote = remote;
    input_add_device(server, &remote->pointer.base);
    input_add_device(server, &remote->keyboard.base);
    retarget(remote);
    wlr_log(WLR_INFO, "remote: viewers on this machine open %s", stream_local_url(stream));
}

void remote_finish(struct server *server) {
    struct remote *remote = server->remote;
    if (!remote) return;
    if (remote->tapped) display_set_tap(remote->tapped, NULL, NULL);
    wl_event_source_remove(remote->readable);
    wl_event_source_remove(remote->timer);
    wl_event_source_remove(remote->collector);
    /* Their destroy signals detach them from the cursor and the seat. */
    wlr_keyboard_finish(&remote->keyboard);
    wlr_pointer_finish(&remote->pointer);
    stream_destroy(remote->stream);
    release_targets(remote);
    if (server_gl_current(server)) server_render(server, tap_release, &remote->tap);
    pthread_mutex_destroy(&remote->tap.lock);
    free(remote->pixels);
    free(remote);
    server->remote = NULL;
}
