/*
 * The screencast bridge on a private session bus: this program plays the portal
 * frontend over GDBus and the compositor through the public API. Run it as
 *
 *     dbus-run-session -- build/agent-screencast/test-screencast
 *
 * The PipeWire checks use the user's PipeWire daemon when one is reachable (it
 * listens on a socket, not the bus) and are skipped with a message otherwise.
 */
#define _GNU_SOURCE
#include "screencast.h"
/* Before GLib, which replaces util.h's MIN, MAX and CLAMP with its equivalent ones. */
#include "util.h"

#include <dirent.h>
#include <gio/gio.h>
#include <glib-unix.h>
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <stdio.h>
#include <unistd.h>

#define BACKEND SCREENCAST_BUS_NAME
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SCREEN_CAST "org.freedesktop.impl.portal.ScreenCast"
#define SESSION "org.freedesktop.impl.portal.Session"
#define REQUEST "org.freedesktop.impl.portal.Request"
#define APP "org.proscenium.Test"
#define WIDTH 64
#define HEIGHT 48

static int failures;

#define CHECK(condition, ...)                                                                      \
    do {                                                                                           \
        if (condition) {                                                                           \
            printf("PASS: ");                                                                      \
        } else {                                                                                   \
            printf("FAIL: ");                                                                      \
            failures++;                                                                            \
        }                                                                                          \
        printf(__VA_ARGS__);                                                                       \
        printf("\n");                                                                              \
        fflush(stdout);                                                                            \
    } while (0)

/* Main loop helpers. */

static gboolean expire(gpointer data) {
    *(bool *)data = true;
    return G_SOURCE_REMOVE;
}

/* Run the main context until *FLAG is set or MS milliseconds pass. */
static bool wait_flag(const bool *flag, unsigned ms) {
    bool expired = false;
    guint timer = g_timeout_add(ms, expire, &expired);
    while (!*flag && !expired) {
        g_main_context_iteration(NULL, TRUE);
    }
    if (!expired) {
        g_source_remove(timer);
    }
    return *flag;
}

static void spin(unsigned ms) {
    bool never = false;
    wait_flag(&never, ms);
}

/* The compositor's side: events drained from the bridge's fd. */

static struct screencast *bridge;
static struct screencast_event events[256];
static size_t event_count;

static gboolean bridge_readable(gint fd, GIOCondition condition, gpointer data) {
    struct screencast_event event;
    while (screencast_next_event(bridge, &event)) {
        if (event_count < ARRAY_LENGTH(events)) {
            events[event_count++] = event;
        }
    }
    return G_SOURCE_CONTINUE;
}

static const struct screencast_event *find_event(enum screencast_event_type type, uint32_t id) {
    for (size_t i = 0; i < event_count; i++) {
        if (events[i].type == type && (!id || events[i].id == id)) {
            return &events[i];
        }
    }
    return NULL;
}

static const struct screencast_event *wait_event(enum screencast_event_type type, uint32_t id,
                                                 unsigned ms) {
    double deadline = now_seconds() + ms / 1000.0;
    while (!find_event(type, id) && now_seconds() < deadline) {
        spin(10);
    }
    return find_event(type, id);
}

/* The frontend's side. */

static GDBusConnection *frontend, *client;
static char client_part[64];
static unsigned tokens;
static char closed_paths[64][128];
static size_t closed_count;

static GDBusConnection *connect_bus(void) {
    GError *error = NULL;
    char *address = g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SESSION, NULL, &error);
    GDBusConnection *bus = address ? g_dbus_connection_new_for_address_sync(
                                         address,
                                         G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                                             G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
                                         NULL, NULL, &error)
                                   : NULL;
    g_free(address);
    if (!bus) {
        fprintf(stderr, "no session bus: %s\n", error->message);
        exit(1);
    }
    return bus;
}

/* The application whose sessions the frontend asks for. */
static void connect_client(void) {
    client = connect_bus();
    /* Handles carry the client's unique name, ":1.42" as "1_42". */
    g_strlcpy(client_part, g_dbus_connection_get_unique_name(client) + 1, sizeof(client_part));
    for (char *p = client_part; *p; p++) {
        *p = *p == '.' ? '_' : *p;
    }
}

