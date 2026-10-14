/*
 * Smoke test of web pages without a compositor: the helper renders a small page
 * offscreen, its frames become GL textures in a surfaceless GBM EGL context, and
 * reading them back checks their pixels, along with the load, message, props,
 * pointer, keyboard and raster scale round trips, the helper pausing while no
 * page is visible, and its exit after the last page.
 *
 * Without a Wayland display the helper paints bitmaps, so the bitmap pass always
 * runs. The helper wants a display only for GPU frames, as a Wayland client of
 * it, so the dma-buf pass runs when WAYLAND_DISPLAY names one (any compositor).
 *
 * Chromium's sandbox needs user namespaces, which Ubuntu grants per executable
 * through AppArmor; the test loads only its own page, so it runs the helper with
 * --no-sandbox rather than requiring that setup.
 *
 *   test-web [HELPER]   HELPER defaults to build/web/proscenium-web-helper
 *
 * Exits 77, skipped, without a helper or a GPU.
 */
#define _GNU_SOURCE
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <dirent.h>
#include <fcntl.h>
#include <ftw.h>
#include <gbm.h>
#include <limits.h>
#include <linux/input-event-codes.h>
#include <signal.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wayland-server-core.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon-keysyms.h>

#include "util.h"
#include "web.h"

#define SKIP 77

static const char page_html[] =
    "<!doctype html>\n"
    "<html><head><meta charset=\"utf-8\">\n"
    "<style>html,body{margin:0;height:100%;background:#ff0000}\n"
    "input{position:absolute;left:0;top:0;width:10px;height:10px;border:0;padding:0;\n"
    "outline:none;background:transparent}</style></head>\n"
    "<body><input id=field><script>\n"
    "const send = (name, value) => proscenium.postMessage('stage', {name, value});\n"
    "addEventListener('proscenium-message', (event) => {\n"
    "  if (event.detail.name !== 'props') return;\n"
    "  document.body.style.background = event.detail.value.color;\n"
    "  if (event.detail.value.tag) mark(event.detail.value.tag);\n"
    "  send('props', {...event.detail.value, ratio: devicePixelRatio, width: innerWidth});\n"
    "});\n"
    "addEventListener('mousedown', (e) => send('click', [e.clientX, e.clientY, e.button]));\n"
    "function mark(tag) {\n"
    "  const digits = [(tag >> 8) & 15, (tag >> 4) & 15, tag & 15];\n"
    "  [digits, digits.map((d) => 15 - d)].forEach((values, i) => {\n"
    "    const cell = document.getElementById('cell' + i) || document.body.appendChild(\n"
    "      Object.assign(document.createElement('div'), {id: 'cell' + i}));\n"
    "    cell.style.cssText = `position:fixed;left:${2 * i}px;top:0;width:2px;height:2px;` +\n"
    "      `background:rgb(${values.map((d) => d * 16 + 8).join(',')})`;\n"
    "  });\n"
    "}\n"
    "addEventListener('keydown', (e) => send('key', e.key));\n"
    "field.addEventListener('input', () => send('input', field.value));\n"
    "send('ready', null);\n"
    "</script></body></html>\n";

struct gpu {
    int fd;
    struct gbm_device *gbm;
    EGLDisplay display;
    EGLContext context;
    GLuint framebuffer;
};

struct test {
    struct wl_event_loop *loop;
    struct web *web;
    struct web_page *page;
    struct gpu *gpu;
    int frames, loads, errors;
    struct strbuf messages;
    /* The last pixel read at the page's centre, and its texture's size. */
    uint8_t pixel[4];
    int texture_width, texture_height;
    bool damaged;
    struct box damage;
};

static int failures;

#define CHECK(condition, ...)                                                                      \
    do {                                                                                           \
        bool ok_ = (condition);                                                                    \
        printf("  %s: ", ok_ ? "ok" : "FAIL");                                                     \
        printf(__VA_ARGS__);                                                                       \
        printf("\n");                                                                              \
        fflush(stdout);                                                                            \
        if (!ok_) failures++;                                                                      \
    } while (0)

/* Run the event loop until CONDITION holds or SECONDS pass; the condition's last value. */
#define WAIT(t, condition, seconds)                                                                \
    ({                                                                                             \
        double deadline_ = now_seconds() + (seconds);                                              \
        while (!(condition) && now_seconds() < deadline_) wl_event_loop_dispatch((t)->loop, 50);   \
        (condition);                                                                               \
    })

static void on_frame(struct web_page *page, void *data) {
    struct test *t = data;
    t->frames++;
}

static void on_load(struct web_page *page, int status, void *data) {
    struct test *t = data;
    t->loads++;
    printf("  load, status %d\n", status);
}

