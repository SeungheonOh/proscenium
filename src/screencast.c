/*
 * The portal's ScreenCast backend and its PipeWire streams. Everything but the
 * public functions at the end runs on the bridge thread, which owns a
 * GMainContext, the bus connection and the PipeWire loop; the public functions
 * only queue commands and pop events under a short lock.
 */
#define _GNU_SOURCE
#include "screencast.h"
/* Before GLib, which replaces util.h's MIN, MAX and CLAMP with its equivalent ones. */
#include "util.h"

#include <errno.h>
#include <gio/gio.h>
#include <glib-unix.h>
#include <pipewire/pipewire.h>
#include <spa/param/buffers.h>
#include <spa/param/video/format-utils.h>
#include <sys/eventfd.h>
#include <unistd.h>
#include <wlr/util/log.h>

#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SESSION_PREFIX "/org/freedesktop/portal/desktop/session/"
#define FRONTEND "org.freedesktop.portal.Desktop"
#define SCREEN_CAST "org.freedesktop.impl.portal.ScreenCast"
#define SESSION "org.freedesktop.impl.portal.Session"
#define REQUEST "org.freedesktop.impl.portal.Request"

/* Portal response codes. */
enum { RESPONSE_SUCCESS, RESPONSE_CANCELLED, RESPONSE_OTHER };

/*
 * Browsers prepare sessions while enumerating sources; those hold no pixels or
 * streams, so they have their own quota, bounded per client, apart from streams.
 */
#define MAX_PREPARED 128
#define MAX_PREPARED_PER_CLIENT 32
#define MAX_STREAMS 8

enum command_type { COMMAND_ACCEPT, COMMAND_CLOSE, COMMAND_FRAME, COMMAND_REPEAT, COMMAND_QUIT };

struct command {
    enum command_type type;
    uint32_t id;
    enum screencast_source source;
    int32_t x, y;
    uint32_t width, height;
    /* COMMAND_FRAME: width * height * 4 bytes, tightly packed, from malloc. */
    uint8_t *pixels;
};

struct session {
    struct screencast *screencast;
    struct session *next;
    gint references;
    uint32_t id, types;
    enum screencast_source source;
    uint32_t width, height;
    int32_t x, y;
    /* Object path, the frontend that created it, the client it serves, the app. */
    char *path, *sender, *client, *app;
    guint registration, request_registration;
    /* STARTING once Start was called, STARTED once it was answered. */
    bool selected, closed, starting, started;
    /* Start, answered once the stream has a node or the session closes. */
    GDBusMethodInvocation *invocation;
    struct pw_stream *stream;
    struct spa_hook listener;
    /* The latest frame, width * height * 4 bytes, sent on every process. */
    uint8_t *pixels;
};

struct screencast {
    GThread *thread;
    GMainContext *context;
    GMainLoop *loop;
    /* Guards events, commands and spares. */
    GMutex lock;
    GQueue events, commands;
    /* Frame commands whose buffers come back for the next frame of their size. */
    GQueue spares;
    int event_fd, command_fd;

    /* The bridge thread's own. */
    GDBusConnection *bus;
    GDBusNodeInfo *info;
    guint registration, watch;
    GSource *commands_source, *pipewire_source;
    struct pw_loop *pw_loop;
    struct pw_context *pw_context;
    struct pw_core *core;
    struct session *sessions;
    uint32_t next_id;
};

static const char introspection[] =
    "<node>"
    "<interface name='" SCREEN_CAST "'>"
    "<property name='version' type='u' access='read'/>"
    "<property name='AvailableSourceTypes' type='u' access='read'/>"
    "<property name='AvailableCursorModes' type='u' access='read'/>"
    "<method name='CreateSession'>"
    "<arg type='o' direction='in'/><arg type='o' direction='in'/>"
    "<arg type='s' direction='in'/><arg type='a{sv}' direction='in'/>"
    "<arg type='u' direction='out'/><arg type='a{sv}' direction='out'/>"
    "</method>"
    "<method name='SelectSources'>"
    "<arg type='o' direction='in'/><arg type='o' direction='in'/>"
    "<arg type='s' direction='in'/><arg type='a{sv}' direction='in'/>"
    "<arg type='u' direction='out'/><arg type='a{sv}' direction='out'/>"
    "</method>"
    "<method name='Start'>"
    "<arg type='o' direction='in'/><arg type='o' direction='in'/>"
    "<arg type='s' direction='in'/><arg type='s' direction='in'/>"
    "<arg type='a{sv}' direction='in'/>"
    "<arg type='u' direction='out'/><arg type='a{sv}' direction='out'/>"
    "</method>"
    "</interface>"
    "<interface name='" SESSION "'>"
    "<property name='version' type='u' access='read'/>"
    "<method name='Close'/>"
    "<signal name='Closed'/>"
    "</interface>"
    "<interface name='" REQUEST "'><method name='Close'/></interface>"
    "</node>";