static void session_closed(GDBusConnection *bus, const char *sender, const char *path,
                           const char *interface, const char *signal, GVariant *parameters,
                           void *data) {
    if (closed_count < ARRAY_LENGTH(closed_paths)) {
        g_strlcpy(closed_paths[closed_count++], path, sizeof(closed_paths[0]));
    }
}

static bool was_closed(const char *path) {
    for (size_t i = 0; i < closed_count; i++) {
        if (!strcmp(closed_paths[i], path)) {
            return true;
        }
    }
    return false;
}

struct reply {
    bool done;
    GVariant *value;
    GError *error;
};

static void replied(GObject *source, GAsyncResult *result, gpointer data) {
    struct reply *reply = data;
    reply->value = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &reply->error);
    reply->done = true;
}

static void call_async(GDBusConnection *bus, const char *path, const char *interface,
                       const char *method, GVariant *arguments, struct reply *reply) {
    *reply = (struct reply){0};
    g_dbus_connection_call(bus, BACKEND, path, interface, method, arguments, NULL,
                           G_DBUS_CALL_FLAGS_NO_AUTO_START, 5000, NULL, replied, reply);
}

static void reply_finish(struct reply *reply) {
    g_clear_pointer(&reply->value, g_variant_unref);
    g_clear_error(&reply->error);
}

/* The response code of a portal method's reply, or -1 for an error; *RESULTS is the caller's. */
static int response_code(struct reply *reply, GVariant **results) {
    if (!reply->done || !reply->value) {
        return -1;
    }
    uint32_t code;
    GVariant *dictionary;
    g_variant_get(reply->value, "(u@a{sv})", &code, &dictionary);
    if (results) {
        *results = dictionary;
    } else {
        g_variant_unref(dictionary);
    }
    return code;
}

static int call_portal(GDBusConnection *bus, const char *method, GVariant *arguments,
                       struct reply *reply) {
    call_async(bus, PORTAL_PATH, SCREEN_CAST, method, arguments, reply);
    wait_flag(&reply->done, 5000);
    return response_code(reply, NULL);
}

static void make_path(char *path, size_t size, const char *kind) {
    snprintf(path, size, "/org/freedesktop/portal/desktop/%s/%s/t%u", kind, client_part, ++tokens);
}

static GVariant *empty_options(void) {
    return g_variant_new_array(G_VARIANT_TYPE("{sv}"), NULL, 0);
}

static int create_session(char *session, size_t size) {
    char request[128];
    make_path(request, sizeof(request), "request");
    make_path(session, size, "session");
    struct reply reply;
    int code =
        call_portal(frontend, "CreateSession",
                    g_variant_new("(oos@a{sv})", request, session, APP, empty_options()), &reply);
    reply_finish(&reply);
    return code;
}

static int select_sources(const char *session, uint32_t types, uint32_t cursor_mode) {
    char request[128];
    make_path(request, sizeof(request), "request");
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&options, "{sv}", "types", g_variant_new_uint32(types));
    g_variant_builder_add(&options, "{sv}", "cursor_mode", g_variant_new_uint32(cursor_mode));
    struct reply reply;
    int code = call_portal(frontend, "SelectSources",
                           g_variant_new("(oosa{sv})", request, session, APP, &options), &reply);
    reply_finish(&reply);
    return code;
}

static void start_async(const char *session, char *request, size_t size, struct reply *reply) {
    make_path(request, size, "request");
    call_async(frontend, PORTAL_PATH, SCREEN_CAST, "Start",
               g_variant_new("(ooss@a{sv})", request, session, APP, "", empty_options()), reply);
}

