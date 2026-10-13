/*
 * The scene as the compositor sees it: indexes rebuilt after each commit, the
 * fallback layout, motion on the frame clock, node sizes.
 */
#include <stdio.h>
#include <wlr/util/log.h>

#include "content.h"
#include "display.h"
#include "input.h"
#include "link.h"
#include "stage.h"
#include "webnode.h"

bool stage_natural_value(void *data, struct node *node, enum prop_key key, double *out) {
    struct server *server = data;
    if (node->kind != KIND_WINDOW || (key != PROP_WIDTH && key != PROP_HEIGHT)) return false;
    struct window *window = window_for_node(server, node);
    if (!window) return false;
    double width, height;
    window_natural_size(window, &width, &height);
    *out = key == PROP_WIDTH ? width : height;
    return true;
}

void stage_node_dead(void *data, struct node *node) {
    struct server *server = data;
    content_node_dead(server, node);
    web_node_dead(server, node);
    input_node_dead(server, node);
}

void stage_node_size(void *data, const struct node *node, double *width, double *height) {
    node_size(data, node, width, height);
}

void node_size(struct server *server, const struct node *node, double *width, double *height) {
    struct node *mutable = (struct node *)node;
    switch (node->kind) {
    case KIND_GROUP:
        *width = node_number(node, PROP_WIDTH, 0);
        *height = node_number(node, PROP_HEIGHT, 0);
        return;
    case KIND_WINDOW: {
        double natural_width = 0, natural_height = 0;
        struct window *window = window_for_node(server, node);
        if (window) window_natural_size(window, &natural_width, &natural_height);
        *width = node_number(node, PROP_WIDTH, natural_width);
        *height = node_number(node, PROP_HEIGHT, natural_height);
        return;
    }
    case KIND_WEB:
        *width = node_number(node, PROP_WIDTH, 640);
        *height = node_number(node, PROP_HEIGHT, 360);
        return;
    case KIND_TEXT:
    case KIND_IMAGE: content_node_size(server, mutable, width, height); return;
    default: *width = *height = 0; return;
    }
}

void modifiers_write(uint32_t modifiers, struct json_writer *writer) {
    json_array_begin(writer);
    for (int i = 0; i < MODIFIER_COUNT; i++) {
        if (modifiers & (1u << i)) json_string(writer, MODIFIER_NAMES[i]);
    }
    json_array_end(writer);
}

/* Shaders. */

void shader_report_error(struct server *server, struct node *node, const struct shader *shader,
                         const char *error) {
    bool told = true;
    for (int i = 0; i < node->shading_count; i++) {
        struct shading *shading = &node->shadings[i];
        if (shading->shader != shader) continue;
        told = told && shading->reported;
        shading->reported = true;
    }
    if (told) return;
    struct strbuf message;
    strbuf_init(&message);
    strbuf_printf(&message, "Shader %s: %s", shader->id, error);
    wlr_log(WLR_ERROR, "Node %lld: %s", (long long)node->id, message.data);
    struct event event;
    if (event_begin(server, &event, node, EVENT_ERROR)) {
        json_key(&event.writer, "message");
        json_string(&event.writer, message.data);
        event_end(server, &event);
    }
    strbuf_finish(&message);
}

/* The fallback: unplaced windows cascade on the first output while no director
 * scene presents them, so a missing or crashed director never hides them. */
void windows_sync_fallback(struct server *server) {
    double time = now_seconds();
    int index = 0;
    bool changed = false;
    struct window *window;
    wl_list_for_each(window, &server->windows, link) {
        bool wanted = !link_scene_active(server->link) && !window->nodes.length && window->mapped;
        if (wanted && !window->fallback) {
            int64_t id = (int64_t)window->id;
            int offset = 48 + 32 * (index % 8);
            char props[160];
            snprintf(props, sizeof props,
                     "{\"window\":%lld,\"x\":%d,\"y\":%d,\"originX\":0,\"originY\":0}",
                     (long long)id, offset, offset);
            struct json_document document;
            char error_text[64];
            if (json_parse(props, strlen(props), &document, error_text, sizeof error_text)) {
                struct json_value type = {.type = JSON_STRING, .string = {"window", 6}};
                struct protocol_error error;
                if (scene_create_node(&server->fallback, id, &type, document.root, time, &error) &&
                    scene_insert(&server->fallback, 0, id, 0, &error)) {
                    window->fallback = scene_node(&server->fallback, id);
                    changed = true;
                }
                json_document_finish(&document);
            }
        } else if (!wanted && window->fallback) {
            struct protocol_error error;
            scene_remove(&server->fallback, 0, window->fallback->id, &error);
            window->fallback = NULL;
            changed = true;
        }
        if (wanted) index++;
    }
    scene_finish_commit(&server->fallback, time);
    if (changed) scene_changed(server);
}

static int compare_nodes(const void *a, const void *b) {
    int64_t x = (*(struct node *const *)a)->id, y = (*(struct node *const *)b)->id;
    return x < y ? -1 : x > y;
}

struct index_walk {
    struct server *server;
    struct vec webs;
};