static void respond(GDBusMethodInvocation *invocation, uint32_t code) {
    GVariantBuilder results;
    g_variant_builder_init(&results, G_VARIANT_TYPE_VARDICT);
    g_dbus_method_invocation_return_value(invocation, g_variant_new("(ua{sv})", code, &results));
}

static struct session *session_ref(struct session *session) {
    g_atomic_int_inc(&session->references);
    return session;
}

static void session_unref(void *data) {
    struct session *session = data;
    if (!g_atomic_int_dec_and_test(&session->references)) {
        return;
    }
    free(session->path);
    free(session->sender);
    free(session->client);
    free(session->app);
    free(session->pixels);
    free(session);
}

static void post_event(struct session *session, enum screencast_event_type type) {
    struct screencast *screencast = session->screencast;
    struct screencast_event *event = xcalloc(1, sizeof(*event));
    event->type = type;
    event->id = session->id;
    event->sources = session->types;
    g_strlcpy(event->app, session->app, sizeof(event->app));
    g_mutex_lock(&screencast->lock);
    g_queue_push_tail(&screencast->events, event);
    g_mutex_unlock(&screencast->lock);
    if (eventfd_write(screencast->event_fd, 1) < 0 && errno != EAGAIN) {
        wlr_log_errno(WLR_ERROR, "Screen sharing could not notify the compositor");
    }
}

static void free_command(void *data) {
    struct command *command = data;
    free(command->pixels);
    free(command);
}

static void free_spares(struct screencast *screencast) {
    g_mutex_lock(&screencast->lock);
    g_queue_clear_full(&screencast->spares, free_command);
    g_mutex_unlock(&screencast->lock);
}

/* PipeWire is connected only while a stream exists, so an idle bridge holds no client. */
static void pipewire_disconnect(struct screencast *screencast) {
    if (screencast->pipewire_source) {
        g_source_destroy(screencast->pipewire_source);
        g_clear_pointer(&screencast->pipewire_source, g_source_unref);
    }
    if (screencast->core) {
        pw_core_disconnect(screencast->core);
        screencast->core = NULL;
    }
    if (screencast->pw_context) {
        pw_context_destroy(screencast->pw_context);
        screencast->pw_context = NULL;
    }
    if (screencast->pw_loop) {
        pw_loop_leave(screencast->pw_loop);
        pw_loop_destroy(screencast->pw_loop);
        screencast->pw_loop = NULL;
    }
}

static gboolean pipewire_ready(gint fd, GIOCondition condition, gpointer data) {
    struct screencast *screencast = data;
    pw_loop_iterate(screencast->pw_loop, 0);
    return G_SOURCE_CONTINUE;
}

static bool pipewire_connect(struct screencast *screencast) {
    if (screencast->core) {
        return true;
    }
    screencast->pw_loop = pw_loop_new(NULL);
    if (screencast->pw_loop) {
        pw_loop_enter(screencast->pw_loop);
        /* A 30 fps share needs no realtime threads, and module-rt leaks on each unload. */
        screencast->pw_context =
            pw_context_new(screencast->pw_loop, pw_properties_new("module.rt", "false", NULL), 0);
    }
    if (screencast->pw_context) {
        screencast->core = pw_context_connect(screencast->pw_context, NULL, 0);
    }
    if (!screencast->core) {
        wlr_log(WLR_ERROR, "Screen sharing cannot reach PipeWire");
        pipewire_disconnect(screencast);
        return false;
    }
    screencast->pipewire_source =
        g_unix_fd_source_new(pw_loop_get_fd(screencast->pw_loop), G_IO_IN);
    g_source_set_callback(screencast->pipewire_source, G_SOURCE_FUNC(pipewire_ready), screencast,
                          NULL);
    g_source_attach(screencast->pipewire_source, screencast->context);
    return true;
}

static void name_owner_changed(GDBusConnection *bus, const char *sender, const char *path,
                               const char *interface, const char *signal, GVariant *parameters,
                               void *data);

/*
 * Sessions end with their client or frontend. Leaving the bus is only watched
 * while a session exists, so other applications' comings and goings never wake
 * an idle bridge.
 */