/* Whether PATH still exports INTERFACE, asked through its introspection data. */
static bool exported(const char *path, const char *interface) {
    GVariant *reply = g_dbus_connection_call_sync(
        frontend, BACKEND, path, "org.freedesktop.DBus.Introspectable", "Introspect", NULL,
        G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 5000, NULL, NULL);
    if (!reply) {
        return false;
    }
    const char *xml;
    g_variant_get(reply, "(&s)", &xml);
    bool found = strstr(xml, interface) != NULL;
    g_variant_unref(reply);
    return found;
}

static void close_object(const char *path, const char *interface) {
    GVariant *reply =
        g_dbus_connection_call_sync(frontend, BACKEND, path, interface, "Close", NULL, NULL,
                                    G_DBUS_CALL_FLAGS_NO_AUTO_START, 5000, NULL, NULL);
    if (reply) {
        g_variant_unref(reply);
    }
}

static bool name_has_owner(const char *name) {
    GVariant *reply = g_dbus_connection_call_sync(
        frontend, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "NameHasOwner", g_variant_new("(s)", name), G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NONE,
        5000, NULL, NULL);
    gboolean owned = FALSE;
    if (reply) {
        g_variant_get(reply, "(b)", &owned);
        g_variant_unref(reply);
    }
    return owned;
}

/* PipeWire, as a consumer of the shared stream. */

static struct pw_loop *pw_loop;
static guint pw_watch;
static struct pw_context *pw_context;
static struct pw_core *pw_core;
static struct pw_registry *registry;
static struct spa_hook registry_listener;
static uint32_t wanted_node = PW_ID_ANY;
static bool node_seen, node_removed;
static char node_class[64], node_serial[32];

static struct pw_stream *consumer;
static struct spa_hook consumer_listener;
static bool frame_seen, frame_correct;
static uint32_t frame_stride;

static gboolean pipewire_readable(gint fd, GIOCondition condition, gpointer data) {
    pw_loop_iterate(pw_loop, 0);
    return G_SOURCE_CONTINUE;
}

static bool pipewire_open(void) {
    pw_init(NULL, NULL);
    pw_loop = pw_loop_new(NULL);
    pw_loop_enter(pw_loop);
    pw_context = pw_context_new(pw_loop, pw_properties_new("module.rt", "false", NULL), 0);
    pw_core = pw_context ? pw_context_connect(pw_context, NULL, 0) : NULL;
    pw_watch = g_unix_fd_add(pw_loop_get_fd(pw_loop), G_IO_IN, pipewire_readable, NULL);
    return pw_core != NULL;
}

static void pipewire_close(void) {
    if (consumer) {
        spa_hook_remove(&consumer_listener);
        pw_stream_destroy(consumer);
        consumer = NULL;
    }
    if (registry) {
        spa_hook_remove(&registry_listener);
        pw_proxy_destroy((struct pw_proxy *)registry);
        registry = NULL;
    }
    if (pw_core) {
        pw_core_disconnect(pw_core);
        pw_core = NULL;
    }
    if (pw_context) {
        pw_context_destroy(pw_context);
        pw_context = NULL;
    }
    g_source_remove(pw_watch);
    pw_loop_leave(pw_loop);
    pw_loop_destroy(pw_loop);
    pw_loop = NULL;
}

static void registry_global(void *data, uint32_t id, uint32_t permissions, const char *type,
                            uint32_t version, const struct spa_dict *props) {
    if (id != wanted_node || strcmp(type, PW_TYPE_INTERFACE_Node) || !props) {
        return;
    }
    const char *class = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    const char *serial = spa_dict_lookup(props, PW_KEY_OBJECT_SERIAL);
    g_strlcpy(node_class, class ? class : "", sizeof(node_class));
    g_strlcpy(node_serial, serial ? serial : "", sizeof(node_serial));
    node_seen = true;
}

static void registry_global_remove(void *data, uint32_t id) {
    if (id == wanted_node) {
        node_removed = true;
    }
}

static const struct pw_registry_events registry_events = {
    PW_VERSION_REGISTRY_EVENTS,
    .global = registry_global,
    .global_remove = registry_global_remove,
};

static const uint8_t top_color[4] = {0x10, 0x80, 0xf0, 0xff};
static const uint8_t bottom_color[4] = {0xf0, 0x40, 0x20, 0xff};

