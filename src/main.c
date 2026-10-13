/*
 * Entry point: options, the Wayland globals, the director process, the loop.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <EGL/egl.h>
#include <wlr/backend.h>
#include <wlr/backend/headless.h>
#include <wlr/render/allocator.h>
#include <wlr/render/egl.h>
#include <wlr/render/gles2.h>
#include <wlr/render/wlr_renderer.h>
#include <wlr/types/wlr_alpha_modifier_v1.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_cursor_shape_v1.h>
#include <wlr/types/wlr_data_control_v1.h>
#include <wlr/types/wlr_data_device.h>
#include <wlr/types/wlr_export_dmabuf_v1.h>
#include <wlr/types/wlr_fractional_scale_v1.h>
#include <wlr/types/wlr_idle_inhibit_v1.h>
#include <wlr/types/wlr_idle_notify_v1.h>
#include <wlr/types/wlr_output_layout.h>
#include <wlr/types/wlr_pointer_constraints_v1.h>
#include <wlr/types/wlr_pointer_gestures_v1.h>
#include <wlr/types/wlr_presentation_time.h>
#include <wlr/types/wlr_primary_selection_v1.h>
#include <wlr/types/wlr_relative_pointer_v1.h>
#include <wlr/types/wlr_seat.h>
#include <wlr/types/wlr_single_pixel_buffer_v1.h>
#include <wlr/types/wlr_subcompositor.h>
#include <wlr/types/wlr_viewporter.h>
#include <wlr/types/wlr_xcursor_manager.h>
#include <wlr/types/wlr_xdg_activation_v1.h>
#include <wlr/types/wlr_xdg_output_v1.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

#include "content.h"
#include "input.h"
#include "link.h"
#include "render.h"
#include "server.h"
#include "stage.h"
#include "webnode.h"

extern char **environ;

struct options {
    const char *script;
    const char *socket;
    bool headless;
    int width, height;
    double run_for;
    bool xwayland;
    /* Screen sharing: 1 on, 0 off, -1 unless headless. */
    int screen_sharing;
    int outputs;
    bool damage_debug;
    bool once, dev;
};

static pid_t director_pid, setup_pid;

static void usage(void) {
    printf("Usage: proscenium [--script WORLD.tsx] [--socket PATH]\n"
           "                  [--headless [--size WxH] [--outputs N]] [--no-xwayland]\n"
           "                  [--screen-sharing | --no-screen-sharing] [--damage-debug]\n"
           "                  [--run-for SECONDS] [--once] [--dev]\n");
}

static bool parse_options(int argc, char **argv, struct options *options) {
    *options = (struct options){
        .width = 1280,
        .height = 720,
        .xwayland = true,
        .screen_sharing = -1,
        .outputs = 1,
    };
    static const struct option long_options[] = {
        {"script", required_argument, NULL, 's'},   {"socket", required_argument, NULL, 'S'},
        {"headless", no_argument, NULL, 'H'},       {"size", required_argument, NULL, 'z'},
        {"outputs", required_argument, NULL, 'O'},  {"run-for", required_argument, NULL, 'r'},
        {"no-xwayland", no_argument, NULL, 'X'},    {"no-screen-sharing", no_argument, NULL, 'P'},
        {"screen-sharing", no_argument, NULL, 'p'}, {"damage-debug", no_argument, NULL, 'd'},
        {"once", no_argument, NULL, 'o'},           {"dev", no_argument, NULL, 'D'},
        {"help", no_argument, NULL, 'h'},           {0},
    };
    int option;
    while ((option = getopt_long(argc, argv, "s:h", long_options, NULL)) != -1) {
        switch (option) {
        case 's': options->script = optarg; break;
        case 'S': options->socket = optarg; break;
        case 'H': options->headless = true; break;
        case 'z':
            if (sscanf(optarg, "%dx%d", &options->width, &options->height) != 2) return false;
            break;
        case 'O': options->outputs = CLAMP(atoi(optarg), 1, 8); break;
        case 'r': options->run_for = atof(optarg); break;
        case 'X': options->xwayland = false; break;
        case 'P': options->screen_sharing = false; break;
        case 'p': options->screen_sharing = true; break;
        case 'd': options->damage_debug = true; break;
        case 'o': options->once = true; break;
        case 'D': options->dev = true; break;
        default: return false;
        }
    }
    if (options->screen_sharing < 0) options->screen_sharing = !options->headless;
    /* Refuse a world that cannot load before taking the seat, not after. */
    struct stat st;
    if (options->script && (stat(options->script, &st) < 0 || !S_ISREG(st.st_mode))) {
        fprintf(stderr, "proscenium: %s is not a world file\n", options->script);
        return false;
    }
    return true;
}

