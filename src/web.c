#define _GNU_SOURCE
#include "web.h"

#include <ctype.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <sys/eventfd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <wayland-server-core.h>
#include <wlr/types/wlr_keyboard.h>
#include <wlr/util/log.h>
#include <xkbcommon/xkbcommon.h>

#include "dmabuf.h"
#include "json.h"
#include "protocol.h"
#include "util.h"

extern char **environ;

/*
 * How long the helper runs on after its last command while no page is visible,
 * for pages to finish loading and settle.
 */
#define PAUSE_DELAY_MS 3000
#define EXTENT_MAX 8192.0
#define SCALE_MIN 0.5
#define SCALE_MAX 3.0
/* Raster scale changes smaller than this fraction keep the current raster. */
#define SCALE_HYSTERESIS 0.15
/* Pages talk to the director with proscenium.postMessage(MESSAGE_NAME, {name, value}). */
#define MESSAGE_NAME "stage"
/* Files are served under this origin, so modules and fetch() work as on the web. */
#define FILE_ORIGIN "proscenium://ui/"
#define IMPORTS 3

struct frame {
    struct web_buffer buffer;
    int fds[WEB_PLANES];
    /* Signalled once the compositor stops sampling the buffer; -1 for none. */
    int fence;
    bool valid;
    /* The layer's import of the buffer, once made. */
    GLuint texture;
};

/* A buffer of the helper's imported as a texture, kept while the helper reuses it. */
struct import {
    int token, width, height;
    GLuint texture;
    EGLImageKHR image;
    EGLDisplay display;
};

/* The page (layer 0) or its popup (1): the frame drawn, the next one, recent imports. */
struct layer {
    struct frame front, pending;
    struct import imports[IMPORTS];
};

/* One helper process and the pages it serves. */
struct engine {
    struct web *web;
    pid_t pid;
    int socket, wake;
    int next_id, pages;
    /* Stopped with SIGSTOP while no page is visible. */
    bool paused;
    /* The pause timer runs; it fires PAUSE_DELAY_MS after the last command. */
    bool pause_armed;
    double last_command;
    /* The transport broke; handle_failure runs at the next idle. */
    bool failed;
    bool stopped;
    char cache[64];
    struct wl_event_source *wake_source, *socket_source, *pause_timer, *failure_idle;
};

struct web_page {
    struct web *web;
    /* NULL once the helper serving the page stopped. */
    struct engine *engine;
    struct wl_list link;
    struct web_shared *shared;
    int id;
    char *src;
    double width, height, scale, revision;
    bool visible, loaded, failed, closed;
    /* The props declared, and the props the page last received. */
    char *props, *posted;
    const struct web_page_listener *listener;
    void *data;
    /* A failure found while drawing, reported at the next idle. */
    char *failure;
    struct wl_event_source *failure_idle;
    /* Graphics: the bitmap texture, or the dma-buf layers, and the page's texture size. */
    GLuint bitmap;
    int texture_width, texture_height;
    struct layer layers[2];
};

struct web {
    struct wl_event_loop *loop;
    char *helper, *display;
    struct engine *engine;
    struct wl_list pages;
    /* GL objects of closed pages (struct import), deleted at the next GL call. */
    struct vec garbage;
    /* Reused for every command: most of it is text that never travels. */
    struct web_command *command;
    /*
     * While reporting, closed pages and stopped engines stay allocated so the
     * loops reporting to them can tell; they are freed when reporting ends.
     */
    int dispatching;
    struct vec doomed_pages, doomed_engines;
};

static const struct web_page_listener no_listener = {0};
static _Thread_local char error_text[256];

static void set_error(const char *format, ...) __attribute__((format(printf, 1, 2)));
static void set_error(const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(error_text, sizeof error_text, format, arguments);
    va_end(arguments);
}

static void fail(const char *what) {
    set_error("%s: %s", what, strerror(errno));
}

const char *web_error(void) {
    return error_text;
}

/* The helper and its processes. */

static bool engine_send(struct engine *engine, int op, int id, int a, int b, int c, int d,
                        double scale, const char *text, int fd) {
    struct web_command *command = engine->web->command;
    size_t length = text ? strlen(text) : 0;
    if (length >= WEB_TEXT) {
        set_error("A web command exceeds %d bytes", WEB_TEXT - 1);
        return false;
    }
    command->op = op;
    command->id = id;
    command->a = a;
    command->b = b;
    command->c = c;
    command->d = d;
    command->scale = scale;
    memcpy(command->text, text ? text : "", length);
    command->text[length] = '\0';
    if (!web_send(engine->socket, command, fd)) {
        fail("web command queue");
        return false;
    }
    return true;
}

static void begin_dispatch(struct web *web) {
    web->dispatching++;
}

static void end_dispatch(struct web *web) {
    if (--web->dispatching > 0) return;
    VEC_FOR(&web->doomed_pages, struct web_page *, page) free(*page);
    VEC_FOR(&web->doomed_engines, struct engine *, engine) free(*engine);
    vec_clear(&web->doomed_pages);
    vec_clear(&web->doomed_engines);
}

/* The pages ENGINE serves, into PAGES, for loops whose callbacks may close any. */
static void engine_pages(struct engine *engine, struct vec *pages) {
    vec_init(pages, sizeof(struct web_page *));
    struct web_page *page;
    wl_list_for_each(page, &engine->web->pages, link) {
        if (page->engine == engine) *(struct web_page **)vec_push(pages) = page;
    }
}

static bool engine_shows_page(struct engine *engine) {
    struct web_page *page;
    wl_list_for_each(page, &engine->web->pages, link) {
        if (page->engine == engine && page->visible) return true;
    }
    return false;
}

static int handle_pause(void *data) {
    struct engine *engine = data;
    engine->pause_armed = false;
    double left = engine->last_command + PAUSE_DELAY_MS / 1000.0 - now_seconds();
    if (left > 0) {
        wl_event_source_timer_update(engine->pause_timer, MAX(1, (int)ceil(left * 1000)));
        engine->pause_armed = true;
        return 0;
    }
    if (!engine->stopped && !engine->paused && !engine_shows_page(engine)) {
        kill(-engine->pid, SIGSTOP);
        engine->paused = true;
    }
    return 0;
}