static void consumer_process(void *data) {
    struct pw_buffer *buffer = pw_stream_dequeue_buffer(consumer);
    if (!buffer) {
        return;
    }
    struct spa_data *plane = &buffer->buffer->datas[0];
    if (plane->data && plane->chunk->size >= WIDTH * HEIGHT * 4) {
        const uint8_t *pixels = (const uint8_t *)plane->data + plane->chunk->offset;
        int32_t stride = plane->chunk->stride;
        frame_stride = stride;
        frame_correct =
            !memcmp(pixels, top_color, 4) && !memcmp(pixels + (WIDTH - 1) * 4, top_color, 4) &&
            !memcmp(pixels + (size_t)(HEIGHT - 1) * stride, bottom_color, 4) &&
            !memcmp(pixels + (size_t)(HEIGHT - 1) * stride + (WIDTH - 1) * 4, bottom_color, 4);
        frame_seen = true;
    }
    pw_stream_queue_buffer(consumer, buffer);
}

static const struct pw_stream_events consumer_events = {
    PW_VERSION_STREAM_EVENTS,
    .process = consumer_process,
};

static void consume(const char *serial) {
    consumer = pw_stream_new(pw_core, "Proscenium screencast test",
                             pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY,
                                               "Capture", PW_KEY_MEDIA_ROLE, "Screen",
                                               PW_KEY_TARGET_OBJECT, serial, NULL));
    pw_stream_add_listener(consumer, &consumer_listener, &consumer_events, NULL);
    uint8_t storage[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_pod *format = spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat, SPA_FORMAT_mediaType,
        SPA_POD_Id(SPA_MEDIA_TYPE_video), SPA_FORMAT_mediaSubtype,
        SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw), SPA_FORMAT_VIDEO_format,
        SPA_POD_Id(SPA_VIDEO_FORMAT_RGBA), SPA_FORMAT_VIDEO_size,
        SPA_POD_CHOICE_RANGE_Rectangle(&SPA_RECTANGLE(WIDTH, HEIGHT), &SPA_RECTANGLE(1, 1),
                                       &SPA_RECTANGLE(8192, 8192)),
        SPA_FORMAT_VIDEO_framerate,
        SPA_POD_CHOICE_RANGE_Fraction(&SPA_FRACTION(30, 1), &SPA_FRACTION(0, 1),
                                      &SPA_FRACTION(1000, 1)));
    pw_stream_connect(consumer, PW_DIRECTION_INPUT, PW_ID_ANY,
                      PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS, &format, 1);
}

/* Process state: idle means no wakeups and nothing left of PipeWire. */

/* Context switches so far of this process's threads named THREAD, or of all of them. */
static long context_switches(const char *thread) {
    long total = 0;
    DIR *tasks = opendir("/proc/self/task");
    for (struct dirent *task; tasks && (task = readdir(tasks));) {
        if (task->d_name[0] == '.') {
            continue;
        }
        char path[300], line[256];
        snprintf(path, sizeof(path), "/proc/self/task/%s/comm", task->d_name);
        FILE *comm = fopen(path, "r");
        bool named = comm && fgets(line, sizeof(line), comm) &&
                     !strncmp(line, thread ? thread : "", thread ? strlen(thread) : 0);
        if (comm) {
            fclose(comm);
        }
        if (!named) {
            continue;
        }
        snprintf(path, sizeof(path), "/proc/self/task/%s/status", task->d_name);
        FILE *status = fopen(path, "r");
        while (status && fgets(line, sizeof(line), status)) {
            long count;
            if (sscanf(line, "voluntary_ctxt_switches: %ld", &count) == 1 ||
                sscanf(line, "nonvoluntary_ctxt_switches: %ld", &count) == 1) {
                total += count;
            }
        }
        if (status) {
            fclose(status);
        }
    }
    if (tasks) {
        closedir(tasks);
    }
    return total;
}