static void watch_names(struct screencast *screencast, bool watch) {
    if (watch && !screencast->watch) {
        screencast->watch = g_dbus_connection_signal_subscribe(
            screencast->bus, "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
            "/org/freedesktop/DBus", NULL, G_DBUS_SIGNAL_FLAGS_NONE, name_owner_changed, screencast,
            NULL);
    } else if (!watch && screencast->watch) {
        g_dbus_connection_signal_unsubscribe(screencast->bus, screencast->watch);
        screencast->watch = 0;
    }
}

static struct session *find_session(struct screencast *screencast, uint32_t id) {
    for (struct session *session = screencast->sessions; session; session = session->next) {
        if (session->id == id) {
            return session;
        }
    }
    return NULL;
}

static void close_session(struct session *session) {
    if (session->closed) {
        return;
    }
    struct screencast *screencast = session->screencast;
    session->closed = true;
    if (session->invocation) {
        respond(session->invocation, RESPONSE_CANCELLED);
        session->invocation = NULL;
    }
    if (session->stream) {
        spa_hook_remove(&session->listener);
        pw_stream_destroy(session->stream);
        session->stream = NULL;
    }
    g_clear_pointer(&session->pixels, free);
    if (session->request_registration) {
        g_dbus_connection_unregister_object(screencast->bus, session->request_registration);
        session->request_registration = 0;
    }
    if (session->registration) {
        g_dbus_connection_emit_signal(screencast->bus, session->sender, session->path, SESSION,
                                      "Closed", NULL, NULL);
        g_dbus_connection_unregister_object(screencast->bus, session->registration);
        session->registration = 0;
    }
    /* The owner only knows sessions that asked to start. */
    if (session->starting) {
        post_event(session, SCREENCAST_EVENT_CLOSED);
    }
    /*
     * Calls GDBus has queued keep the session alive through each registration's
     * destroy notifier; commands carry ids, so the list's reference can go now.
     */
    for (struct session **link = &screencast->sessions; *link; link = &(*link)->next) {
        if (*link == session) {
            *link = session->next;
            session_unref(session);
            break;
        }
    }
    if (!screencast->sessions) {
        watch_names(screencast, false);
    }
    for (struct session *other = screencast->sessions; other; other = other->next) {
        if (other->stream) {
            return;
        }
    }
    pipewire_disconnect(screencast);
    free_spares(screencast);
}

static gboolean close_now(gpointer data) {
    close_session(data);
    return G_SOURCE_REMOVE;
}

/* A stream must not be destroyed from its own callbacks, so a failure closes from an idle. */
static void close_later(struct session *session) {
    GSource *source = g_idle_source_new();
    g_source_set_callback(source, close_now, session_ref(session), session_unref);
    g_source_attach(source, session->screencast->context);
    g_source_unref(source);
}

static GVariant *get_property(GDBusConnection *bus, const char *sender, const char *path,
                              const char *interface, const char *name, GError **error, void *data) {
    if (!strcmp(name, "version")) {
        return g_variant_new_uint32(!strcmp(interface, SCREEN_CAST) ? 3 : 1);
    }
    if (!strcmp(name, "AvailableSourceTypes")) {
        return g_variant_new_uint32(SCREENCAST_MONITOR | SCREENCAST_WINDOW);
    }
    /* AvailableCursorModes: hidden only. */
    return g_variant_new_uint32(1);
}

/* Session.Close and Request.Close: either ends the session. */
static void close_method(GDBusConnection *bus, const char *sender, const char *path,
                         const char *interface, const char *method, GVariant *parameters,
                         GDBusMethodInvocation *invocation, void *data) {
    struct session *session = data;
    if (strcmp(sender, session->sender)) {
        g_dbus_method_invocation_return_error_literal(
            invocation, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED, "Session owner required");
        return;
    }
    close_session(session);
    g_dbus_method_invocation_return_value(invocation, NULL);
}

static const GDBusInterfaceVTable close_vtable = {
    .method_call = close_method,
    .get_property = get_property,
};

/* Only the portal frontend may drive the backend; it checked the application's request. */
static bool from_frontend(struct screencast *screencast, const char *sender) {
    GVariant *reply = g_dbus_connection_call_sync(
        screencast->bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "GetNameOwner", g_variant_new("(s)", FRONTEND), G_VARIANT_TYPE("(s)"),
        G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL);
    if (!reply) {
        return false;
    }
    const char *owner;
    g_variant_get(reply, "(&s)", &owner);
    bool ok = !strcmp(sender, owner);
    g_variant_unref(reply);
    return ok;
}

/*
 * The application's unique bus name, which the trusted frontend embeds in the
 * session path (`.../session/1_42/token` for `:1.42`); the method's sender is the
 * frontend, not the application.
 */