/* Continue a paused helper for a command, and pause it again once idle a while. */
static void engine_wake(struct engine *engine) {
    if (engine->paused) {
        kill(-engine->pid, SIGCONT);
        engine->paused = false;
    }
    /* Commands come as fast as pointer motion: the timer is armed once and
     * catches up with the last command when it fires. */
    engine->last_command = now_seconds();
    if (!engine->pause_armed) {
        wl_event_source_timer_update(engine->pause_timer, PAUSE_DELAY_MS);
        engine->pause_armed = true;
    }
}

struct reaper {
    pid_t pid;
    char cache[64];
};

static int remove_entry(const char *path, const struct stat *st, int type, struct FTW *entry) {
    (void)st;
    (void)type;
    (void)entry;
    return remove(path);
}

/* A deadline for a stopped helper to exit, never a wait on the event loop. Its exit
 * status is only informational: at shutdown the display may close before it hears
 * the request to stop, and GTK then exits with status 1. */
static void *reap(void *data) {
    struct reaper *reaper = data;
    struct timespec delay = {.tv_nsec = 50000000};
    bool finished = false;
    for (int n = 0; n < 100; n++) {
        int status = 0;
        pid_t result = waitpid(reaper->pid, &status, WNOHANG);
        if (result == reaper->pid && WIFSIGNALED(status))
            wlr_log(WLR_ERROR, "web: helper %d exited with signal %d", reaper->pid,
                    WTERMSIG(status));
        else if (result == reaper->pid && WIFEXITED(status) && WEXITSTATUS(status))
            wlr_log(WLR_INFO, "web: helper %d exited with status %d", reaper->pid,
                    WEXITSTATUS(status));
        if (result == reaper->pid || (result < 0 && errno != EINTR)) {
            finished = true;
            break;
        }
        if (n == 40) kill(-reaper->pid, SIGTERM);
        nanosleep(&delay, NULL);
    }
    if (!finished) {
        kill(-reaper->pid, SIGKILL);
        while (waitpid(reaper->pid, NULL, 0) < 0 && errno == EINTR) {
        }
    }
    nftw(reaper->cache, remove_entry, 16, FTW_DEPTH | FTW_PHYS);
    free(reaper);
    return NULL;
}

static void remove_source(struct wl_event_source **source) {
    if (*source) wl_event_source_remove(*source);
    *source = NULL;
}

/* Ask the helper to exit and forget it; its pages keep their last frames. */
static void engine_stop(struct engine *engine) {
    if (engine->stopped) return;
    struct web *web = engine->web;
    engine->stopped = true;
    if (web->engine == engine) web->engine = NULL;
    /* A stopped process cannot act on the request to exit. */
    if (engine->paused) kill(-engine->pid, SIGCONT);
    remove_source(&engine->wake_source);
    remove_source(&engine->socket_source);
    remove_source(&engine->pause_timer);
    remove_source(&engine->failure_idle);
    struct web_page *page;
    wl_list_for_each(page, &web->pages, link) {
        if (page->engine == engine) page->engine = NULL;
    }
    engine_send(engine, WEB_STOP, 0, 0, 0, 0, 0, 0, NULL, -1);
    shutdown(engine->socket, SHUT_RDWR);
    close(engine->socket);
    close(engine->wake);
    struct reaper *reaper = xmalloc(sizeof *reaper);
    reaper->pid = engine->pid;
    memcpy(reaper->cache, engine->cache, sizeof reaper->cache);
    pthread_t thread;
    if (pthread_create(&thread, NULL, reap, reaper) == 0) {
        pthread_detach(thread);
    } else {
        kill(-engine->pid, SIGTERM);
        free(reaper);
    }
    wlr_log(WLR_INFO, "web: stopping helper %d", engine->pid);
    if (web->dispatching) *(struct engine **)vec_push(&web->doomed_engines) = engine;
    else free(engine);
}

static void frame_reset(struct frame *frame) {
    *frame = (struct frame){.fence = -1};
}

/* Close FRAME's descriptors without telling the helper. */
static void frame_drop(struct frame *frame) {
    if (frame->valid) {
        if (frame->fence >= 0) close(frame->fence);
        for (int p = 0; p < frame->buffer.planes; p++) close(frame->fds[p]);
    }
    frame_reset(frame);
}

/*
 * Hand FRAME's buffer back to the helper. A SAMPLED frame goes with a fence
 * after the GL commands issued so far, so this is GL. False when the transport
 * failed, which fails the engine.
 */
static bool release_frame(struct web_page *page, struct frame *frame, bool sampled) {
    if (!frame->valid) return true;
    struct engine *engine = page->engine;
    if (sampled && frame->texture) {
        if (frame->fence >= 0) close(frame->fence);
        frame->fence = web_export_fence();
        if (frame->fence < 0) {
            set_error("Cannot export consumer DMA-BUF fence");
            if (engine) engine->failed = true;
            return false;
        }
    }
    bool ok = true;
    if (engine && !engine->failed &&
        !engine_send(engine, WEB_RELEASE, page->id, frame->buffer.layer, frame->buffer.token, 0, 0,
                     0, NULL, frame->fence)) {
        set_error("release browser DMA-BUF: %s", strerror(errno));
        engine->failed = true;
        ok = false;
    }
    frame_drop(frame);
    return ok;
}

static struct web_page *engine_page(struct engine *engine, int id) {
    struct web_page *page;
    wl_list_for_each(page, &engine->web->pages, link) {
        if (page->engine == engine && page->id == id) return page;
    }
    return NULL;
}