static int count_tasks(void) {
    int count = 0;
    DIR *tasks = opendir("/proc/self/task");
    for (struct dirent *task; tasks && (task = readdir(tasks));) {
        count += task->d_name[0] != '.';
    }
    if (tasks) {
        closedir(tasks);
    }
    return count;
}

/* Open timerfds, eventfds and sockets, which a lingering PipeWire client would hold. */
static int count_fds(void) {
    int count = 0;
    DIR *fds = opendir("/proc/self/fd");
    for (struct dirent *fd; fds && (fd = readdir(fds));) {
        char path[300], target[256];
        snprintf(path, sizeof(path), "/proc/self/fd/%s", fd->d_name);
        ssize_t length = readlink(path, target, sizeof(target) - 1);
        if (length > 0) {
            target[length] = '\0';
            count += strstr(target, "timerfd") || strstr(target, "eventfd") ||
                     strstr(target, "socket:") || strstr(target, "eventpoll");
        }
    }
    if (fds) {
        closedir(fds);
    }
    return count;
}

static void make_frame(uint8_t *pixels) {
    for (int y = 0; y < HEIGHT; y++) {
        for (int x = 0; x < WIDTH; x++) {
            memcpy(pixels + ((size_t)y * WIDTH + x) * 4, y < HEIGHT / 2 ? top_color : bottom_color,
                   4);
        }
    }
}

/* Scenarios. */

static void test_properties(void) {
    GVariant *reply = g_dbus_connection_call_sync(
        frontend, BACKEND, PORTAL_PATH, "org.freedesktop.DBus.Properties", "GetAll",
        g_variant_new("(s)", SCREEN_CAST), G_VARIANT_TYPE("(a{sv})"),
        G_DBUS_CALL_FLAGS_NO_AUTO_START, 5000, NULL, NULL);
    uint32_t version = 0, sources = 0, cursors = 0;
    if (reply) {
        GVariant *properties = g_variant_get_child_value(reply, 0);
        g_variant_lookup(properties, "version", "u", &version);
        g_variant_lookup(properties, "AvailableSourceTypes", "u", &sources);
        g_variant_lookup(properties, "AvailableCursorModes", "u", &cursors);
        g_variant_unref(properties);
        g_variant_unref(reply);
    }
    CHECK(version == 3 && sources == 3 && cursors == 1,
          "ScreenCast properties: version %u, source types %u, cursor modes %u", version, sources,
          cursors);
}

static void test_access(void) {
    char request[128], session[128];
    make_path(request, sizeof(request), "request");
    make_path(session, sizeof(session), "session");
    struct reply reply;
    call_async(client, PORTAL_PATH, SCREEN_CAST, "CreateSession",
               g_variant_new("(oos@a{sv})", request, session, APP, empty_options()), &reply);
    wait_flag(&reply.done, 5000);
    CHECK(reply.error && g_dbus_error_is_remote_error(reply.error) &&
              strstr(reply.error->message, "AccessDenied"),
          "a caller other than the portal frontend is refused");
    reply_finish(&reply);
}