static void on_error(struct web_page *page, const char *message, void *data) {
    struct test *t = data;
    t->errors++;
    printf("  error: %s\n", message);
}

static void on_message(struct web_page *page, const char *payload, void *data) {
    struct test *t = data;
    strbuf_puts(&t->messages, payload);
    strbuf_putc(&t->messages, '\n');
}

static const struct web_page_listener listener = {
    .frame = on_frame,
    .load = on_load,
    .error = on_error,
    .message = on_message,
};

static bool said(struct test *t, const char *text) {
    return t->messages.data && strstr(t->messages.data, text);
}

static bool gpu_init(struct gpu *gpu) {
    *gpu = (struct gpu){.fd = -1};
    DIR *dri = opendir("/dev/dri");
    struct dirent *entry;
    char path[PATH_MAX] = "";
    while (dri && (entry = readdir(dri))) {
        if (!strncmp(entry->d_name, "renderD", 7)) {
            snprintf(path, sizeof path, "/dev/dri/%s", entry->d_name);
            break;
        }
    }
    if (dri) closedir(dri);
    gpu->fd = *path ? open(path, O_RDWR | O_CLOEXEC) : -1;
    if (gpu->fd < 0) return false;
    gpu->gbm = gbm_create_device(gpu->fd);
    if (!gpu->gbm) return false;
    PFNEGLGETPLATFORMDISPLAYEXTPROC platform_display =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    gpu->display = platform_display(EGL_PLATFORM_GBM_KHR, gpu->gbm, NULL);
    if (!gpu->display || !eglInitialize(gpu->display, NULL, NULL)) return false;
    eglBindAPI(EGL_OPENGL_ES_API);
    const EGLint attributes[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE};
    gpu->context = eglCreateContext(gpu->display, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attributes);
    if (!gpu->context ||
        !eglMakeCurrent(gpu->display, EGL_NO_SURFACE, EGL_NO_SURFACE, gpu->context))
        return false;
    glGenFramebuffers(1, &gpu->framebuffer);
    printf("GPU: %s on %s\n", glGetString(GL_RENDERER), path);
    return true;
}