static char *session_client(const char *handle) {
    if (!g_str_has_prefix(handle, SESSION_PREFIX)) {
        return NULL;
    }
    const char *begin = handle + strlen(SESSION_PREFIX);
    const char *end = strchr(begin, '/');
    if (!end || end == begin) {
        return NULL;
    }
    char *client = xcalloc(1, end - begin + 2);
    client[0] = ':';
    memcpy(client + 1, begin, end - begin);
    for (char *p = client; *p; p++) {
        if (*p == '_') {
            *p = '.';
        }
    }
    if (!g_dbus_is_unique_name(client)) {
        free(client);
        return NULL;
    }
    return client;
}

static void create_session(struct screencast *screencast, GDBusMethodInvocation *invocation,
                           const char *sender, const char *handle, const char *app,
                           const char *client) {
    struct session *session = xcalloc(1, sizeof(*session));
    session->references = 1;
    session->screencast = screencast;
    session->id = ++screencast->next_id;
    session->types = SCREENCAST_MONITOR;
    session->path = xstrdup(handle);
    session->sender = xstrdup(sender);
    session->client = xstrdup(client);
    session->app = xstrdup(app);
    watch_names(screencast, true);
    session->next = screencast->sessions;
    screencast->sessions = session;
    /* On failure GDBus drops the reference it was given. */
    session->registration =
        g_dbus_connection_register_object(screencast->bus, handle, screencast->info->interfaces[1],
                                          &close_vtable, session_ref(session), session_unref, NULL);
    if (!session->registration) {
        close_session(session);
        respond(invocation, RESPONSE_OTHER);
        return;
    }
    GVariantBuilder results;
    g_variant_builder_init(&results, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&results, "{sv}", "session_id", g_variant_new_string(handle));
    g_dbus_method_invocation_return_value(invocation,
                                          g_variant_new("(ua{sv})", RESPONSE_SUCCESS, &results));
}

static void select_sources(struct session *session, GDBusMethodInvocation *invocation,
                           GVariant *options) {
    uint32_t types = SCREENCAST_MONITOR, cursor_mode = 1;
    g_variant_lookup(options, "types", "u", &types);
    g_variant_lookup(options, "cursor_mode", "u", &cursor_mode);
    uint32_t known = SCREENCAST_MONITOR | SCREENCAST_WINDOW;
    if (session->selected || !(types & known) || (types & ~known) || cursor_mode != 1) {
        respond(invocation, RESPONSE_OTHER);
        close_session(session);
        return;
    }
    session->types = types;
    session->selected = true;
    respond(invocation, RESPONSE_SUCCESS);
}

static void start(struct session *session, GDBusMethodInvocation *invocation, const char *request,
                  unsigned streams) {
    struct screencast *screencast = session->screencast;
    if (streams >= MAX_STREAMS) {
        respond(invocation, RESPONSE_OTHER);
        close_session(session);
        return;
    }
    session->request_registration =
        g_dbus_connection_register_object(screencast->bus, request, screencast->info->interfaces[2],
                                          &close_vtable, session_ref(session), session_unref, NULL);
    if (!session->request_registration) {
        respond(invocation, RESPONSE_OTHER);
        return;
    }
    session->starting = true;
    session->invocation = invocation;
    post_event(session, SCREENCAST_EVENT_REQUEST);
}

static void portal_method(GDBusConnection *bus, const char *sender, const char *path,
                          const char *interface, const char *name, GVariant *parameters,
                          GDBusMethodInvocation *invocation, void *data) {
    struct screencast *screencast = data;
    if (!from_frontend(screencast, sender)) {
        g_dbus_method_invocation_return_error_literal(
            invocation, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED, "Desktop portal required");
        return;
    }
    const char *request, *handle, *app, *parent;
    GVariant *options;
    bool starting = !strcmp(name, "Start");
    if (starting) {
        g_variant_get(parameters, "(&o&o&s&s@a{sv})", &request, &handle, &app, &parent, &options);
    } else {
        g_variant_get(parameters, "(&o&o&s@a{sv})", &request, &handle, &app, &options);
    }

    char *client = session_client(handle);
    struct session *session = NULL;
    unsigned prepared = 0, client_prepared = 0, streams = 0;
    for (struct session *other = screencast->sessions; other; other = other->next) {
        if (other->closed) {
            continue;
        }
        if (other->starting) {
            streams++;
        } else {
            prepared++;
            if (client && !g_strcmp0(client, other->client)) {
                client_prepared++;
            }
        }
        if (!strcmp(other->path, handle)) {
            session = other;
        }
    }

    if (!strcmp(name, "CreateSession")) {
        if (session || !client || prepared >= MAX_PREPARED ||
            client_prepared >= MAX_PREPARED_PER_CLIENT) {
            respond(invocation, RESPONSE_OTHER);
        } else {
            create_session(screencast, invocation, sender, handle, app, client);
        }
    } else if (!session || strcmp(session->sender, sender) || strcmp(session->app, app) ||
               session->starting) {
        respond(invocation, RESPONSE_OTHER);
    } else if (!strcmp(name, "SelectSources")) {
        select_sources(session, invocation, options);
    } else if (starting && session->selected) {
        start(session, invocation, request, streams);
    } else {
        respond(invocation, RESPONSE_OTHER);
    }
    free(client);
    g_variant_unref(options);
}