/* The SDK's file RELATIVE: under $PROSCENIUM_SDK, else in the nearest sdk/ directory
 * above the executable, as in the source tree, else installed beside it. */
static char *sdk_path(const char *relative) {
    char *path;
    const char *sdk = getenv("PROSCENIUM_SDK");
    if (sdk && *sdk) return asprintf(&path, "%s/%s", sdk, relative) < 0 ? NULL : path;
    char self[4096];
    ssize_t length = readlink("/proc/self/exe", self, sizeof self - 1);
    if (length < 0) return NULL;
    self[length] = '\0';
    for (char *slash = strrchr(self, '/'); slash; slash = strrchr(self, '/')) {
        *slash = '\0';
        if (asprintf(&path, "%s/sdk/%s", self, relative) < 0) return NULL;
        if (access(path, R_OK) == 0) return path;
        free(path);
        if (asprintf(&path, "%s/share/proscenium/sdk/%s", self, relative) < 0) return NULL;
        if (access(path, R_OK) == 0) return path;
        free(path);
    }
    return NULL;
}

/* Start ARGV as a child with the signals the compositor blocks or ignores back to
 * their defaults; an errno value on failure. */
static int spawn_child(pid_t *pid, char *const argv[]) {
    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
    sigset_t defaults, mask;
    sigemptyset(&defaults);
    sigaddset(&defaults, SIGPIPE);
    sigemptyset(&mask);
    posix_spawnattr_setsigdefault(&attributes, &defaults);
    posix_spawnattr_setsigmask(&attributes, &mask);
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK);
    int error = posix_spawnp(pid, argv[0], NULL, &attributes, argv, environ);
    posix_spawnattr_destroy(&attributes);
    return error;
}

/* A session owning a seat points the desktop's portals and services at itself,
 * apart from the loop, as D-Bus may be slow. */
static void spawn_session_setup(void) {
    char *script = sdk_path("../scripts/setup-desktop-session");
    if (!script) return;
    char *argv[] = {"sh", script, NULL};
    if (spawn_child(&setup_pid, argv) != 0) {
        wlr_log(WLR_ERROR, "cannot run %s", script);
        setup_pid = 0;
    }
    free(script);
}

static void spawn_director(struct server *server, const struct options *options) {
    char *cli = sdk_path("bin/proscenium.mjs");
    char *script = realpath(options->script, NULL);
    if (!cli || !script) {
        if (!script)
            wlr_log(WLR_ERROR, "cannot start the director: %s: %s", options->script,
                    strerror(errno));
        else
            wlr_log(WLR_ERROR,
                    "cannot start the director: the SDK is missing (set PROSCENIUM_SDK)");
        free(cli);
        free(script);
        return;
    }
    char parent[32];
    snprintf(parent, sizeof parent, "%d", getpid());
    setenv("PROSCENIUM_SOCKET", link_path(server->link), 1);
    setenv("PROSCENIUM_PARENT", parent, 1);
    char *argv[8];
    int argc = 0;
    argv[argc++] = "node";
    argv[argc++] = "--enable-source-maps";
    argv[argc++] = cli;
    if (options->once) argv[argc++] = "--once";
    if (options->dev) argv[argc++] = "--dev";
    argv[argc++] = script;
    argv[argc] = NULL;
    int error = spawn_child(&director_pid, argv);
    if (error) {
        wlr_log(WLR_ERROR, "cannot start the director: %s", strerror(error));
        director_pid = 0;
    }
    free(cli);
    free(script);
}

static int handle_signal(int signal, void *data) {
    struct server *server = data;
    if (signal == SIGCHLD) {
        /* Only our own: the web helper and Xwayland have reapers of their own. */
        int status;
        if (director_pid > 0 && waitpid(director_pid, &status, WNOHANG) == director_pid) {
            wlr_log(WLR_INFO, "director exited with status %d", WEXITSTATUS(status));
            director_pid = 0;
        }
        if (setup_pid > 0 && waitpid(setup_pid, &status, WNOHANG) == setup_pid) setup_pid = 0;
        return 0;
    }
    wl_display_terminate(server->wl_display);
    return 0;
}

static int stop_after(void *data) {
    struct server *server = data;
    wl_display_terminate(server->wl_display);
    return 0;
}

bool server_gl_current(struct server *server) {
    struct wlr_egl *egl = wlr_gles2_renderer_get_egl(server->wlr_renderer);
    return eglMakeCurrent(wlr_egl_get_display(egl), EGL_NO_SURFACE, EGL_NO_SURFACE,
                          wlr_egl_get_context(egl));
}