static void index_node(struct node *node, void *data) {
    struct index_walk *walk = data;
    struct server *server = walk->server;
    struct vec *list = NULL;
    switch (node->kind) {
    case KIND_WINDOW: {
        struct window *window = window_by_id(
            server, node->props[PROP_WINDOW].given ? (uint64_t)node->props[PROP_WINDOW].id : 0);
        if (window) {
            node_ref(node);
            *(struct node **)vec_push(&window->nodes) = node;
        }
        return;
    }
    case KIND_CAMERA: list = &server->cameras; break;
    case KIND_RESERVE: list = &server->reserves; break;
    case KIND_SHORTCUT: list = &server->shortcuts; break;
    case KIND_POINTER_BINDING:
    case KIND_WHEEL_BINDING:
    case KIND_GESTURE_BINDING: list = &server->bindings; break;
    case KIND_TEXT:
    case KIND_IMAGE: content_refresh_node(server, node); return;
    case KIND_WEB: list = &walk->webs; break;
    default: return;
    }
    node_ref(node);
    *(struct node **)vec_push(list) = node;
}

static void clear_list(struct vec *list) {
    VEC_FOR(list, struct node *, node) node_unref(*node);
    vec_clear(list);
}

/* The camera node for OUTPUT: one naming it, else one naming none. */
static struct node *camera_for(struct server *server, struct output *output) {
    struct node *any = NULL;
    VEC_FOR(&server->cameras, struct node *, slot) {
        const char *name = node_string(*slot, PROP_OUTPUT);
        if (name && !strcmp(name, output_name(output))) return *slot;
        if (!name && !any) any = *slot;
    }
    return any;
}

/* Rebuild everything indexed from the scene after it or the windows changed: window
 * nodes, cameras, reserves, shortcuts, bindings, web pages, the fallback and
 * departed windows. */
void stage_reindex(struct server *server) {
    struct window *window;
    wl_list_for_each(window, &server->windows, link) {
        VEC_FOR(&window->nodes, struct node *, node) node_unref(*node);
        vec_clear(&window->nodes);
    }
    clear_list(&server->cameras);
    clear_list(&server->reserves);
    clear_list(&server->shortcuts);
    clear_list(&server->bindings);
    struct index_walk walk = {.server = server};
    vec_init(&walk.webs, sizeof(struct node *));
    scene_for_each(&server->scene, index_node, &walk);
    wl_list_for_each(window, &server->windows, link) {
        qsort(window->nodes.data, window->nodes.length, sizeof(struct node *), compare_nodes);
    }
    input_install_shortcuts(server);
    struct output *output;
    double time = now_seconds();
    wl_list_for_each(output, &server->outputs, link) {
        struct node *camera = camera_for(server, output);
        if (camera) camera_apply_node(output, camera, time);
    }
    cameras_report(server);
    windows_sync_fallback(server);
    wl_list_for_each(window, &server->windows, link) {
        window_configure(window);
        if (window_presentable(window)) window_refresh_snapshot(window);
    }
    outputs_update_reservations(server);
    windows_sweep_departed(server);
    web_refresh_nodes(server, &walk.webs);
    clear_list(&walk.webs);
    vec_finish(&walk.webs);
    scene_changed(server);
}

void director_detached(struct server *server, bool was_active) {
    input_release_director(server);
    if (was_active) {
        windows_sync_fallback(server);
        scene_changed(server);
    }
}

/* Departed windows whose last frame no node presents any more release it. */
static void note_shown(struct node *node, void *data) {
    struct idmap *shown = data;
    if (node->kind == KIND_WINDOW && node->props[PROP_WINDOW].given)
        idmap_put(shown, node->props[PROP_WINDOW].id, (void *)1);
}

static void note_subtree(struct node *node, struct idmap *shown) {
    note_shown(node, shown);
    NODE_FOR_CHILDREN(node, child) note_subtree(child, shown);
}

void windows_sweep_departed(struct server *server) {
    bool hidden = false;
    struct window *window;
    wl_list_for_each(window, &server->windows, link) {
        if (window->snapshot.length && !window_presentable(window)) hidden = true;
    }
    if (!hidden && server->departed.count == 0) return;
    struct idmap shown;
    idmap_init(&shown);
    scene_for_each(&server->scene, note_shown, &shown);
    VEC_FOR(&server->scene.exiting, struct node *, root) note_subtree(*root, &shown);
    size_t index = 0;
    int64_t id;
    void *value;
    while (idmap_next(&server->departed, &index, &id, &value)) {
        if (idmap_get(&shown, id)) continue;
        idmap_remove(&server->departed, id);
        window_unref(value);
        invalidate_displays(server);
    }
    wl_list_for_each(window, &server->windows, link) {
        if (window->snapshot.length && !window_presentable(window) &&
            !idmap_get(&shown, (int64_t)window->id)) {
            window_release_snapshot(window);
            invalidate_displays(server);
        }
    }
    idmap_finish(&shown);
}

/* Motion. */

static bool settling(struct server *server) {
    return scene_settling(&server->scene) || scene_settling(&server->fallback);
}

/* Sample motion at TIME and keep frames coming while anything moves. Finite motion
 * may bring anything into view, so it keeps every output up; a moving camera wakes
 * only its output, and endless loops and shader clocks only the outputs showing them. */
void server_advance(struct server *server, double time) {
    struct output *output;
    if (time > server->advanced_at) {
        bool moved = settling(server);
        wl_list_for_each(output, &server->outputs, link) {
            if (camera_moving(output) || display_animating(output)) moved = true;
        }
        /* Whatever moved until now has new values, including the step that ends it. */
        if (moved) invalidate_displays(server);
        server->advanced_at = time;
        scene_advance(&server->scene, time);
        scene_advance(&server->fallback, time);
        wl_list_for_each(output, &server->outputs, link) camera_sample(output, time);
    }
    if (settling(server)) {
        request_frames(server);
        return;
    }
    wl_list_for_each(output, &server->outputs, link) {
        if (camera_moving(output) || display_animating(output)) output_request_frame(output);
    }
}