/* Take every frame the helper sent; they wait as pending until drawn. -1 when the link broke. */
static int receive_frames(struct engine *engine) {
    if (engine->failed) return -1;
    for (;;) {
        struct frame frame;
        frame_reset(&frame);
        char control[CMSG_SPACE(sizeof(int) * WEB_PLANES)] = {0};
        struct iovec io = {&frame.buffer, sizeof frame.buffer};
        struct msghdr message = {
            .msg_iov = &io,
            .msg_iovlen = 1,
            .msg_control = control,
            .msg_controllen = sizeof control,
        };
        ssize_t size = recvmsg(engine->socket, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
        if (size < 0 && errno == EINTR) continue;
        if (size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
        if (size <= 0) {
            if (size == 0) set_error("Browser command channel closed");
            else fail("receive browser frame");
            return -1;
        }
        int count = 0;
        for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header;
             header = CMSG_NXTHDR(&message, header)) {
            if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) continue;
            int n = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            for (int p = 0; p < n; p++) {
                int fd;
                memcpy(&fd, (int *)CMSG_DATA(header) + p, sizeof fd);
                if (count < WEB_PLANES) frame.fds[count++] = fd;
                else close(fd);
            }
        }
        struct web_buffer *b = &frame.buffer;
        if (size != sizeof *b || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) ||
            b->planes != count || count < 1 || b->layer < 0 || b->layer > 1 || b->width < 1 ||
            b->height < 1 || b->width > WEB_MAX_SIDE || b->height > WEB_MAX_SIDE) {
            for (int p = 0; p < count; p++) close(frame.fds[p]);
            set_error("Invalid browser DMA-BUF packet");
            return -1;
        }
        frame.valid = true;
        struct web_page *page = engine_page(engine, b->id);
        if (!page) {
            frame_drop(&frame);
            continue;
        }
        struct layer *layer = &page->layers[b->layer];
        if (!release_frame(page, &layer->pending, false)) {
            frame_drop(&frame);
            return -1;
        }
        layer->pending = frame;
    }
}

/* Every page of a broken helper fails, keeping its last frame, and the helper stops. */
static void handle_failure(struct engine *engine) {
    struct web *web = engine->web;
    char message[320];
    snprintf(message, sizeof message, "Browser helper exited or its buffer transport failed: %s",
             error_text);
    wlr_log(WLR_ERROR, "web: %s", message);
    begin_dispatch(web);
    struct vec pages;
    engine_pages(engine, &pages);
    VEC_FOR(&pages, struct web_page *, page) (*page)->failed = true;
    engine_stop(engine);
    VEC_FOR(&pages, struct web_page *, entry) {
        struct web_page *page = *entry;
        if (!page->closed && page->listener->error)
            page->listener->error(page, message, page->data);
    }
    vec_finish(&pages);
    end_dispatch(web);
}

static void handle_engine_failure(void *data) {
    struct engine *engine = data;
    engine->failure_idle = NULL;
    handle_failure(engine);
}

/* For failures found while drawing, where reporting could close the page being drawn. */
static void fail_engine_later(struct engine *engine) {
    engine->failed = true;
    if (!engine->failure_idle)
        engine->failure_idle =
            wl_event_loop_add_idle(engine->web->loop, handle_engine_failure, engine);
}

static void handle_page_failure(void *data) {
    struct web_page *page = data;
    page->failure_idle = NULL;
    if (page->listener->error) page->listener->error(page, page->failure, page->data);
}

static void fail_page_later(struct web_page *page, const char *message) {
    wlr_log(WLR_ERROR, "web: %s: %s", page->src, message);
    page->failed = true;
    free(page->failure);
    page->failure = xstrdup(message);
    if (!page->failure_idle)
        page->failure_idle = wl_event_loop_add_idle(page->web->loop, handle_page_failure, page);
}

/* Pages and their events. */

static bool send_command(struct web_page *page, int op, int a, int b, int c, int d, double scale,
                         const char *text) {
    struct engine *engine = page->engine;
    if (!engine || page->closed) return false;
    engine_wake(engine);
    if (!engine_send(engine, op, page->id, a, b, c, d, scale, text, -1)) {
        wlr_log(WLR_ERROR, "web: %s: %s", page->src, error_text);
        return false;
    }
    return true;
}

static void post_props(struct web_page *page) {
    if (!page->props || !page->loaded) return;
    if (page->posted && !strcmp(page->posted, page->props)) return;
    free(page->posted);
    page->posted = xstrdup(page->props);
    struct strbuf script;
    strbuf_init(&script);
    strbuf_puts(&script, "dispatchEvent(new CustomEvent('proscenium-message',"
                         "{detail:{name:\"props\",value:JSON.parse(");
    struct json_writer writer;
    json_writer_init(&writer, &script);
    json_string(&writer, page->props);
    strbuf_puts(&script, ")}}))");
    send_command(page, WEB_EVAL, 0, 0, 0, 0, 0, script.data);
    strbuf_finish(&script);
}

/* The text of VALUE when it is a JSON string, as the helper's errors are; else VALUE itself. */
static char *json_text(const char *value) {
    struct json_document document;
    char problem[64];
    char *text = NULL;
    if (json_parse(value, strlen(value), &document, problem, sizeof problem)) {
        if (document.root->type == JSON_STRING) text = xstrdup(document.root->string.chars);
        json_document_finish(&document);
    }
    return text ? text : xstrdup(value);
}

static void dispatch_event(struct web_page *page, const char *name, const char *value) {
    const struct web_page_listener *listener = page->listener;
    if (!strcmp(name, "load")) {
        page->loaded = true;
        free(page->posted);
        page->posted = NULL;
        post_props(page);
        if (listener->load) listener->load(page, atoi(value), page->data);
    } else if (!strcmp(name, "error")) {
        char *message = json_text(value);
        wlr_log(WLR_INFO, "web: %s: %s", page->src, message);
        if (listener->error) listener->error(page, message, page->data);
        free(message);
    } else if (!strcmp(name, MESSAGE_NAME)) {
        if (listener->message) listener->message(page, value, page->data);
    } else {
        wlr_log(WLR_DEBUG, "web: %s: %s %s", page->src, name, value);
    }
}

/* Report the events the helper queued for PAGE, which a report may close. */
static void drain_events(struct web_page *page) {
    struct web_event event;
    for (int i = 0; i < WEB_EVENTS && !page->closed && page->engine; i++) {
        struct web_shared *shared = page->shared;
        /* The helper is writing, and signals once it is done. */
        if (web_lock(shared, 1)) return;
        bool found = shared->event_read != shared->event_write;
        if (found) {
            struct web_event *queued = &shared->events[shared->event_read++ % WEB_EVENTS];
            memcpy(&event, queued, sizeof event);
            event.name[sizeof event.name - 1] = '\0';
            event.value[sizeof event.value - 1] = '\0';
        }
        pthread_mutex_unlock(&shared->mutex);
        if (!found) return;
        dispatch_event(page, event.name, event.value);
    }
}

