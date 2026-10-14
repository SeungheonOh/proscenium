#include "webnode.h"

#include <GLES2/gl2.h>
#include <math.h>
#include <string.h>
#include <wlr/types/wlr_output.h>

#include "display.h"
#include "input.h"
#include "link.h"
#include "render.h"
#include "stage.h"
#include "web.h"

/* How many of a node's last frame numbers it remembers its place for. */
#define PLACES 4
/* How long the scale a page is seen at holds still before the page rasters at it: a zoom
 * pauses for a frame now and then, and each new raster draws the whole page again. */
#define RASTER_SETTLE_MS 200

/* Where a node was while it had a frame number: its transform within its space (the
 * canvas, or a screen) and its size. */
struct place {
    int tag;
    struct mat4 chain;
    double width, height;
};

struct stage_page {
    struct wl_list link; /* server.pages */
    struct server *server;
    struct web_page *page;
    /* The node presenting it; NULL once that node died and none adopted it yet. */
    struct node *node;
    char *src;
    /* Whether an autoFocus node already gave it the keyboard. */
    bool auto_focused;
    /* Outputs whose last frame showed it, and the settled scale wanted on each. */
    uint32_t outputs;
    double wanted[32];
    /* When the scale it is seen at last changed on each output, and the timer that looks
     * again once that has held still. */
    double scale_changed[32];
    struct wl_event_source *settle_timer;
    /* What displays were built with: whether it had a frame, and its size. */
    bool framed;
    double width, height;
    /* The number on the frame shown, and the node's places for its last numbers, newest
     * first. */
    int shown_tag;
    struct place places[PLACES];
};

struct web_page *web_node_page(struct node *node) {
    struct stage_page *stage_page = node->kind == KIND_WEB ? node->web_page : NULL;
    return stage_page ? stage_page->page : NULL;
}

bool web_page_has_frame(struct web_page *page) {
    struct web_surface surfaces[2];
    return web_page_surfaces(page, surfaces) > 0;
}

struct mat3 web_node_content(struct web_page *page, double width, double height) {
    double page_width, page_height;
    web_page_size(page, &page_width, &page_height);
    return mat3_affine(width / fmax(1, page_width), 0, 0, height / fmax(1, page_height), 0, 0);
}

/* The CSS size a page is laid out at: its node's size once any animation settles. */
static void page_size(const struct node *node, double *width, double *height) {
    *width = node_target(node, PROP_WIDTH, 640);
    *height = node_target(node, PROP_HEIGHT, 360);
}

static void request_page_frames(struct stage_page *stage_page) {
    struct server *server = stage_page->server;
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        if (!stage_page->outputs || (stage_page->outputs & (1u << output->index)))
            output_request_frame(output);
    }
}

static void on_frame(struct web_page *page, void *data) {
    request_page_frames(data);
}

static void on_load(struct web_page *page, int status, void *data) {
    struct stage_page *stage_page = data;
    struct event event;
    if (stage_page->node && event_begin(stage_page->server, &event, stage_page->node, EVENT_LOAD))
        event_end(stage_page->server, &event);
}

static void on_error(struct web_page *page, const char *message, void *data) {
    struct stage_page *stage_page = data;
    struct event event;
    if (stage_page->node &&
        event_begin(stage_page->server, &event, stage_page->node, EVENT_ERROR)) {
        json_key(&event.writer, "message");
        json_string(&event.writer, message);
        event_end(stage_page->server, &event);
    }
}

static void on_message(struct web_page *page, const char *payload, void *data) {
    struct stage_page *stage_page = data;
    struct event event;
    if (stage_page->node &&
        event_begin(stage_page->server, &event, stage_page->node, EVENT_MESSAGE)) {
        json_key(&event.writer, "payload");
        json_string(&event.writer, payload);
        event_end(stage_page->server, &event);
    }
}

static const struct web_page_listener listener = {
    .frame = on_frame,
    .load = on_load,
    .error = on_error,
    .message = on_message,
};

static double max_output_scale(struct server *server) {
    double scale = 1;
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) scale = fmax(scale, output->wlr_output->scale);
    return scale;
}

static struct stage_page *create_page(struct server *server, struct node *node) {
    if (!server->web) server->web = web_create(server->loop, NULL, server->socket);
    if (!server->web) return NULL;
    struct stage_page *stage_page = xcalloc(1, sizeof *stage_page);
    stage_page->server = server;
    stage_page->node = node;
    stage_page->src = xstrdup(node_string(node, PROP_SRC));
    double width, height;
    page_size(node, &width, &height);
    struct web_page_options options = {
        .src = stage_page->src,
        .width = width,
        .height = height,
        .scale = max_output_scale(server),
        .revision = node_given(node, PROP_REVISION) ? node->props[PROP_REVISION].number : 0,
        .listener = &listener,
        .data = stage_page,
    };
    stage_page->page = web_page_create(server->web, &options);
    if (!stage_page->page) {
        /* Not retried until the node names another source. */
        free(node->web_failed);
        node->web_failed = xstrdup(stage_page->src);
        struct event event;
        if (event_begin(server, &event, node, EVENT_ERROR)) {
            json_key(&event.writer, "message");
            json_string(&event.writer, web_error());
            event_end(server, &event);
        }
        free(stage_page->src);
        free(stage_page);
        return NULL;
    }
    wl_list_insert(&server->pages, &stage_page->link);
    return stage_page;
}