static bool server_start(struct server *server, const struct options *options) {
    server->wl_display = wl_display_create();
    server->loop = wl_display_get_event_loop(server->wl_display);
    /* Teardown walks these whatever fails below. */
    wl_list_init(&server->outputs);
    wl_list_init(&server->windows);
    wl_list_init(&server->keyboards);
    wl_list_init(&server->xsurfaces);
    wl_list_init(&server->pages);
    server->damage_debug = options->damage_debug;
    server->check = getenv("PROSCENIUM_CHECK") && *getenv("PROSCENIUM_CHECK") == '1';
    server->screen_sharing = options->screen_sharing;
    snprintf(server->instance, sizeof server->instance, "%lx-%x", (long)time(NULL),
             (unsigned)(now_nanoseconds() ^ getpid()) & 0xffffff);

    if (options->headless) {
        server->backend = wlr_headless_backend_create(server->loop);
    } else {
        server->backend = wlr_backend_autocreate(server->loop, &server->session);
    }
    if (!server->backend) {
        wlr_log(WLR_ERROR, "no backend");
        return false;
    }
    server->wlr_renderer = wlr_renderer_autocreate(server->backend);
    if (!server->wlr_renderer || !wlr_renderer_is_gles2(server->wlr_renderer)) {
        wlr_log(WLR_ERROR, "proscenium needs the GLES2 renderer (WLR_RENDERER=gles2)");
        return false;
    }
    wlr_renderer_init_wl_display(server->wlr_renderer, server->wl_display);
    server->allocator = wlr_allocator_autocreate(server->backend, server->wlr_renderer);

    server->compositor = wlr_compositor_create(server->wl_display, 6, server->wlr_renderer);
    wlr_subcompositor_create(server->wl_display);
    wlr_data_device_manager_create(server->wl_display);
    wlr_primary_selection_v1_device_manager_create(server->wl_display);
    wlr_data_control_manager_v1_create(server->wl_display);
    wlr_viewporter_create(server->wl_display);
    wlr_fractional_scale_manager_v1_create(server->wl_display, 1);
    wlr_single_pixel_buffer_manager_v1_create(server->wl_display);
    wlr_alpha_modifier_v1_create(server->wl_display);
    wlr_presentation_create(server->wl_display, server->backend, 2);
    server->relative_pointer = wlr_relative_pointer_manager_v1_create(server->wl_display);
    server->pointer_constraints = wlr_pointer_constraints_v1_create(server->wl_display);
    server->pointer_gestures = wlr_pointer_gestures_v1_create(server->wl_display);
    wlr_idle_inhibit_v1_create(server->wl_display);
    wlr_idle_notifier_v1_create(server->wl_display);

    server->output_layout = wlr_output_layout_create(server->wl_display);
    wlr_xdg_output_manager_v1_create(server->wl_display, server->output_layout);
    idmap_init(&server->windows_by_id);
    idmap_init(&server->departed);
    server->next_window_id = 1;
    vec_init(&server->cameras, sizeof(struct node *));
    vec_init(&server->bindings, sizeof(struct node *));
    vec_init(&server->shortcuts, sizeof(struct node *));
    vec_init(&server->reserves, sizeof(struct node *));
    vec_init(&server->seat_state.history, sizeof(struct window *));
    scene_init(&server->scene);
    scene_init(&server->fallback);
    shaders_init(&server->shaders);
    server->scene.shaders = server->fallback.shaders = &server->shaders;
    server->scene.data = server->fallback.data = server;
    server->scene.natural_value = server->fallback.natural_value = stage_natural_value;
    server->scene.size = server->fallback.size = stage_node_size;
    server->scene.node_dead = server->fallback.node_dead = stage_node_dead;

    server->xdg_shell = wlr_xdg_shell_create(server->wl_display, 6);
    server->activation = wlr_xdg_activation_v1_create(server->wl_display);
    xdg_init(server);

    outputs_init(server);
    input_init(server);
    /* Only a headless session takes input from clients; a real seat's comes from its devices. */
    if (options->headless) input_enable_virtual_devices(server);
    clipboard_init(server);

    const char *socket = wl_display_add_socket_auto(server->wl_display);
    if (!socket) {
        wlr_log(WLR_ERROR, "no Wayland socket");
        return false;
    }
    server->socket = socket;
    setenv("WAYLAND_DISPLAY", socket, 1);

    if (options->xwayland) xwayland_init(server);

    char *path = NULL;
    if (options->socket) {
        path = xstrdup(options->socket);
    } else {
        const char *runtime = getenv("XDG_RUNTIME_DIR");
        if (!runtime) {
            wlr_log(WLR_ERROR, "set XDG_RUNTIME_DIR or pass --socket");
            return false;
        }
        if (asprintf(&path, "%s/proscenium-%d.sock", runtime, getpid()) < 0) return false;
    }
    server->link = link_create(server, path);
    free(path);
    if (!server->link) return false;

    if (!server_gl_current(server) || !(server->renderer = render_create())) {
        wlr_log(WLR_ERROR, "cannot set up the GLES renderer");
        return false;
    }
    content_init(server);

    if (!wlr_backend_start(server->backend)) {
        wlr_log(WLR_ERROR, "cannot start the backend");
        return false;
    }
    for (int i = 0; options->headless && i < options->outputs; i++)
        wlr_headless_add_output(server->backend, options->width, options->height);
    if (server->screen_sharing) share_init(server);
    return true;
}