/* Whether a frame awaits web_page_prepare. */
static bool page_dirty(const struct web_page *page) {
    if (page->closed || page->failed) return false;
    return page->layers[0].pending.valid || page->layers[1].pending.valid ||
           __atomic_load_n(&page->shared->dirty, __ATOMIC_ACQUIRE);
}

/* Tell each visible page of ENGINE with a frame waiting; with EVENTS, report its events first. */
static void report(struct engine *engine, bool events) {
    struct web *web = engine->web;
    begin_dispatch(web);
    struct vec pages;
    engine_pages(engine, &pages);
    VEC_FOR(&pages, struct web_page *, entry) {
        struct web_page *page = *entry;
        if (engine->stopped) break;
        if (page->closed) continue;
        if (events) drain_events(page);
        if (!page->closed && page->visible && page_dirty(page) && page->listener->frame)
            page->listener->frame(page, page->data);
    }
    vec_finish(&pages);
    end_dispatch(web);
}

/* The helper sent frames over its socket, or painted bitmaps or queued events and
 * signalled its wake descriptor; a closed socket means it went away. */
static int handle_engine(int fd, uint32_t mask, void *data) {
    struct engine *engine = data;
    bool events = fd == engine->wake;
    if (events) {
        uint64_t count;
        (void)!read(fd, &count, sizeof count);
    }
    if (receive_frames(engine) < 0) {
        handle_failure(engine);
        return 0;
    }
    report(engine, events);
    return 0;
}

static struct engine *engine_start(struct web *web) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) < 0) {
        fail("socketpair");
        return NULL;
    }
    int wake = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (wake < 0) {
        fail("eventfd");
        close(pair[0]);
        close(pair[1]);
        return NULL;
    }
    struct engine *engine = xcalloc(1, sizeof *engine);
    engine->web = web;
    engine->socket = pair[0];
    engine->wake = wake;
    strcpy(engine->cache, "/tmp/proscenium-web-engine-XXXXXX");
    if (!mkdtemp(engine->cache)) {
        fail("browser cache directory");
        close(pair[0]);
        close(pair[1]);
        close(wake);
        free(engine);
        return NULL;
    }

    struct strbuf command_arg, wake_arg, cache_arg, display_arg;
    strbuf_init(&command_arg);
    strbuf_init(&wake_arg);
    strbuf_init(&cache_arg);
    strbuf_init(&display_arg);
    strbuf_printf(&command_arg, "--proscenium-command-fd=%d", pair[1]);
    strbuf_printf(&wake_arg, "--proscenium-wake-fd=%d", wake);
    strbuf_printf(&cache_arg, "--proscenium-cache-dir=%s", engine->cache);
    strbuf_printf(&display_arg, "--proscenium-wayland-display=%s", web->display);
    char *argv[] = {web->helper,    command_arg.data, wake_arg.data,
                    cache_arg.data, display_arg.data, NULL};

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    /*
     * dup2(fd, fd) in posix_spawn clears CLOEXEC in the child. Keeping the
     * numbers avoids collisions when the compositor already holds hundreds.
     */
    posix_spawn_file_actions_adddup2(&actions, pair[1], pair[1]);
    posix_spawn_file_actions_adddup2(&actions, wake, wake);
    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
    /*
     * Its own process group, to pause and stop all of Chromium's processes at
     * once; and no signal blocked or ignored the way the event loop keeps them.
     */
    sigset_t none, all;
    sigemptyset(&none);
    sigfillset(&all);
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK |
                                              POSIX_SPAWN_SETSIGDEF);
    posix_spawnattr_setpgroup(&attributes, 0);
    posix_spawnattr_setsigmask(&attributes, &none);
    posix_spawnattr_setsigdefault(&attributes, &all);
    int result = posix_spawn(&engine->pid, web->helper, &actions, &attributes, argv, environ);
    posix_spawnattr_destroy(&attributes);
    posix_spawn_file_actions_destroy(&actions);
    strbuf_finish(&command_arg);
    strbuf_finish(&wake_arg);
    strbuf_finish(&cache_arg);
    strbuf_finish(&display_arg);
    close(pair[1]);
    if (result) {
        errno = result;
        set_error("start web helper %s: %s", web->helper, strerror(result));
        close(pair[0]);
        close(wake);
        rmdir(engine->cache);
        free(engine);
        return NULL;
    }

    web->engine = engine;
    engine->wake_source =
        wl_event_loop_add_fd(web->loop, wake, WL_EVENT_READABLE, handle_engine, engine);
    engine->socket_source =
        wl_event_loop_add_fd(web->loop, pair[0], WL_EVENT_READABLE, handle_engine, engine);
    engine->pause_timer = wl_event_loop_add_timer(web->loop, handle_pause, engine);
    if (!engine->wake_source || !engine->socket_source || !engine->pause_timer) {
        set_error("Cannot watch the web helper");
        engine_stop(engine);
        return NULL;
    }
    wlr_log(WLR_INFO, "web: started helper %d (%s)", engine->pid,
            *web->display ? "dma-buf frames" : "bitmap frames");
    return engine;
}

struct web *web_create(struct wl_event_loop *loop, const char *helper,
                       const char *wayland_display) {
    struct web *web = xcalloc(1, sizeof *web);
    web->loop = loop;
    if (!helper) helper = getenv("PROSCENIUM_WEB_HELPER");
    if (helper && *helper) {
        web->helper = xstrdup(helper);
    } else {
        char executable[PATH_MAX];
        ssize_t length = readlink("/proc/self/exe", executable, sizeof executable - 1);
        executable[length > 0 ? length : 0] = '\0';
        char *slash = strrchr(executable, '/');
        if (slash) *slash = '\0';
        struct strbuf path;
        strbuf_init(&path);
        strbuf_printf(&path, "%s/web/proscenium-web-helper", slash ? executable : ".");
        web->helper = path.data;
    }
    web->display = xstrdup(wayland_display ? wayland_display : "");
    wl_list_init(&web->pages);
    vec_init(&web->garbage, sizeof(struct import));
    vec_init(&web->doomed_pages, sizeof(struct web_page *));
    vec_init(&web->doomed_engines, sizeof(struct engine *));
    web->command = xmalloc(sizeof *web->command);
    return web;
}