static const GDBusInterfaceVTable portal_vtable = {
    .method_call = portal_method,
    .get_property = get_property,
};

static void stream_state_changed(void *data, enum pw_stream_state old, enum pw_stream_state state,
                                 const char *error) {
    struct session *session = data;
    if (session->closed) {
        return;
    }
    if (state == PW_STREAM_STATE_ERROR ||
        (state == PW_STREAM_STATE_UNCONNECTED && old != PW_STREAM_STATE_UNCONNECTED)) {
        wlr_log(WLR_ERROR, "Screen sharing stream %u ended: %s", session->id,
                error ? error : "disconnected");
        close_later(session);
        return;
    }
    if (state == PW_STREAM_STATE_PAUSED && session->invocation) {
        uint32_t node = pw_stream_get_node_id(session->stream);
        if (node == PW_ID_ANY) {
            return;
        }
        GVariantBuilder properties, streams, results;
        g_variant_builder_init(&properties, G_VARIANT_TYPE_VARDICT);
        g_variant_builder_add(&properties, "{sv}", "size",
                              g_variant_new("(ii)", session->width, session->height));
        g_variant_builder_add(&properties, "{sv}", "source_type",
                              g_variant_new_uint32(session->source));
        if (session->source == SCREENCAST_MONITOR) {
            g_variant_builder_add(&properties, "{sv}", "position",
                                  g_variant_new("(ii)", session->x, session->y));
        }
        g_variant_builder_init(&streams, G_VARIANT_TYPE("a(ua{sv})"));
        g_variant_builder_add(&streams, "(ua{sv})", node, &properties);
        g_variant_builder_init(&results, G_VARIANT_TYPE_VARDICT);
        g_variant_builder_add(&results, "{sv}", "streams", g_variant_builder_end(&streams));
        g_dbus_method_invocation_return_value(
            session->invocation, g_variant_new("(ua{sv})", RESPONSE_SUCCESS, &results));
        session->invocation = NULL;
        if (session->request_registration) {
            g_dbus_connection_unregister_object(session->screencast->bus,
                                                session->request_registration);
            session->request_registration = 0;
        }
        session->started = true;
        return;
    }
    if (!session->started) {
        return;
    }
    if (state == PW_STREAM_STATE_STREAMING) {
        post_event(session, SCREENCAST_EVENT_STREAMING);
    } else if (state == PW_STREAM_STATE_PAUSED && old == PW_STREAM_STATE_STREAMING) {
        post_event(session, SCREENCAST_EVENT_PAUSED);
    }
}

static void stream_param_changed(void *data, uint32_t id, const struct spa_pod *param) {
    struct session *session = data;
    if (!param || id != SPA_PARAM_Format) {
        return;
    }
    uint8_t storage[256];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_pod *buffers = spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers, SPA_PARAM_BUFFERS_buffers,
        SPA_POD_CHOICE_RANGE_Int(4, 2, 8), SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_size, SPA_POD_Int(session->width * session->height * 4),
        SPA_PARAM_BUFFERS_stride, SPA_POD_Int(session->width * 4), SPA_PARAM_BUFFERS_dataType,
        SPA_POD_CHOICE_FLAGS_Int(1 << SPA_DATA_MemFd));
    pw_stream_update_params(session->stream, &buffers, 1);
}

static void stream_process(void *data) {
    struct session *session = data;
    struct pw_buffer *buffer = pw_stream_dequeue_buffer(session->stream);
    if (!buffer) {
        return;
    }
    struct spa_data *plane = buffer->buffer->n_datas ? &buffer->buffer->datas[0] : NULL;
    size_t size = (size_t)session->width * session->height * 4;
    if (plane && plane->data && plane->chunk && plane->maxsize >= size && session->pixels) {
        memcpy(plane->data, session->pixels, size);
        plane->chunk->offset = 0;
        plane->chunk->stride = session->width * 4;
        plane->chunk->size = size;
    } else if (plane && plane->chunk) {
        plane->chunk->size = 0;
    }
    pw_stream_queue_buffer(session->stream, buffer);
}