/* Share a monitor end to end; without PIPEWIRE only check that the share is refused. */
static void test_stream(bool pipewire) {
    char session[128], request[128];
    CHECK(create_session(session, sizeof(session)) == 0, "CreateSession succeeds");
    CHECK(exported(session, SESSION), "the session object is exported");
    CHECK(select_sources(session, SCREENCAST_MONITOR | SCREENCAST_WINDOW, 1) == 0,
          "SelectSources accepts monitors and windows with a hidden cursor");

    struct reply start;
    start_async(session, request, sizeof(request), &start);
    const struct screencast_event *event = wait_event(SCREENCAST_EVENT_REQUEST, 0, 5000);
    CHECK(event && event->sources == 3 && !strcmp(event->app, APP),
          "the compositor receives the request (sources %u, app \"%s\")",
          event ? event->sources : 0, event ? event->app : "");
    if (!event) {
        return;
    }
    uint32_t id = event->id;
    CHECK(exported(request, REQUEST), "the pending Start exports its Request object");
    CHECK(!start.done, "Start waits for the compositor's answer");

    uint8_t *pixels = xmalloc((size_t)WIDTH * HEIGHT * 4);
    make_frame(pixels);
    screencast_accept(bridge, id, SCREENCAST_MONITOR, 10, 20, WIDTH, HEIGHT);
    screencast_push_frame(bridge, id, &pixels, WIDTH, HEIGHT);
    wait_flag(&start.done, 5000);
    GVariant *results = NULL;
    int code = response_code(&start, &results);

    if (!pipewire) {
        CHECK(code == 1, "without PipeWire the share is refused (response %d)", code);
        CHECK(wait_event(SCREENCAST_EVENT_CLOSED, id, 2000) != NULL,
              "the compositor hears that the refused share closed");
        printf("SKIP: no PipeWire daemon is reachable; the D-Bus flow was checked, the stream "
               "checks were skipped\n");
        g_clear_pointer(&results, g_variant_unref);
        reply_finish(&start);
        free(pixels);
        return;
    }

    uint32_t node = PW_ID_ANY;
    int32_t width = 0, height = 0, x = 0, y = 0;
    uint32_t source = 0;
    GVariant *streams =
        results ? g_variant_lookup_value(results, "streams", G_VARIANT_TYPE("a(ua{sv})")) : NULL;
    if (streams && g_variant_n_children(streams) == 1) {
        GVariant *properties;
        g_variant_get_child(streams, 0, "(u@a{sv})", &node, &properties);
        g_variant_lookup(properties, "size", "(ii)", &width, &height);
        g_variant_lookup(properties, "position", "(ii)", &x, &y);
        g_variant_lookup(properties, "source_type", "u", &source);
        g_variant_unref(properties);
    }
    g_clear_pointer(&streams, g_variant_unref);
    g_clear_pointer(&results, g_variant_unref);
    CHECK(code == 0 && node != PW_ID_ANY && width == WIDTH && height == HEIGHT && x == 10 &&
              y == 20 && source == SCREENCAST_MONITOR,
          "Start returns stream node %u, %dx%d at %d,%d, source type %u", node, width, height, x, y,
          source);
    reply_finish(&start);
    CHECK(!exported(request, REQUEST), "the Request object goes once Start answered");

    wanted_node = node;
    registry = pw_core_get_registry(pw_core, PW_VERSION_REGISTRY, 0);
    pw_registry_add_listener(registry, &registry_listener, &registry_events, NULL);
    wait_flag(&node_seen, 3000);
    CHECK(node_seen && !strcmp(node_class, "Video/Source"), "PipeWire lists node %u as \"%s\"",
          node, node_class);

    if (node_seen) {
        consume(node_serial);
        /* The compositor repeats a still frame at its own pace; the stream sends it. */
        double deadline = now_seconds() + 5;
        while (!frame_correct && now_seconds() < deadline) {
            screencast_repeat_frame(bridge, id);
            spin(33);
        }
        CHECK(wait_event(SCREENCAST_EVENT_STREAMING, id, 1000) != NULL,
              "the compositor hears that a consumer streams");
        CHECK(frame_correct, "a consumer receives the pushed RGBA pixels, repeated (stride %u)",
              frame_stride);

        spa_hook_remove(&consumer_listener);
        pw_stream_destroy(consumer);
        consumer = NULL;
        const struct screencast_event *paused = wait_event(SCREENCAST_EVENT_PAUSED, id, 3000);
        CHECK(paused != NULL, "the compositor hears that the consumer left");
    }

    close_object(session, SESSION);
    CHECK(wait_event(SCREENCAST_EVENT_CLOSED, id, 2000) != NULL,
          "closing the session tells the compositor");
    spin(50);
    CHECK(was_closed(session), "the session emits Closed");
    CHECK(!exported(session, SESSION), "no session object is left behind");
    wait_flag(&node_removed, 3000);
    CHECK(node_removed, "the PipeWire node goes with the session");
    free(pixels);
}