void web_destroy(struct web *web) {
    if (!web) return;
    struct web_page *page, *next;
    wl_list_for_each_safe(page, next, &web->pages, link) web_page_close(page);
    if (web->engine) engine_stop(web->engine);
    if (web->garbage.length)
        wlr_log(WLR_DEBUG, "web: %zu textures left without a GL context", web->garbage.length);
    vec_finish(&web->garbage);
    vec_finish(&web->doomed_pages);
    vec_finish(&web->doomed_engines);
    free(web->command);
    free(web->helper);
    free(web->display);
    free(web);
}

int web_helper_pid(const struct web *web) {
    return web->engine ? web->engine->pid : 0;
}

/* Graphics. */

static void delete_import(struct import *import) {
    if (import->texture) glDeleteTextures(1, &import->texture);
    web_destroy_image(import->display, import->image);
    *import = (struct import){0};
}

/* Keep IMPORT's GL objects for the next GL call to delete. */
static void collect(struct web *web, struct import import) {
    if (import.texture || import.image) *(struct import *)vec_push(&web->garbage) = import;
}

static void free_garbage(struct web *web) {
    VEC_FOR(&web->garbage, struct import, import) delete_import(import);
    vec_clear(&web->garbage);
}

static void set_texture_parameters(void) {
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

/* GL. Give FRAME a texture, reusing the import of its buffer when the helper reuses one. */
static bool import_frame(struct web_page *page, struct frame *frame, GLint *binding) {
    struct layer *layer = &page->layers[frame->buffer.layer];
    for (int i = 0; i < IMPORTS; i++) {
        struct import *old = &layer->imports[i];
        if (old->texture &&
            (old->width != frame->buffer.width || old->height != frame->buffer.height)) {
            if ((GLuint)*binding == old->texture) *binding = 0;
            delete_import(old);
        }
    }
    for (int i = 0; i < IMPORTS; i++) {
        if (layer->imports[i].texture && layer->imports[i].token == frame->buffer.token) {
            frame->texture = layer->imports[i].texture;
            return true;
        }
    }
    struct import *slot = NULL;
    for (int i = 0; i < IMPORTS && !slot; i++)
        if (!layer->imports[i].texture) slot = &layer->imports[i];
    if (!slot) slot = &layer->imports[frame->buffer.token % IMPORTS];
    if (slot->texture && (GLuint)*binding == slot->texture) *binding = 0;
    delete_import(slot);
    slot->display = eglGetCurrentDisplay();
    slot->image = web_import(slot->display, &frame->buffer, frame->fds);
    if (!slot->image) {
        set_error("Cannot import browser DMA-BUF into compositor EGL display (0x%x)",
                  eglGetError());
        return false;
    }
    glGenTextures(1, &slot->texture);
    glBindTexture(GL_TEXTURE_2D, slot->texture);
    web_bind_image(slot->image);
    set_texture_parameters();
    slot->token = frame->buffer.token;
    slot->width = frame->buffer.width;
    slot->height = frame->buffer.height;
    frame->texture = slot->texture;
    return true;
}

/* GL. 1 with RECT, in texture pixels, when the page's frames changed; 0 when not; -1 on failure. */
static int prepare_dmabuf(struct web_page *page, int rect[4]) {
    if (page->engine && page->engine->failed) return -1;
    bool changed = page_dirty(page);
    if (!changed && page->layers[0].front.texture) return 0;
    GLint binding;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
    for (int p = 0; p < 2; p++) {
        struct layer *layer = &page->layers[p];
        if (layer->pending.valid) {
            if (!release_frame(page, &layer->front, true)) {
                glBindTexture(GL_TEXTURE_2D, binding);
                return -1;
            }
            layer->front = layer->pending;
            frame_reset(&layer->pending);
        }
        if (layer->front.valid && !layer->front.texture) {
            if (!import_frame(page, &layer->front, &binding)) {
                glBindTexture(GL_TEXTURE_2D, binding);
                return -1;
            }
            changed = true;
        }
    }
    glBindTexture(GL_TEXTURE_2D, binding);
    struct frame *front = &page->layers[0].front;
    page->texture_width = front->buffer.width;
    page->texture_height = front->buffer.height;
    __atomic_store_n(&page->shared->dirty, 0, __ATOMIC_RELEASE);
    rect[0] = rect[1] = 0;
    rect[2] = page->texture_width;
    rect[3] = page->texture_height;
    return changed && front->valid;
}

static bool gles3(void) {
    static int major = -1;
    if (major < 0) {
        const char *version = (const char *)glGetString(GL_VERSION);
        major = 0;
        if (version && sscanf(version, "OpenGL ES %d", &major) != 1) major = 0;
    }
    return major >= 3;
}

/* GL. prepare_dmabuf for bitmaps: upload what changed from shared memory. */
static int prepare_bitmap(struct web_page *page, int rect[4]) {
    struct web_shared *shared = page->shared;
    if (page->bitmap && !page_dirty(page)) return 0;
    if (!gles3()) {
        set_error("Web page bitmaps need GLES 3");
        return -1;
    }
    if (web_lock(shared, 1)) return 0;
    if (shared->width <= 0 || shared->height <= 0) {
        pthread_mutex_unlock(&shared->mutex);
        return 0;
    }
    GLint texture, alignment, row, buffer, skip_pixels, skip_rows;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
    glGetIntegerv(GL_UNPACK_ALIGNMENT, &alignment);
    glGetIntegerv(GL_UNPACK_ROW_LENGTH, &row);
    glGetIntegerv(GL_UNPACK_SKIP_PIXELS, &skip_pixels);
    glGetIntegerv(GL_UNPACK_SKIP_ROWS, &skip_rows);
    glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &buffer);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei(GL_UNPACK_ROW_LENGTH, shared->width);
    if (!page->bitmap) glGenTextures(1, &page->bitmap);
    glBindTexture(GL_TEXTURE_2D, page->bitmap);
    int x = shared->x, y = shared->y, w = shared->right - x, h = shared->bottom - y;
    if (page->texture_width != shared->width || page->texture_height != shared->height) {
        page->texture_width = shared->width;
        page->texture_height = shared->height;
        x = y = 0;
        w = shared->width;
        h = shared->height;
        set_texture_parameters();
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, shared->pixels);
    } else {
        glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE,
                        shared->pixels + ((size_t)y * shared->width + x) * 4);
    }
    __atomic_store_n(&shared->dirty, 0, __ATOMIC_RELEASE);
    pthread_mutex_unlock(&shared->mutex);
    glBindTexture(GL_TEXTURE_2D, texture);
    glPixelStorei(GL_UNPACK_ALIGNMENT, alignment);
    glPixelStorei(GL_UNPACK_ROW_LENGTH, row);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, buffer);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS, skip_pixels);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, skip_rows);
    rect[0] = x;
    rect[1] = y;
    rect[2] = w;
    rect[3] = h;
    return 1;
}