static const struct pw_stream_events stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = stream_state_changed,
    .param_changed = stream_param_changed,
    .process = stream_process,
};

static void accept_session(struct session *session, const struct command *command) {
    struct screencast *screencast = session->screencast;
    if (!session->starting || session->stream ||
        (command->source != SCREENCAST_MONITOR && command->source != SCREENCAST_WINDOW) ||
        !(session->types & command->source) || !command->width || !command->height ||
        command->width > SCREENCAST_MAX_WIDTH || command->height > SCREENCAST_MAX_HEIGHT ||
        !pipewire_connect(screencast)) {
        close_session(session);
        return;
    }
    session->source = command->source;
    session->width = command->width;
    session->height = command->height;
    session->x = command->x;
    session->y = command->y;
    session->pixels = xcalloc((size_t)session->width * session->height, 4);
    session->stream = pw_stream_new(
        screencast->core, "Proscenium screen sharing",
        pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture",
                          PW_KEY_MEDIA_ROLE, "Screen", PW_KEY_MEDIA_CLASS, "Video/Source",
                          PW_KEY_NODE_DESCRIPTION, "Proscenium selected source", NULL));
    if (!session->stream) {
        close_session(session);
        return;
    }
    pw_stream_add_listener(session->stream, &session->listener, &stream_events, session);
    uint8_t storage[512];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    struct spa_video_info_raw video = {
        .format = SPA_VIDEO_FORMAT_RGBA,
        .size = SPA_RECTANGLE(session->width, session->height),
        .framerate = SPA_FRACTION(30, 1),
    };
    const struct spa_pod *format =
        spa_format_video_raw_build(&builder, SPA_PARAM_EnumFormat, &video);
    if (pw_stream_connect(session->stream, PW_DIRECTION_OUTPUT, PW_ID_ANY,
                          PW_STREAM_FLAG_DRIVER | PW_STREAM_FLAG_MAP_BUFFERS, &format, 1) < 0) {
        close_session(session);
    }
}

/* A frame command whose buffer the session took in exchange for its old one, of the same size. */
static void keep_spare(struct screencast *screencast, struct command *command) {
    g_mutex_lock(&screencast->lock);
    if (screencast->spares.length < MAX_STREAMS) {
        g_queue_push_tail(&screencast->spares, command);
        command = NULL;
    }
    g_mutex_unlock(&screencast->lock);
    if (command) {
        free_command(command);
    }
}

static void run_command(struct screencast *screencast, struct command *command) {
    struct session *session = find_session(screencast, command->id);
    if (!session || session->closed) {
        free_command(command);
        return;
    }
    switch (command->type) {
    case COMMAND_ACCEPT: accept_session(session, command); break;
    case COMMAND_CLOSE: close_session(session); break;
    case COMMAND_FRAME:
        if (session->pixels && command->width == session->width &&
            command->height == session->height) {
            uint8_t *previous = session->pixels;
            session->pixels = command->pixels;
            command->pixels = previous;
            if (session->stream) {
                pw_stream_trigger_process(session->stream);
            }
            keep_spare(screencast, command);
            return;
        }
        break;
    case COMMAND_REPEAT:
        if (session->stream) {
            pw_stream_trigger_process(session->stream);
        }
        break;
    case COMMAND_QUIT: break;
    }
    free_command(command);
}

static gboolean commands_ready(gint fd, GIOCondition condition, gpointer data) {
    struct screencast *screencast = data;
    eventfd_t count;
    eventfd_read(fd, &count);
    for (;;) {
        g_mutex_lock(&screencast->lock);
        struct command *command = g_queue_pop_head(&screencast->commands);
        g_mutex_unlock(&screencast->lock);
        if (!command) {
            break;
        }
        if (command->type == COMMAND_QUIT) {
            free_command(command);
            g_main_loop_quit(screencast->loop);
            break;
        }
        run_command(screencast, command);
    }
    return G_SOURCE_CONTINUE;
}

static void name_owner_changed(GDBusConnection *bus, const char *sender, const char *path,
                               const char *interface, const char *signal, GVariant *parameters,
                               void *data) {
    struct screencast *screencast = data;
    const char *name, *old_owner, *new_owner;
    g_variant_get(parameters, "(&s&s&s)", &name, &old_owner, &new_owner);
    if (!*old_owner || *new_owner) {
        return;
    }
    for (struct session *session = screencast->sessions, *next; session; session = next) {
        next = session->next;
        if (!strcmp(session->sender, name) || !g_strcmp0(session->client, name)) {
            close_session(session);
        }
    }
}