static void destroy_page(struct server *server, struct stage_page *stage_page) {
    wl_list_remove(&stage_page->link);
    if (stage_page->node && stage_page->node->web_page == stage_page)
        stage_page->node->web_page = NULL;
    input_forget_page(server, stage_page->page);
    if (server->seat_state.focused_page == stage_page->page) focus_page(server, NULL);
    struct output *output;
    wl_list_for_each(output, &server->outputs, link)
        display_forget_client(output, stage_page->page);
    web_page_close(stage_page->page);
    if (stage_page->settle_timer) wl_event_source_remove(stage_page->settle_timer);
    free(stage_page->src);
    free(stage_page);
}

/* Bring a page's size, props and revision up to its node's declarations. */
static void sync_page(struct stage_page *stage_page) {
    struct node *node = stage_page->node;
    double width, height;
    page_size(node, &width, &height);
    web_page_resize(stage_page->page, width, height);
    if (node_given(node, PROP_REVISION))
        web_page_set_revision(stage_page->page, node->props[PROP_REVISION].number);
    web_page_set_props(stage_page->page, node_string(node, PROP_DATA));
    web_page_set_tagged(stage_page->page, node_given(node, PROP_FRAME_TAG));
}

/* An autoFocus page takes the keyboard each time it appears and gives it back when
 * hidden, so a page kept mounted can be shown and hidden like a launcher. */
static void sync_auto_focus(struct server *server, struct stage_page *stage_page) {
    struct node *node = stage_page->node;
    bool shown = node_bool(node, PROP_VISIBLE) && node_target(node, PROP_OPACITY, 1) > 0;
    if (!shown) {
        stage_page->auto_focused = false;
        if (server->seat_state.focused_page == stage_page->page) focus_page(server, NULL);
    } else if (node_bool(node, PROP_AUTO_FOCUS) && !stage_page->auto_focused) {
        stage_page->auto_focused = true;
        focus_page(server, stage_page->page);
    }
}

void web_refresh_nodes(struct server *server, struct vec *nodes) {
    VEC_FOR(nodes, struct node *, slot) {
        struct node *node = *slot;
        struct stage_page *stage_page = node->web_page;
        const char *src = node_string(node, PROP_SRC);
        if (stage_page && (!src || strcmp(src, stage_page->src))) {
            destroy_page(server, stage_page);
            stage_page = NULL;
        }
        if (src && !stage_page && !(node->web_failed && !strcmp(node->web_failed, src))) {
            struct stage_page *orphan;
            wl_list_for_each(orphan, &server->pages, link) {
                if (!orphan->node && !strcmp(orphan->src, src)) {
                    stage_page = orphan;
                    break;
                }
            }
            if (stage_page) {
                stage_page->node = node;
                web_page_set_listener_data(stage_page->page, stage_page);
            } else {
                stage_page = create_page(server, node);
            }
            node->web_page = stage_page;
        }
        if (stage_page) {
            sync_page(stage_page);
            sync_auto_focus(server, stage_page);
        }
    }
    struct stage_page *stage_page, *next;
    wl_list_for_each_safe(stage_page, next, &server->pages, link) {
        if (!stage_page->node) destroy_page(server, stage_page);
    }
}

void web_node_hold(struct node *node, const struct mat4 *space, const struct mat4 *space_inverse,
                   struct mat4 *chain, double *width, double *height) {
    struct stage_page *stage_page = node->web_page;
    if (!stage_page || !node_given(node, PROP_FRAME_TAG)) return;
    struct place *places = stage_page->places;
    int tag = (int)node->props[PROP_FRAME_TAG].number;
    if (places[0].tag != tag) memmove(&places[1], &places[0], (PLACES - 1) * sizeof *places);
    places[0] = (struct place){tag, mat4_multiply(space_inverse, chain), *width, *height};
    int shown = web_page_frame_tag(stage_page->page);
    if (!shown || shown == tag) return;
    for (int i = 1; i < PLACES; i++) {
        if (places[i].tag != shown) continue;
        *chain = mat4_multiply(space, &places[i].chain);
        *width = places[i].width;
        *height = places[i].height;
        return;
    }
}

void web_node_dead(struct server *server, struct node *node) {
    if (node->kind != KIND_WEB) return;
    free(node->web_failed);
    node->web_failed = NULL;
    struct stage_page *stage_page = node->web_page;
    if (stage_page) {
        stage_page->node = NULL;
        node->web_page = NULL;
    }
}

/* The scale a page is seen at has held still: the next frame takes it. */
static int settle_due(void *data) {
    struct stage_page *stage_page = data;
    scene_changed(stage_page->server);
    return 0;
}