static bool page_dmabuf(const struct web_page *page) {
    return __atomic_load_n(&page->shared->accelerated, __ATOMIC_ACQUIRE);
}

bool web_page_prepare(struct web_page *page, struct box *damage) {
    if (page->closed || page->failed) return false;
    int rect[4];
    int result = page_dmabuf(page) ? prepare_dmabuf(page, rect) : prepare_bitmap(page, rect);
    if (result < 0) {
        if (page->engine && page->engine->failed) fail_engine_later(page->engine);
        else fail_page_later(page, error_text);
        return false;
    }
    if (result == 0) return false;
    /* The texture covers the page whatever its pixel size: whole CSS pixels around the change. */
    double sx = page->width / page->texture_width, sy = page->height / page->texture_height;
    double left = floor(rect[0] * sx), top = floor(rect[1] * sy);
    double right = ceil((rect[0] + rect[2]) * sx), bottom = ceil((rect[1] + rect[3]) * sy);
    *damage = (struct box){left, top, right - left, bottom - top};
    return true;
}

int web_page_surfaces(const struct web_page *page, struct web_surface out[2]) {
    if (page->closed) return 0;
    bool dmabuf = page_dmabuf(page);
    GLuint texture = dmabuf ? page->layers[0].front.texture : page->bitmap;
    if (!texture) return 0;
    out[0] = (struct web_surface){
        .texture = texture,
        .texture_width = page->texture_width,
        .texture_height = page->texture_height,
        .box = {0, 0, page->width, page->height},
    };
    const struct frame *popup = &page->layers[1].front;
    if (!dmabuf || !popup->texture ||
        !__atomic_load_n(&page->shared->popup_visible, __ATOMIC_ACQUIRE))
        return 1;
    /* Bitmap pages blend their popups in; dma-buf popups come at the page's raster scale. */
    double scale = page->scale;
    out[1] = (struct web_surface){
        .texture = popup->texture,
        .texture_width = popup->buffer.width,
        .texture_height = popup->buffer.height,
        .box = {__atomic_load_n(&page->shared->popup_x, __ATOMIC_ACQUIRE) / scale,
                __atomic_load_n(&page->shared->popup_y, __ATOMIC_ACQUIRE) / scale,
                popup->buffer.width / scale, popup->buffer.height / scale},
    };
    return 2;
}

/* GL. Delete PAGE's textures; its frames stay, fenced after the GL commands issued so far. */
static void detach_graphics(struct web_page *page) {
    for (int p = 0; p < 2; p++) {
        struct frame *front = &page->layers[p].front;
        if (front->texture) {
            if (front->fence >= 0) close(front->fence);
            front->fence = web_export_fence();
            if (front->fence < 0 && page->engine) {
                set_error("Cannot export detached browser fence");
                fail_engine_later(page->engine);
            }
            front->texture = 0;
        }
        for (int i = 0; i < IMPORTS; i++) delete_import(&page->layers[p].imports[i]);
    }
    if (page->bitmap) glDeleteTextures(1, &page->bitmap);
    page->bitmap = 0;
    page->texture_width = page->texture_height = 0;
}

void web_collect_garbage(struct web *web) {
    free_garbage(web);
}

void web_release_graphics(struct web *web) {
    free_garbage(web);
    struct web_page *page;
    wl_list_for_each(page, &web->pages, link) detach_graphics(page);
}

/* Lifecycle. */

static bool is_url(const char *src) {
    return strstr(src, "://") || !strncmp(src, "data:", 5) || !strncmp(src, "about:", 6);
}

/* NAME as a URL path segment. */
static void append_segment(struct strbuf *out, const char *name) {
    for (const unsigned char *p = (const unsigned char *)name; *p; p++) {
        if (isalnum(*p) || strchr("-._~!$&'()*+,;=:@", *p)) strbuf_putc(out, (char)*p);
        else strbuf_printf(out, "%%%02X", *p);
    }
}

/*
 * The helper's page configuration for SRC: the directory it may serve files
 * from (empty for none), a newline, and the URL to load.
 */
static bool resolve_src(const char *src, struct strbuf *config) {
    if (!src || !*src) {
        set_error("A web page needs a src");
        return false;
    }
    if (is_url(src)) {
        strbuf_putc(config, '\n');
        strbuf_puts(config, src);
        return true;
    }
    char *path = realpath(src, NULL);
    struct stat st;
    if (!path || stat(path, &st) < 0) {
        set_error("Cannot open %s: %s", src, strerror(errno));
        free(path);
        return false;
    }
    if (S_ISDIR(st.st_mode)) {
        strbuf_printf(config, "%s/\n" FILE_ORIGIN "index.html", path);
    } else if (S_ISREG(st.st_mode)) {
        char *slash = strrchr(path, '/');
        strbuf_append(config, path, slash - path + 1);
        strbuf_puts(config, "\n" FILE_ORIGIN);
        append_segment(config, slash + 1);
    } else {
        set_error("%s is neither a file nor a directory", src);
        free(path);
        return false;
    }
    free(path);
    return true;
}

static double extent(double value) {
    return value >= 1 ? MIN(value, EXTENT_MAX) : 1;
}