/*
 * Connect to the session bus, export the portal object and claim the name. A
 * private connection, unlike the shared one, does not end the compositor when
 * the bus goes away.
 */
static bool serve(struct screencast *screencast) {
    GError *error = NULL;
    char *address = g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (address) {
        screencast->bus = g_dbus_connection_new_for_address_sync(
            address,
            G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
            NULL, NULL, &error);
        g_free(address);
    }
    if (!screencast->bus) {
        wlr_log(WLR_ERROR, "Screen sharing has no session bus: %s", error->message);
        g_error_free(error);
        return false;
    }
    screencast->info = g_dbus_node_info_new_for_xml(introspection, NULL);
    screencast->registration = g_dbus_connection_register_object(
        screencast->bus, PORTAL_PATH, screencast->info->interfaces[0], &portal_vtable, screencast,
        NULL, &error);
    if (!screencast->registration) {
        wlr_log(WLR_ERROR, "Screen sharing could not export the portal: %s", error->message);
        g_error_free(error);
        return false;
    }
    /* DBUS_NAME_FLAG_DO_NOT_QUEUE; 1 is DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER. */
    GVariant *reply = g_dbus_connection_call_sync(
        screencast->bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "RequestName", g_variant_new("(su)", SCREENCAST_BUS_NAME, 4u), G_VARIANT_TYPE("(u)"),
        G_DBUS_CALL_FLAGS_NONE, 3000, NULL, &error);
    uint32_t result = 0;
    if (reply) {
        g_variant_get(reply, "(u)", &result);
        g_variant_unref(reply);
    }
    if (result != 1) {
        wlr_log(WLR_ERROR, "Screen sharing could not own %s: %s", SCREENCAST_BUS_NAME,
                error ? error->message : "owned by another process");
        g_clear_error(&error);
        return false;
    }
    wlr_log(WLR_INFO, "Screen sharing serves %s", SCREENCAST_BUS_NAME);
    return true;
}

static gpointer run(gpointer data) {
    struct screencast *screencast = data;
    g_main_context_push_thread_default(screencast->context);
    screencast->commands_source = g_unix_fd_source_new(screencast->command_fd, G_IO_IN);
    g_source_set_callback(screencast->commands_source, G_SOURCE_FUNC(commands_ready), screencast,
                          NULL);
    g_source_attach(screencast->commands_source, screencast->context);
    if (serve(screencast)) {
        g_main_loop_run(screencast->loop);
    }

    g_source_destroy(screencast->commands_source);
    g_clear_pointer(&screencast->commands_source, g_source_unref);
    while (screencast->sessions) {
        close_session(screencast->sessions);
    }
    pipewire_disconnect(screencast);
    if (screencast->bus) {
        if (screencast->registration) {
            g_dbus_connection_unregister_object(screencast->bus, screencast->registration);
        }
        /* Answers and Closed signals reach the bus before the name goes. */
        g_dbus_connection_flush_sync(screencast->bus, NULL, NULL);
        g_dbus_connection_close_sync(screencast->bus, NULL, NULL);
        g_clear_object(&screencast->bus);
    }
    /* GDBus releases registrations' data from idles in this context. */
    while (g_main_context_iteration(screencast->context, FALSE)) {
    }
    g_clear_pointer(&screencast->info, g_dbus_node_info_unref);
    g_main_context_pop_thread_default(screencast->context);
    return NULL;
}

static void enqueue(struct screencast *screencast, struct command *command) {
    g_mutex_lock(&screencast->lock);
    /* A newer frame replaces one the bridge has not taken yet, and a repeat is moot
     * behind either. */
    if (command->type == COMMAND_FRAME || command->type == COMMAND_REPEAT) {
        for (GList *link = screencast->commands.head; link; link = link->next) {
            struct command *queued = link->data;
            if ((queued->type == COMMAND_FRAME || queued->type == COMMAND_REPEAT) &&
                queued->id == command->id) {
                struct command *dropped = command;
                if (command->type == COMMAND_FRAME) {
                    link->data = command;
                    dropped = queued;
                }
                /* A frame dropped keeps its pixels for the next one. */
                if (dropped->type == COMMAND_FRAME && screencast->spares.length < MAX_STREAMS) {
                    g_queue_push_tail(&screencast->spares, dropped);
                    dropped = NULL;
                }
                g_mutex_unlock(&screencast->lock);
                if (dropped) free_command(dropped);
                return;
            }
        }
    }
    g_queue_push_tail(&screencast->commands, command);
    g_mutex_unlock(&screencast->lock);
    if (eventfd_write(screencast->command_fd, 1) < 0 && errno != EAGAIN) {
        wlr_log_errno(WLR_ERROR, "Screen sharing could not notify its thread");
    }
}