/* A Start the compositor answers by refusing, or with a source the client did not allow. */
static void test_refusals(void) {
    for (int wrong_source = 0; wrong_source < 2; wrong_source++) {
        char session[128], request[128];
        create_session(session, sizeof(session));
        select_sources(session, SCREENCAST_WINDOW, 1);
        struct reply start;
        start_async(session, request, sizeof(request), &start);
        size_t before = event_count;
        const struct screencast_event *event = NULL;
        double deadline = now_seconds() + 5;
        while (!event && now_seconds() < deadline) {
            spin(10);
            for (size_t i = before; i < event_count; i++) {
                if (events[i].type == SCREENCAST_EVENT_REQUEST) {
                    event = &events[i];
                }
            }
        }
        if (!event) {
            CHECK(false, "the compositor receives a window request");
            continue;
        }
        uint32_t id = event->id;
        if (wrong_source) {
            screencast_accept(bridge, id, SCREENCAST_MONITOR, 0, 0, WIDTH, HEIGHT);
        } else {
            screencast_close(bridge, id);
        }
        wait_flag(&start.done, 5000);
        int code = response_code(&start, NULL);
        reply_finish(&start);
        CHECK(code == 1 && wait_event(SCREENCAST_EVENT_CLOSED, id, 2000) &&
                  !exported(session, SESSION),
              "%s cancels Start (response %d) and leaves no session",
              wrong_source ? "accepting a monitor for a window request" : "refusing", code);
    }
}

/* The frontend closes the Request while Start waits for the compositor. */
static void test_request_close(void) {
    char session[128], request[128];
    create_session(session, sizeof(session));
    select_sources(session, SCREENCAST_MONITOR, 1);
    struct reply start;
    size_t before = event_count;
    start_async(session, request, sizeof(request), &start);
    double deadline = now_seconds() + 5;
    while (event_count == before && now_seconds() < deadline) {
        spin(10);
    }
    uint32_t id = event_count > before ? events[before].id : 0;
    close_object(request, REQUEST);
    wait_flag(&start.done, 5000);
    int code = response_code(&start, NULL);
    reply_finish(&start);
    CHECK(id && code == 1 && wait_event(SCREENCAST_EVENT_CLOSED, id, 2000) &&
              !exported(session, SESSION),
          "Request.Close cancels Start (response %d) and leaves no session", code);
    /* The compositor's late answers to a closed share are ignored. */
    uint8_t *pixels = xcalloc((size_t)WIDTH * HEIGHT, 4);
    screencast_accept(bridge, id, SCREENCAST_MONITOR, 0, 0, WIDTH, HEIGHT);
    screencast_push_frame(bridge, id, &pixels, WIDTH, HEIGHT);
    screencast_repeat_frame(bridge, id);
    screencast_close(bridge, id);
    free(pixels);
    spin(50);
}

static void test_bad_selection(void) {
    char session[128];
    create_session(session, sizeof(session));
    int code = select_sources(session, SCREENCAST_MONITOR, 2);
    spin(20);
    CHECK(code == 2 && !exported(session, SESSION) && was_closed(session),
          "an unsupported cursor mode is refused (response %d) and closes the session", code);
    create_session(session, sizeof(session));
    code = select_sources(session, 4, 1);
    CHECK(code == 2 && !exported(session, SESSION),
          "an unsupported source type is refused (response %d)", code);
}

static void test_quota(void) {
    char sessions[33][128];
    int created = 0;
    for (int i = 0; i < 32; i++) {
        created += create_session(sessions[i], sizeof(sessions[i])) == 0;
    }
    int extra = create_session(sessions[32], sizeof(sessions[32]));
    CHECK(created == 32 && extra == 2, "one client prepares at most 32 sessions (%d, then %d)",
          created, extra);
    for (int i = 0; i < 32; i++) {
        close_object(sessions[i], SESSION);
    }
    char session[128];
    CHECK(create_session(session, sizeof(session)) == 0 && exported(session, SESSION),
          "closed sessions free the quota");
    close_object(session, SESSION);
}