void web_node_presented(struct node *node, struct output *output, double scale, bool settled,
                        double width) {
    struct stage_page *stage_page = node->web_page;
    if (!stage_page || output->index >= 32) return;
    double now = now_seconds();
    if (!settled) {
        stage_page->scale_changed[output->index] = now;
        if (!stage_page->settle_timer)
            stage_page->settle_timer =
                wl_event_loop_add_timer(stage_page->server->loop, settle_due, stage_page);
        if (stage_page->settle_timer)
            wl_event_source_timer_update(stage_page->settle_timer, RASTER_SETTLE_MS);
        return;
    }
    if (now - stage_page->scale_changed[output->index] < RASTER_SETTLE_MS / 1000.0) return;
    double page_width, page_height;
    web_page_size(stage_page->page, &page_width, &page_height);
    stage_page->wanted[output->index] = scale * width / fmax(1, page_width);
}

void web_node_draw(struct server *server, struct node *node, struct mat3 transform, double width,
                   double height, double radius, double opacity,
                   const struct render_shading *filter, struct render_report *report) {
    struct web_page *page = web_node_page(node);
    if (!page) return;
    struct mat3 content = web_node_content(page, width, height);
    struct web_surface surfaces[2];
    int count = web_page_surfaces(page, surfaces);
    for (int i = 0; i < count; i++) {
        struct web_surface *surface = &surfaces[i];
        struct render_texture texture = {GL_TEXTURE_2D, surface->texture, surface->texture_width,
                                         surface->texture_height, true};
        struct box box = {surface->box.x * content.a, surface->box.y * content.d,
                          surface->box.width * content.a, surface->box.height * content.d};
        struct render_texture_draw draw = {
            transform, box, RENDER_FULL_UV, {0, 0, width, height}, i == 0 ? radius : 0, opacity,
        };
        render_draw_texture(server->renderer, &texture, &draw, filter, report);
    }
}

void web_prepare(struct server *server, struct output *output) {
    if (!server->web) return;
    web_collect_garbage(server->web);
    struct stage_page *stage_page, *next;
    wl_list_for_each_safe(stage_page, next, &server->pages, link) {
        /* Pages whose nodes finished leaving the scene close. */
        if (!stage_page->node) {
            destroy_page(server, stage_page);
            continue;
        }
        if (stage_page->outputs && !(stage_page->outputs & (1u << output->index))) continue;
        struct box damage;
        if (!web_page_prepare(stage_page->page, &damage)) continue;
        /* A frame with another number shows where its node was with that number. */
        int tag = web_page_frame_tag(stage_page->page);
        if (tag != stage_page->shown_tag) invalidate_displays(server);
        stage_page->shown_tag = tag;
        /* Items fetch the page's textures as they draw; displays change only when it gets
         * its first frame or another size, which its hits map onto. */
        double width, height;
        web_page_size(stage_page->page, &width, &height);
        bool framed = web_page_has_frame(stage_page->page);
        if (framed != stage_page->framed || width != stage_page->width ||
            height != stage_page->height) {
            stage_page->framed = framed;
            stage_page->width = width;
            stage_page->height = height;
            invalidate_displays(server);
        }
        pixman_region32_t region;
        pixman_region32_init_rect(&region, (int)floor(damage.x), (int)floor(damage.y),
                                  (unsigned)ceil(damage.width), (unsigned)ceil(damage.height));
        displays_damage_client(server, stage_page->page, &region);
        pixman_region32_fini(&region);
    }
}

void web_sync_presence(struct server *server, struct output *output) {
    struct stage_page *stage_page;
    wl_list_for_each(stage_page, &server->pages, link) {
        uint32_t bit = 1u << output->index;
        if (display_shows_client(output, stage_page->page)) stage_page->outputs |= bit;
        else stage_page->outputs &= ~bit;
        web_page_set_visible(stage_page->page, stage_page->outputs != 0);
        /* A page on several outputs rasters for the sharpest of them. */
        double wanted = 0;
        for (int i = 0; i < 32; i++) {
            if (stage_page->outputs & (1u << i)) wanted = fmax(wanted, stage_page->wanted[i]);
        }
        if (wanted > 0) web_page_set_raster_scale(stage_page->page, wanted);
    }
}

void web_output_removed(struct server *server, struct output *output) {
    struct stage_page *stage_page;
    wl_list_for_each(stage_page, &server->pages, link) {
        stage_page->outputs &= ~(1u << output->index);
        web_page_set_visible(stage_page->page, stage_page->outputs != 0);
    }
}

void web_finish(struct server *server) {
    struct stage_page *stage_page, *next;
    if (!server->pages.next) return;
    wl_list_for_each_safe(stage_page, next, &server->pages, link) {
        /* Nothing may reach a page after this, keys still held included. */
        if (server->seat_state.focused_page == stage_page->page) focus_page(server, NULL);
        if (server->input) input_forget_page(server, stage_page->page);
        if (stage_page->node) stage_page->node->web_page = NULL;
        wl_list_remove(&stage_page->link);
        web_page_close(stage_page->page);
        free(stage_page->src);
        free(stage_page);
    }
    if (!server->web) return;
    if (server_gl_current(server)) web_release_graphics(server->web);
    web_destroy(server->web);
    server->web = NULL;
}