struct screencast *screencast_create(void) {
    pw_init(NULL, NULL);
    struct screencast *screencast = xcalloc(1, sizeof(*screencast));
    g_mutex_init(&screencast->lock);
    g_queue_init(&screencast->events);
    g_queue_init(&screencast->commands);
    g_queue_init(&screencast->spares);
    screencast->event_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    screencast->command_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (screencast->event_fd < 0 || screencast->command_fd < 0) {
        wlr_log_errno(WLR_ERROR, "Screen sharing could not start");
        screencast_destroy(screencast);
        return NULL;
    }
    screencast->context = g_main_context_new();
    screencast->loop = g_main_loop_new(screencast->context, FALSE);
    GError *error = NULL;
    screencast->thread = g_thread_try_new("screencast", run, screencast, &error);
    if (!screencast->thread) {
        wlr_log(WLR_ERROR, "Screen sharing could not start: %s", error->message);
        g_error_free(error);
        screencast_destroy(screencast);
        return NULL;
    }
    return screencast;
}

void screencast_destroy(struct screencast *screencast) {
    if (!screencast) {
        return;
    }
    if (screencast->thread) {
        struct command *quit = xcalloc(1, sizeof(*quit));
        quit->type = COMMAND_QUIT;
        enqueue(screencast, quit);
        g_thread_join(screencast->thread);
    }
    g_queue_clear_full(&screencast->commands, free_command);
    g_queue_clear_full(&screencast->spares, free_command);
    g_queue_clear_full(&screencast->events, free);
    if (screencast->event_fd >= 0) {
        close(screencast->event_fd);
    }
    if (screencast->command_fd >= 0) {
        close(screencast->command_fd);
    }
    g_clear_pointer(&screencast->loop, g_main_loop_unref);
    g_clear_pointer(&screencast->context, g_main_context_unref);
    g_mutex_clear(&screencast->lock);
    free(screencast);
}

int screencast_get_fd(struct screencast *screencast) {
    return screencast->event_fd;
}

bool screencast_next_event(struct screencast *screencast, struct screencast_event *event) {
    eventfd_t count;
    eventfd_read(screencast->event_fd, &count);
    g_mutex_lock(&screencast->lock);
    struct screencast_event *next = g_queue_pop_head(&screencast->events);
    g_mutex_unlock(&screencast->lock);
    if (!next) {
        return false;
    }
    *event = *next;
    free(next);
    return true;
}

void screencast_accept(struct screencast *screencast, uint32_t id, enum screencast_source source,
                       int32_t x, int32_t y, uint32_t width, uint32_t height) {
    struct command *command = xcalloc(1, sizeof(*command));
    *command = (struct command){
        .type = COMMAND_ACCEPT,
        .id = id,
        .source = source,
        .x = x,
        .y = y,
        .width = width,
        .height = height,
    };
    enqueue(screencast, command);
}

void screencast_close(struct screencast *screencast, uint32_t id) {
    struct command *command = xcalloc(1, sizeof(*command));
    command->type = COMMAND_CLOSE;
    command->id = id;
    enqueue(screencast, command);
}

void screencast_push_frame(struct screencast *screencast, uint32_t id, uint8_t **pixels,
                           uint32_t width, uint32_t height) {
    if (!width || !height || width > SCREENCAST_MAX_WIDTH || height > SCREENCAST_MAX_HEIGHT) {
        return;
    }
    struct command *command = NULL;
    g_mutex_lock(&screencast->lock);
    for (GList *link = screencast->spares.head; link; link = link->next) {
        struct command *spare = link->data;
        if (spare->width == width && spare->height == height) {
            command = spare;
            g_queue_delete_link(&screencast->spares, link);
            break;
        }
    }
    g_mutex_unlock(&screencast->lock);
    if (!command) {
        command = xcalloc(1, sizeof(*command));
        command->pixels = xmalloc((size_t)width * height * 4);
    }
    /* The frame changes hands; the caller draws the next one into the spare. */
    uint8_t *spare = command->pixels;
    command->pixels = *pixels;
    *pixels = spare;
    command->type = COMMAND_FRAME;
    command->id = id;
    command->width = width;
    command->height = height;
    enqueue(screencast, command);
}

void screencast_repeat_frame(struct screencast *screencast, uint32_t id) {
    struct command *command = xcalloc(1, sizeof(*command));
    command->type = COMMAND_REPEAT;
    command->id = id;
    enqueue(screencast, command);
}