static void free_shader_program(void *program) {
    render_shader_destroy(program);
}

static void server_finish(struct server *server) {
    share_finish(server);
    if (server->link) link_destroy(server->link);
    server->link = NULL;
    web_finish(server);
    wl_display_destroy_clients(server->wl_display);
    xwayland_finish(server);
    clipboard_finish(server);
    if (server->xdg_shell) xdg_finish(server);
    /* Outputs go with the backend while input, the scene and media they show remain. */
    if (server->new_output.link.next) outputs_finish(server);
    input_detach_backend(server);
    if (server->renderer) server_gl_current(server);
    if (server->backend) wlr_backend_destroy(server->backend);
    input_finish(server);
    scene_finish(&server->scene);
    scene_finish(&server->fallback);
    content_finish(server);
    if (server->renderer && server_gl_current(server)) {
        shaders_finish(&server->shaders, free_shader_program);
        render_destroy(server->renderer);
    } else {
        /* Without a context the programs cannot go, nor were any made without a renderer. */
        shaders_finish(&server->shaders, NULL);
    }
    if (server->xcursor_manager) wlr_xcursor_manager_destroy(server->xcursor_manager);
    if (server->cursor) wlr_cursor_destroy(server->cursor);
    if (server->allocator) wlr_allocator_destroy(server->allocator);
    if (server->wlr_renderer) wlr_renderer_destroy(server->wlr_renderer);
    wl_display_destroy(server->wl_display);
}

int main(int argc, char **argv) {
    struct options options;
    if (!parse_options(argc, argv, &options)) {
        usage();
        return 1;
    }
    wlr_log_init(getenv("PROSCENIUM_DEBUG") ? WLR_DEBUG : WLR_INFO, NULL);
    /* Writes to clients and children that went away fail instead of killing the compositor. */
    signal(SIGPIPE, SIG_IGN);
    /* The loop takes these through a signalfd; threads started from here on inherit
     * the mask, so none of them receives the signals instead. */
    sigset_t handled;
    sigemptyset(&handled);
    sigaddset(&handled, SIGINT);
    sigaddset(&handled, SIGTERM);
    sigaddset(&handled, SIGCHLD);
    pthread_sigmask(SIG_BLOCK, &handled, NULL);
    struct server server = {0};
    if (!server_start(&server, &options)) {
        server_finish(&server);
        return 1;
    }
    struct wl_event_source *signals[] = {
        wl_event_loop_add_signal(server.loop, SIGINT, handle_signal, &server),
        wl_event_loop_add_signal(server.loop, SIGTERM, handle_signal, &server),
        wl_event_loop_add_signal(server.loop, SIGCHLD, handle_signal, &server),
    };
    struct wl_event_source *deadline = NULL;
    if (options.run_for > 0) {
        deadline = wl_event_loop_add_timer(server.loop, stop_after, &server);
        wl_event_source_timer_update(deadline, (int)(options.run_for * 1000));
    }
    /* Portals pick their backends by desktop name. */
    setenv("XDG_CURRENT_DESKTOP", "proscenium", 1);
    if (server.session) spawn_session_setup();
    if (options.script) spawn_director(&server, &options);
    printf("[proscenium] WAYLAND_DISPLAY=%s PROSCENIUM_SOCKET=%s", server.socket,
           link_path(server.link));
    if (getenv("DISPLAY")) printf(" DISPLAY=%s", getenv("DISPLAY"));
    printf("\n");
    fflush(stdout);

    wl_display_run(server.wl_display);

    if (director_pid > 0) kill(director_pid, SIGTERM);
    if (deadline) wl_event_source_remove(deadline);
    for (size_t i = 0; i < ARRAY_LENGTH(signals); i++) wl_event_source_remove(signals[i]);
    server_finish(&server);
    return 0;
}