/* SCALE, kept to rasters the helper can hand over. */
static double limit_scale(double scale, double width, double height) {
    if (!(scale > 0) || !isfinite(scale)) scale = 1;
    return MIN(scale, (WEB_MAX_SIDE - 1) / MAX(ceil(width), ceil(height)));
}

struct web_page *web_page_create(struct web *web, const struct web_page_options *options) {
    struct strbuf config;
    strbuf_init(&config);
    if (!resolve_src(options->src, &config)) goto fail_config;
    if (config.length >= WEB_TEXT) {
        set_error("Web page source exceeds %d bytes", WEB_TEXT - 1);
        goto fail_config;
    }
    double width = extent(options->width), height = extent(options->height);
    double scale = limit_scale(options->scale, width, height);

    struct engine *engine = web->engine ? web->engine : engine_start(web);
    if (!engine) goto fail_config;
    int fd = memfd_create("proscenium-web-page", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, WEB_MAP_SIZE) < 0) {
        fail("web page memory");
        goto fail_memory;
    }
    struct web_shared *shared = mmap(NULL, WEB_MAP_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (shared == MAP_FAILED) {
        fail("map web page");
        goto fail_memory;
    }
    pthread_mutexattr_t attributes;
    pthread_mutexattr_init(&attributes);
    pthread_mutexattr_setpshared(&attributes, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_setrobust(&attributes, PTHREAD_MUTEX_ROBUST);
    pthread_mutex_init(&shared->mutex, &attributes);
    pthread_mutexattr_destroy(&attributes);

    int id = ++engine->next_id;
    engine_wake(engine);
    if (!engine_send(engine, WEB_CREATE, id, (int)ceil(width), (int)ceil(height), 0, 0, scale,
                     config.data, fd)) {
        munmap(shared, WEB_MAP_SIZE);
        goto fail_memory;
    }
    close(fd);
    strbuf_finish(&config);

    struct web_page *page = xcalloc(1, sizeof *page);
    page->web = web;
    page->engine = engine;
    page->shared = shared;
    page->id = id;
    page->src = xstrdup(options->src);
    page->width = width;
    page->height = height;
    page->scale = scale;
    page->revision = options->revision;
    page->visible = true;
    page->listener = options->listener ? options->listener : &no_listener;
    page->data = options->data;
    for (int p = 0; p < 2; p++) {
        frame_reset(&page->layers[p].front);
        frame_reset(&page->layers[p].pending);
    }
    wl_list_insert(web->pages.prev, &page->link);
    engine->pages++;
    return page;

fail_memory:
    if (fd >= 0) close(fd);
    if (!engine->pages) engine_stop(engine);
fail_config:
    strbuf_finish(&config);
    return NULL;
}

void web_page_close(struct web_page *page) {
    if (!page || page->closed) return;
    struct web *web = page->web;
    struct engine *engine = page->engine;
    if (engine) engine_send(engine, WEB_CLOSE, page->id, 0, 0, 0, 0, 0, NULL, -1);
    page->closed = true;
    for (int p = 0; p < 2; p++) {
        struct layer *layer = &page->layers[p];
        frame_drop(&layer->front);
        frame_drop(&layer->pending);
        for (int i = 0; i < IMPORTS; i++) {
            collect(web, layer->imports[i]);
            layer->imports[i] = (struct import){0};
        }
    }
    collect(web, (struct import){.texture = page->bitmap});
    page->bitmap = 0;
    remove_source(&page->failure_idle);
    munmap(page->shared, WEB_MAP_SIZE);
    page->shared = NULL;
    wl_list_remove(&page->link);
    free(page->src);
    free(page->props);
    free(page->posted);
    free(page->failure);
    if (engine && --engine->pages == 0) engine_stop(engine);
    if (web->dispatching) *(struct web_page **)vec_push(&web->doomed_pages) = page;
    else free(page);
}

void web_page_set_listener_data(struct web_page *page, void *data) {
    page->data = data;
}

bool web_page_dmabuf(const struct web_page *page) {
    return !page->closed && page_dmabuf(page);
}

static void resize(struct web_page *page, double width, double height, double scale) {
    width = extent(width);
    height = extent(height);
    scale = limit_scale(scale, width, height);
    if (width == page->width && height == page->height && scale == page->scale) return;
    send_command(page, WEB_RESIZE, (int)ceil(width), (int)ceil(height), 0, 0, scale, NULL);
    page->width = width;
    page->height = height;
    page->scale = scale;
}

void web_page_resize(struct web_page *page, double width, double height) {
    resize(page, width, height, page->scale);
}

void web_page_size(const struct web_page *page, double *width, double *height) {
    *width = page->width;
    *height = page->height;
}

void web_page_set_raster_scale(struct web_page *page, double scale) {
    if (!(scale > 0)) return;
    scale = CLAMP(scale, SCALE_MIN, SCALE_MAX);
    if (fabs(scale - page->scale) > SCALE_HYSTERESIS * page->scale)
        resize(page, page->width, page->height, scale);
}

double web_page_raster_scale(const struct web_page *page) {
    return page->scale;
}

void web_page_set_visible(struct web_page *page, bool visible) {
    if (!page->engine || page->visible == visible) return;
    send_command(page, WEB_VISIBLE, visible, 0, 0, 0, 0, NULL);
    page->visible = visible;
}

void web_page_set_props(struct web_page *page, const char *json) {
    if (json && page->props && !strcmp(json, page->props)) return;
    free(page->props);
    page->props = json ? xstrdup(json) : NULL;
    post_props(page);
}

void web_page_set_revision(struct web_page *page, double revision) {
    if (revision == page->revision || (isnan(revision) && isnan(page->revision))) return;
    page->revision = revision;
    page->loaded = false;
    send_command(page, WEB_EVAL, 0, 0, 0, 0, 0, "location.reload()");
}

/* Input, mapped as Chromium's Windows-style key codes and event flags expect. */

/* CEF event flags for wlroots modifiers. */
static int event_flags(uint32_t modifiers) {
    return (modifiers & WLR_MODIFIER_CAPS ? 1 : 0) | (modifiers & WLR_MODIFIER_SHIFT ? 2 : 0) |
           (modifiers & WLR_MODIFIER_CTRL ? 4 : 0) | (modifiers & WLR_MODIFIER_ALT ? 8 : 0) |
           (modifiers & WLR_MODIFIER_LOGO ? 128 : 0) | (modifiers & WLR_MODIFIER_MOD2 ? 256 : 0);
}

/* Windows virtual key codes of US punctuation, by the character typed. */
static const struct {
    uint32_t character;
    int key;
} punctuation_keys[] = {
    {';', 186}, {':', 186}, {'=', 187},  {'+', 187}, {',', 188}, {'<', 188}, {'-', 189},
    {'_', 189}, {'.', 190}, {'>', 190},  {'/', 191}, {'?', 191}, {'`', 192}, {'~', 192},
    {'[', 219}, {'{', 219}, {'\\', 220}, {'|', 220}, {']', 221}, {'}', 221}, {'\'', 222},
    {'"', 222}, {'!', 49},  {'@', 50},   {'#', 51},  {'$', 52},  {'%', 53},  {'^', 54},
    {'&', 55},  {'*', 56},  {'(', 57},   {')', 48},
};

static int virtual_key(uint32_t keysym) {
    uint32_t unicode = xkb_keysym_to_utf32(keysym);
    for (size_t i = 0; i < ARRAY_LENGTH(punctuation_keys); i++)
        if (punctuation_keys[i].character == unicode) return punctuation_keys[i].key;
    if (unicode >= 'a' && unicode <= 'z') return unicode - 32;
    if (unicode >= 32 && unicode <= 126) return unicode;
    if (keysym >= XKB_KEY_F1 && keysym <= XKB_KEY_F24) return 112 + (keysym - XKB_KEY_F1);
    switch (keysym) {
    case XKB_KEY_BackSpace: return 8;
    case XKB_KEY_Tab: return 9;
    case XKB_KEY_Return: return 13;
    case XKB_KEY_Escape: return 27;
    case XKB_KEY_Delete: return 46;
    case XKB_KEY_Home: return 36;
    case XKB_KEY_Left: return 37;
    case XKB_KEY_Up: return 38;
    case XKB_KEY_Right: return 39;
    case XKB_KEY_Down: return 40;
    case XKB_KEY_Prior: return 33;
    case XKB_KEY_Next: return 34;
    case XKB_KEY_End: return 35;
    case XKB_KEY_Insert: return 45;
    case XKB_KEY_Shift_L:
    case XKB_KEY_Shift_R: return 16;
    case XKB_KEY_Control_L:
    case XKB_KEY_Control_R: return 17;
    case XKB_KEY_Alt_L:
    case XKB_KEY_Alt_R: return 18;
    default: return 0;
    }
}

/* CODEPOINT as UTF-8 in OUT, which holds at least 5 bytes. */
static void utf8(uint32_t codepoint, char *out) {
    if (codepoint < 0x80) {
        *out++ = (char)codepoint;
    } else if (codepoint < 0x800) {
        *out++ = (char)(0xc0 | codepoint >> 6);
        *out++ = (char)(0x80 | (codepoint & 0x3f));
    } else if (codepoint < 0x10000) {
        *out++ = (char)(0xe0 | codepoint >> 12);
        *out++ = (char)(0x80 | (codepoint >> 6 & 0x3f));
        *out++ = (char)(0x80 | (codepoint & 0x3f));
    } else {
        *out++ = (char)(0xf0 | codepoint >> 18);
        *out++ = (char)(0x80 | (codepoint >> 12 & 0x3f));
        *out++ = (char)(0x80 | (codepoint >> 6 & 0x3f));
        *out++ = (char)(0x80 | (codepoint & 0x3f));
    }
    *out = '\0';
}

/* Coordinates as Chromium takes them: whole CSS pixels, ties to even. */
static int pixel(double value) {
    return (int)rint(CLAMP(value, -1e6, 1e6));
}

void web_page_focus(struct web_page *page, bool focused) {
    send_command(page, WEB_FOCUS, focused, 0, 0, 0, 0, NULL);
}

void web_page_pointer_motion(struct web_page *page, double x, double y) {
    send_command(page, WEB_MOVE, pixel(x), pixel(y), 0, 0, 0, NULL);
}

void web_page_pointer_leave(struct web_page *page) {
    send_command(page, WEB_MOVE, 0, 0, 1, 0, 0, NULL);
}

void web_page_pointer_button(struct web_page *page, double x, double y, uint32_t button,
                             bool pressed) {
    /* BTN_LEFT, BTN_RIGHT and BTN_MIDDLE as the helper numbers them. */
    int number = button == 0x110 ? 1 : button == 0x111 ? 2 : button == 0x112 ? 3 : 0;
    if (number) send_command(page, WEB_BUTTON, pixel(x), pixel(y), number, pressed, 0, NULL);
}

void web_page_pointer_axis(struct web_page *page, double x, double y, bool horizontal, double delta,
                           bool inverted) {
    int amount = pixel((inverted ? 1 : -1) * delta);
    send_command(page, WEB_SCROLL, pixel(x), pixel(y), horizontal ? amount : 0,
                 horizontal ? 0 : amount, 0, NULL);
}

void web_page_key(struct web_page *page, uint32_t keycode, const uint32_t *keysyms, int count,
                  bool pressed, uint32_t modifiers) {
    int flags = event_flags(modifiers);
    bool shortcut = modifiers & (WLR_MODIFIER_CTRL | WLR_MODIFIER_ALT | WLR_MODIFIER_LOGO);
    for (int i = 0; i < count; i++) {
        uint32_t unicode = xkb_keysym_to_utf32(keysyms[i]);
        char text[8] = "";
        if (unicode) utf8(unicode, text);
        send_command(page, WEB_KEY, virtual_key(keysyms[i]), pressed, keycode + 8, flags, 0, text);
        if (pressed && !shortcut && (unicode >= 32 || unicode == 9 || unicode == 13))
            send_command(page, WEB_TEXT_INPUT, 0, 0, 0, 0, 0, text);
    }
}

void web_page_modifiers(struct web_page *page, uint32_t modifiers) {
    send_command(page, WEB_MODIFIERS, event_flags(modifiers), 0, 0, 0, 0, NULL);
}