static void gpu_finish(struct gpu *gpu) {
    if (gpu->context) {
        glDeleteFramebuffers(1, &gpu->framebuffer);
        eglMakeCurrent(gpu->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        eglDestroyContext(gpu->display, gpu->context);
    }
    if (gpu->display) eglTerminate(gpu->display);
    if (gpu->gbm) gbm_device_destroy(gpu->gbm);
    if (gpu->fd >= 0) close(gpu->fd);
}

/* Take the page's newest frame and read its centre pixel; false before any frame. */
static bool read_page(struct test *t) {
    struct box damage;
    if (web_page_prepare(t->page, &damage)) {
        t->damage = t->damaged ? box_union(t->damage, damage) : damage;
        t->damaged = true;
    }
    struct web_surface surfaces[2];
    if (web_page_surfaces(t->page, surfaces) < 1) return false;
    t->texture_width = surfaces[0].texture_width;
    t->texture_height = surfaces[0].texture_height;
    glBindFramebuffer(GL_FRAMEBUFFER, t->gpu->framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, surfaces[0].texture,
                           0);
    bool complete = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    if (complete)
        glReadPixels(t->texture_width / 2, t->texture_height / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE,
                     t->pixel);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    return complete;
}

/* The alpha of the newest frame's pixel at (X, Y), from its top left; -1 before a frame. */
static int alpha_at(struct test *t, int x, int y) {
    struct web_surface surfaces[2];
    if (web_page_surfaces(t->page, surfaces) < 1) return -1;
    glBindFramebuffer(GL_FRAMEBUFFER, t->gpu->framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, surfaces[0].texture,
                           0);
    uint8_t pixel[4] = {0};
    glReadPixels(x, y, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    return pixel[3];
}

static bool shows(struct test *t, uint8_t r, uint8_t g, uint8_t b) {
    return read_page(t) && abs(t->pixel[0] - r) <= 2 && abs(t->pixel[1] - g) <= 2 &&
           abs(t->pixel[2] - b) <= 2 && t->pixel[3] == 255;
}

static bool sized(struct test *t, int width, int height) {
    return read_page(t) && t->texture_width == width && t->texture_height == height;
}

/* The state letter of process PID: 'T' while stopped; 0 once gone. */
static char process_state(int pid) {
    char path[64], line[512];
    snprintf(path, sizeof path, "/proc/%d/stat", pid);
    FILE *file = fopen(path, "r");
    if (!file) return 0;
    char state = 0;
    if (fgets(line, sizeof line, file)) {
        char *end = strrchr(line, ')');
        if (end && end[1] == ' ') state = end[2];
    }
    fclose(file);
    return state;
}

static void pause_loop(struct test *t, double seconds) {
    WAIT(t, false, seconds);
}

static void run(struct gpu *gpu, const char *helper, const char *display, const char *src) {
    printf("%s frames%s%s\n", display ? "dma-buf" : "bitmap", display ? " through " : "",
           display ? display : "");
    int failures_before = failures;
    struct test t = {.gpu = gpu};
    strbuf_init(&t.messages);
    t.loop = wl_event_loop_create();
    t.web = web_create(t.loop, helper, display);
    t.page = web_page_create(t.web, &(struct web_page_options){
                                        .src = src,
                                        .width = 64,
                                        .height = 48,
                                        .scale = 2,
                                        .listener = &listener,
                                        .data = &t,
                                    });
    CHECK(t.page, "page created %s", t.page ? "" : web_error());
    if (!t.page) goto done;
    int pid = web_helper_pid(t.web);
    CHECK(pid > 0, "helper %d started", pid);

    CHECK(WAIT(&t, t.loads > 0 || t.errors > 0, 30) && t.loads == 1, "loaded");
    CHECK(WAIT(&t, said(&t, "{\"name\":\"ready\",\"value\":null}"), 10), "page posted a message");
    CHECK(WAIT(&t, shows(&t, 255, 0, 0), 10), "first frame is red: %d %d %d %d", t.pixel[0],
          t.pixel[1], t.pixel[2], t.pixel[3]);
    CHECK(t.frames > 0, "%d frame callbacks", t.frames);
    CHECK(t.texture_width == 128 && t.texture_height == 96, "rastered at 128x96: %dx%d",
          t.texture_width, t.texture_height);
    CHECK(t.damaged && t.damage.x == 0 && t.damage.y == 0 && t.damage.width == 64 &&
              t.damage.height == 48,
          "damage covers the page: %g %g %g %g", t.damage.x, t.damage.y, t.damage.width,
          t.damage.height);
    CHECK(web_page_dmabuf(t.page) == (display != NULL), "transport is %s",
          web_page_dmabuf(t.page) ? "dma-buf" : "bitmap");

    web_page_set_props(t.page, "{\"color\":\"#0000ff\"}");
    CHECK(WAIT(&t,
               said(&t, "{\"name\":\"props\",\"value\":{\"color\":\"#0000ff\","
                        "\"ratio\":2,\"width\":64}}"),
               10),
          "page received props, laid out 64 CSS pixels wide at device pixel ratio 2");
    CHECK(WAIT(&t, shows(&t, 0, 0, 255), 10), "props turned it blue: %d %d %d %d", t.pixel[0],
          t.pixel[1], t.pixel[2], t.pixel[3]);

    /* The click lands on the text field, focusing it for the keys. */
    web_page_pointer_motion(t.page, 5, 6);
    web_page_pointer_button(t.page, 5, 6, BTN_LEFT, true);
    web_page_pointer_button(t.page, 5, 6, BTN_LEFT, false);
    CHECK(WAIT(&t, said(&t, "{\"name\":\"click\",\"value\":[5,6,0]}"), 10),
          "click at (5, 6) reached the page");

    web_page_focus(t.page, true);
    uint32_t keysym = XKB_KEY_a;
    web_page_key(t.page, KEY_A, &keysym, 1, true, 0);
    web_page_key(t.page, KEY_A, &keysym, 1, false, 0);
    CHECK(WAIT(&t, said(&t, "{\"name\":\"key\",\"value\":\"a\"}"), 10), "key a reached the page");
    CHECK(WAIT(&t, said(&t, "{\"name\":\"input\",\"value\":\"a\"}"), 10), "and typed a");

    /* Another letter changes only the field in the corner, so only it is damaged. */
    WAIT(&t, (read_page(&t), false), 0.5);
    t.damaged = false;
    keysym = XKB_KEY_b;
    web_page_key(t.page, KEY_B, &keysym, 1, true, 0);
    web_page_key(t.page, KEY_B, &keysym, 1, false, 0);
    CHECK(WAIT(&t, said(&t, "{\"name\":\"input\",\"value\":\"ab\"}") && read_page(&t) && t.damaged,
               10),
          "typed b");
    CHECK(t.damage.x + t.damage.width <= 16 && t.damage.y + t.damage.height <= 16,
          "damage covers the field, not the page: %g %g %g %g", t.damage.x, t.damage.y,
          t.damage.width, t.damage.height);

    /* A page that marks its frames with a number: the helper reads it and blanks the mark. */
    if (display) {
        web_page_set_tagged(t.page, true);
        web_page_set_props(t.page, "{\"color\":\"#0000ff\",\"tag\":291}");
        CHECK(WAIT(&t, read_page(&t) && web_page_frame_tag(t.page) == 291, 10),
              "frames carry the page's number: %d", web_page_frame_tag(t.page));
        CHECK(alpha_at(&t, 2, 2) == 0 && alpha_at(&t, 6, 2) == 0 && alpha_at(&t, 10, 10) == 255,
              "the mark is blanked, the page around it kept: %d %d %d", alpha_at(&t, 2, 2),
              alpha_at(&t, 6, 2), alpha_at(&t, 10, 10));
        web_page_set_props(t.page, "{\"color\":\"#0000ff\",\"tag\":4000}");
        CHECK(WAIT(&t, read_page(&t) && web_page_frame_tag(t.page) == 4000, 10),
              "and the next number: %d", web_page_frame_tag(t.page));
    }

    web_page_set_raster_scale(t.page, 1.9);
    CHECK(web_page_raster_scale(t.page) == 2, "small scale changes keep the raster");
    /* Chromium re-rasters a bitmap page at a new scale only when it next paints. */
    web_page_set_raster_scale(t.page, 1);
    if (display)
        CHECK(WAIT(&t, sized(&t, 64, 48), 10), "rastered at 64x48 for scale 1: %dx%d",
              t.texture_width, t.texture_height);

    web_page_set_visible(t.page, false);
    pause_loop(&t, 3.6);
    CHECK(process_state(pid) == 'T', "hidden, the helper paused: state %c",
          process_state(pid) ? process_state(pid) : '?');
    int frames = t.frames;
    web_page_set_visible(t.page, true);
    CHECK(process_state(pid) != 'T', "shown again, it continued");
    CHECK(WAIT(&t, t.frames > frames && shows(&t, 0, 0, 255) && sized(&t, 64, 48), 10),
          "and painted again, at 64x48: %dx%d", t.texture_width, t.texture_height);

    CHECK(t.errors == 0, "no errors");
    web_page_close(t.page);
    CHECK(web_helper_pid(t.web) == 0, "closing the last page stops the helper");
    CHECK(WAIT(&t, kill(pid, 0) < 0, 8), "helper %d exited", pid);

done:
    if (failures > failures_before)
        printf("  messages:\n%s", t.messages.data ? t.messages.data : "");
    web_collect_garbage(t.web);
    web_release_graphics(t.web);
    web_destroy(t.web);
    wl_event_loop_destroy(t.loop);
    strbuf_finish(&t.messages);
}

static int remove_entry(const char *path, const struct stat *st, int type, struct FTW *entry) {
    return remove(path);
}

int main(int argc, char **argv) {
    wlr_log_init(WLR_INFO, NULL);
    char helper[PATH_MAX];
    if (!realpath(argc > 1 ? argv[1] : "build/web/proscenium-web-helper", helper)) {
        printf("skip: no web helper; build it with cmake -S web -B build/web\n");
        return SKIP;
    }
    struct gpu gpu;
    if (!gpu_init(&gpu)) {
        printf("skip: no GPU with GBM, GLES 3 and surfaceless EGL\n");
        gpu_finish(&gpu);
        return SKIP;
    }

    char directory[] = "/tmp/proscenium-test-web-XXXXXX";
    if (!mkdtemp(directory)) return 1;
    char src[PATH_MAX], wrapper[PATH_MAX];
    /* A space in the name tests the file URL's escaping. */
    snprintf(src, sizeof src, "%s/test page.html", directory);
    snprintf(wrapper, sizeof wrapper, "%s/helper", directory);
    FILE *file = fopen(src, "w");
    fputs(page_html, file);
    fclose(file);
    file = fopen(wrapper, "w");
    fprintf(file, "#!/bin/sh\nexec '%s' --no-sandbox \"$@\"\n", helper);
    fclose(file);
    chmod(wrapper, 0755);

    /* The bitmap pass must not find a display in the environment the helper inherits. */
    const char *display = getenv("WAYLAND_DISPLAY");
    char *saved = display && *display ? xstrdup(display) : NULL;
    unsetenv("WAYLAND_DISPLAY");
    run(&gpu, wrapper, NULL, src);
    if (saved) run(&gpu, wrapper, saved, src);
    else printf("dma-buf frames: skipped, WAYLAND_DISPLAY names no display\n");
    free(saved);

    nftw(directory, remove_entry, 8, FTW_DEPTH | FTW_PHYS);
    gpu_finish(&gpu);
    printf("%s\n", failures ? "FAILED" : "passed");
    return failures ? 1 : 0;
}