/* The application leaves the bus: its prepared session ends with it. */
static void test_client_vanishes(void) {
    char session[128];
    create_session(session, sizeof(session));
    bool before = exported(session, SESSION);
    g_dbus_connection_close_sync(client, NULL, NULL);
    g_clear_object(&client);
    double deadline = now_seconds() + 3;
    while (exported(session, SESSION) && now_seconds() < deadline) {
        spin(20);
    }
    CHECK(before && !exported(session, SESSION), "a client leaving the bus closes its session");
}

int main(void) {
    const char *address = getenv("DBUS_SESSION_BUS_ADDRESS");
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    char user_bus[512];
    snprintf(user_bus, sizeof(user_bus), "unix:path=%s/bus", runtime ? runtime : "/run/user");
    if (!address || (runtime && strstr(address, user_bus))) {
        fprintf(stderr, "Run me on a private bus: dbus-run-session -- %s\n",
                "build/agent-screencast/test-screencast");
        return 2;
    }

    bridge = screencast_create();
    CHECK(bridge != NULL, "the bridge starts");
    if (!bridge) {
        return 1;
    }
    guint bridge_watch = g_unix_fd_add(screencast_get_fd(bridge), G_IO_IN, bridge_readable, NULL);

    frontend = connect_bus();
    connect_client();
    g_dbus_connection_signal_subscribe(frontend, NULL, SESSION, "Closed", NULL, NULL,
                                       G_DBUS_SIGNAL_FLAGS_NONE, session_closed, NULL, NULL);
    GVariant *owned = g_dbus_connection_call_sync(
        frontend, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "RequestName", g_variant_new("(su)", "org.freedesktop.portal.Desktop", 4u),
        G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 5000, NULL, NULL);
    g_clear_pointer(&owned, g_variant_unref);

    double deadline = now_seconds() + 5;
    while (!name_has_owner(BACKEND) && now_seconds() < deadline) {
        spin(10);
    }
    CHECK(name_has_owner(BACKEND), "the bridge owns %s", BACKEND);
    spin(100);
    int idle_tasks = count_tasks(), idle_fds = count_fds();

    test_properties();
    test_access();
    bool pipewire = pipewire_open();
    test_stream(pipewire);
    pipewire_close();
    test_refusals();
    test_request_close();
    test_bad_selection();
    test_quota();
    test_client_vanishes();

    /* With every share stopped the bridge holds no PipeWire client and never wakes. */
    connect_client();
    spin(200);
    CHECK(count_tasks() == idle_tasks && count_fds() == idle_fds,
          "stopping every share leaves no threads or fds behind (%d threads, %d fds; idle had "
          "%d, %d)",
          count_tasks(), count_fds(), idle_tasks, idle_fds);
    long switches = context_switches(NULL);
    spin(1000);
    switches = context_switches(NULL) - switches;
    CHECK(switches <= 4, "an idle bridge does not wake (%ld context switches in 1 s)", switches);
    /* Other applications joining and leaving the bus are none of an idle bridge's business. */
    switches = context_switches("screencast");
    for (int i = 0; i < 5; i++) {
        GDBusConnection *passer = connect_bus();
        g_dbus_connection_close_sync(passer, NULL, NULL);
        g_object_unref(passer);
    }
    spin(100);
    switches = context_switches("screencast") - switches;
    CHECK(switches == 0, "bus traffic does not wake an idle bridge (%ld context switches)",
          switches);

    /* Destroying the bridge closes what is still open and releases the name. */
    char session[128];
    create_session(session, sizeof(session));
    g_source_remove(bridge_watch);
    screencast_destroy(bridge);
    bridge = NULL;
    spin(100);
    CHECK(was_closed(session) && !name_has_owner(BACKEND),
          "destroying the bridge closes open sessions and releases the name");

    g_dbus_connection_close_sync(client, NULL, NULL);
    g_object_unref(client);
    g_dbus_connection_close_sync(frontend, NULL, NULL);
    g_object_unref(frontend);
    printf("%s: %d failure%s\n", failures ? "FAILED" : "OK", failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
