/* Per-output display lists, damage, frames and pick targets: see display.h. */
#define _GNU_SOURCE
#include "display.h"

#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <math.h>
#include <wlr/render/dmabuf.h>
#include <wlr/render/gles2.h>
#include <wlr/render/wlr_texture.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_cursor.h>
#include <wlr/types/wlr_damage_ring.h>
#include <wlr/types/wlr_output.h>
#include <wlr/types/wlr_presentation_time.h>
#include <wlr/util/log.h>
#include <wlr/util/transform.h>

#include "content.h"
#include "input.h"
#include "render.h"
#include "renderthread.h"
#include "stage.h"
#include "web.h"
#include "webnode.h"

/* What one more paint pass costs, in pixels painted: a pass walks the items and
 * issues the draws it touches again. */
#define PASS_COST 12000
/* Pixels an item must cover in a pass before the opaque items above it are cut out of it. */
#define OCCLUSION_CUT_AREA 65536
/* Where shaders reading the pointer see it while it is on another output. */
#define FAR_POINTER (-1e6)
/* What shows where nothing in the scene is drawn. */
static const double UNDERLAY[3] = {0.055, 0.055, 0.065};

enum item_kind {
    ITEM_PAINT,
    ITEM_SURFACE,
    ITEM_TEXT,
    ITEM_IMAGE,
    ITEM_WEB,
    ITEM_EFFECT,
};

/*
 * A shader as an item draws it, its uniforms kept in the display's values.
 * What comes before VALUES goes into the item's signature.
 */
struct item_shading {
    struct shader *shader;
    double size[2], radius, time, pointer[2];
    /* For a shader reading the output: local units to output-logical pixels and back. */
    struct mat3 to_output, from_output;
    double output_size[2];
    int values;
};

struct item {
    uint64_t key, signature;
    enum item_kind kind;
    struct box bounds;
    bool clipped;
    struct box clip;
    /* Backdrop readers and non-local effects read every pixel of this area. */
    bool reads;
    struct box read_area;
    /* Tighter damage than the bounds, e.g. a border's ring. */
    int damage_count;
    struct box damage[4];
    /* A rectangle it paints opaquely all over: what lies beneath need not be drawn. */
    bool opaque_valid;
    struct box opaque;
    /* The effect item drawing this one into its content, or -1 for the frame. */
    int owner;
    /* A live surface it draws, for frame callbacks and presentation feedback. */
    struct wlr_surface *surface_ptr;
    struct node *node;     /* referenced */
    struct window *window; /* referenced */
    /* A paint's or an effect's shader, or the filter content is drawn through; no
     * shader for none. */
    struct item_shading shading;
    union {
        struct render_paint_draw paint;
        struct {
            struct mat3 transform;
            struct box box, mask;
            double radius, opacity;
            double uv[8];
            /* For a snapshot, whose surface is gone: its texture, and the buffer its window
             * holds for it. */
            struct wlr_texture *texture;
            struct wlr_buffer *buffer;
        } surface;
        struct {
            struct mat3 transform;
            uint64_t slot, key;
            double scale, opacity, color[4];
            struct media_text_metrics metrics;
            /* Drawn as glyphs from the atlas rather than as a raster. */
            bool glyphs;
        } text;
        struct {
            struct mat3 transform;
            struct box box;
            double uv[8], radius, opacity;
        } image;
        struct {
            struct mat3 transform;
            double width, height, radius, opacity;
        } web;
        struct {
            struct render_effect_draw draw;
            int end; /* items up to here may be its descendants */
        } effect;
    };
};

/* An item kept from one diff to the next: its index now and before. */
struct kept {
    int item, old;
};

/* An item's damage and signature as last diffed, by key. */
struct diffed {
    uint64_t key, signature;
    int index;
    int damage_count;
    struct box damage[4];
};

struct transform_entry {
    void *client; /* struct window * or struct web_page * */
    struct mat3 transform;
    /* A mirror's: it takes damage, but popups and input follow the window itself. */
    bool mirror;
};

/*
 * Items and the uniform values they draw with, shared by the display that built them and
 * the frames drawing them: a set a frame still draws is left to it, and the display
 * builds into a new one. Its references are the main thread's.
 */
struct item_set {
    int refs;
    struct vec items;  /* struct item */
    struct vec values; /* float */
};

struct display {
    struct output *output;
    struct wlr_damage_ring ring;
    pixman_region32_t pending;
    int buffer_width, buffer_height, transform;
    /* Called with each frame drawn (display_set_tap). */
    display_tap tap;
    void *tap_data;

    /* The scene's items, and the seat's (drag icons), as last built. */
    struct item_set *scene, *seat;
    /* Frames built and not yet freed (struct display_frame *). */
    struct vec frames;
    struct vec hits;                       /* struct hit */
    struct vec transforms;                 /* struct transform_entry */
    struct vec diffed, seat_diffed, spare; /* struct diffed, sorted by key */
    struct vec kept;                       /* struct kept: scratch while diffing */
    bool valid, diffed_current;
    bool animating, pointer_shaders, refine;
    double built_at;
    /* Text and web node id -> exact raster scale on the last rendered frame. */
    struct idmap raster_scales, next_raster_scales;
    struct vec surfaces; /* struct surface_draw: scratch while emitting */
    struct vec gathered; /* pixman_box32_t: damage while diffing */
    /* PROSCENIUM_CHECK's full redraws, and frames found to differ from them. */
    struct render_target *check_target;
    int checked, mismatched;
};

enum { SCENE_SET, SEAT_SET, SET_COUNT };

/* How an item draws, as its frame prepared it. */
struct item_draw {
    /* The frame draws it. */
    bool ready;
    /* A surface's texture; none when its name is 0. */
    struct render_surface surface;
    /* Text or an image drawn from a raster in SLOT (0 for none), text's at RASTER_SCALE. */
    uint64_t slot;
    double raster_scale;
    /* Text drawn as glyphs: COUNT from FIRST of the frame's glyphs. */
    size_t first, count;
    /* Set where it is drawn: a surface drawn, for presentation feedback. */
    bool presented;
};

/* What drawing found of a shader, reported back to the main thread. */
struct frame_report {
    int set, index;
    struct render_report report;
};

struct display_frame {
    struct output *output;
    struct item_set *sets[SET_COUNT];
    struct vec draws[SET_COUNT]; /* struct item_draw, one per item */
    struct vec glyphs;           /* struct content_glyph */
    struct vec uploads;          /* struct content_upload */
    struct vec locks;            /* struct wlr_buffer *: buffers it draws from */
    /* Surfaces it shows, drawn or not: their mipmaps stay (uint64_t item keys). */
    struct vec shown_keys;
    struct vec reports;          /* struct frame_report */
    struct vec passes;           /* struct rect */
    /* Surfaces it drew, once drawn, and visible ones owed a frame callback once it is shown. */
    struct vec presented, callbacks; /* struct wlr_surface * */
    pixman_region32_t damage;
    int width, height;
    /* Drawn while the main thread waits: it reads the main thread's state (web pages), or
     * is a capture. CHECK: compared with a full redraw (PROSCENIUM_CHECK). SHOWN: it changes
     * pixels or a client waits for it. */
    bool sync, check, shown;
    double built_at;
    /* Where it draws: the buffer, imported by the render thread from its dma-buf, or
     * wlroots' framebuffer for it when the main thread draws. */
    struct wlr_buffer *buffer;
    struct wlr_dmabuf_attributes dmabuf;
    bool has_dmabuf, drawn;
    GLuint framebuffer;
    /* Milliseconds building it took on the main thread, and drawing it. */
    double build_ms, draw_ms;
    /* The display's tap when it was built, called once it is drawn. */
    display_tap tap;
    void *tap_data;
    void (*done)(struct display_frame *frame, void *data);
    void *data;
};

/* Where items emitted now are clipped: in buffer pixels, and for hits in
 * output-logical ones. */
struct clip_state {
    bool clipped, logical_clipped;
    struct box box, logical;
};

struct emit {
    struct server *server;
    struct output *output;
    struct display *display;
    /* Where items and their uniform values go. */
    struct vec *items, *values;
    uint64_t tag;
    struct mat3 screen, to_logical; /* output-logical to buffer, and back */
    bool has_to_logical;
    struct box bounds; /* the buffer */
    struct clip_state clip;
    bool moving, animating, pointer_parent;
    int owner;
    /* Inside an effect, what its content target holds: all a backdrop there can read. */
    bool in_effect;
    struct box effect_area;
    struct vec *surfaces; /* the display's scratch */
    /* Where the nodes being emitted start from: the camera on the canvas, output pixels on a
     * screen; and back. */
    const struct mat4 *space, *space_inverse;
};

/* A node's filter as its content items draw it. */
struct filter {
    /* NULL when it has none, or the one it has changes nothing. */
    const struct shading *shading;
    struct item_shading recorded;
    /* What is opaque stays opaque through it. */
    bool keeps_opacity;
};

/* Grow BOUNDS to take in BOX; an empty BOUNDS becomes BOX. */
static void box_union_wlr(struct wlr_box *bounds, const struct wlr_box *box) {
    if (bounds->width <= 0 || bounds->height <= 0) {
        *bounds = *box;
        return;
    }
    int x0 = MIN(bounds->x, box->x), y0 = MIN(bounds->y, box->y);
    int x1 = MAX(bounds->x + bounds->width, box->x + box->width);
    int y1 = MAX(bounds->y + bounds->height, box->y + box->height);
    *bounds = (struct wlr_box){x0, y0, x1 - x0, y1 - y0};
}

/* Keys and signatures. */

static uint64_t key_of(uint64_t tag, int64_t id, int part, int index) {
    int64_t values[4] = {(int64_t)tag, id, part, index};
    return hash_bytes(HASH_SEED, values, sizeof values);
}

static uint64_t signature_of(const struct emit *e, const void *params, size_t size) {
    uint64_t hash = hash_bytes(HASH_SEED, params, size);
    if (e->clip.clipped) hash = hash_bytes(hash, &e->clip.box, sizeof e->clip.box);
    return hash;
}

/* Emission. */

/* An item drawing PART (an index among those of its node's kind of part) of node ID. */
static struct item *emit_item(struct emit *e, int64_t id, int part, int index, struct box bounds,
                              enum item_kind kind) {
    struct box visible;
    struct box limit = e->bounds;
    if (e->clip.clipped && !box_intersect(e->clip.box, e->bounds, &limit)) return NULL;
    /* Offscreen or clipped-away items cost nothing: no drawing, damage or callbacks. */
    if (!box_intersect(bounds, limit, &visible)) return NULL;
    struct item *item = vec_push(e->items);
    item->key = key_of(e->tag, id, part, index);
    item->kind = kind;
    item->bounds = visible;
    item->clipped = e->clip.clipped;
    item->clip = e->clip.box;
    item->owner = e->owner;
    if (e->moving) e->animating = true;
    return item;
}

static void set_node(struct item *item, struct node *node) {
    item->node = node;
    node_ref(node);
}

static void add_hit(struct emit *e, struct node *node, const struct mat3 *inverse,
                    const struct mat3 *parent_inverse, bool sized, double width, double height,
                    struct hit *extra) {
    if (!inverse || node->state != NODE_LIVE) return;
    struct hit *hit = vec_push(&e->display->hits);
    if (extra) *hit = *extra;
    hit->node = node;
    node_ref(node);
    if (hit->window) window_ref(hit->window);
    hit->inverse = *inverse;
    hit->has_parent_inverse = parent_inverse != NULL;
    if (parent_inverse) hit->parent_inverse = *parent_inverse;
    hit->sized = sized;
    hit->width = width;
    hit->height = height;
    hit->clipped = e->clip.logical_clipped;
    hit->clip = e->clip.logical;
}

/* BOX less SIDES (left, top, right, bottom). */
static struct box inset_box(struct box box, const double sides[4]) {
    return (struct box){box.x + sides[0], box.y + sides[1], box.width - sides[0] - sides[2],
                        box.height - sides[1] - sides[3]};
}

/* Whether INNER is a box lying strictly inside OUTER. */
static bool box_within(struct box inner, struct box outer) {
    return inner.width > 0 && inner.height > 0 && inner.x > outer.x && inner.y > outer.y &&
           box_right(inner) < box_right(outer) && box_bottom(inner) < box_bottom(outer);
}

/* The buffer rectangle local box INNER covers when T keeps it upright; false otherwise.
 * Antialiased edges and clipped-away parts are left out. */
static bool opaque_rectangle(const struct emit *e, struct mat3 t, struct box inner,
                             struct box *out) {
    if (!mat3_is_upright(t)) return false;
    if (!(inner.width > 2 && inner.height > 2)) return false;
    struct box rect = box_inflate(mat3_box_bounds(t, inner, 0), -1);
    if (e->clip.clipped) return box_intersect(rect, e->clip.box, out);
    *out = rect;
    return true;
}

/* The first seat's pointer in the local units of T, when it is on this output. */
static void local_pointer(struct emit *e, struct mat3 t, double out[2]) {
    out[0] = out[1] = FAR_POINTER;
    struct mat3 inverse;
    double x, y;
    struct output *output = input_pointer_output(e->server, &x, &y);
    if (output != e->output || !mat3_invert(t, &inverse)) return;
    mat3_apply(mat3_multiply(inverse, e->screen), x, y, &out[0], &out[1]);
}

/* Whether SHADER is known to draw what its definition promises, as occluders must. */
static bool shader_drawing(const struct shader *shader) {
    return shader->program && render_shader_ready(shader->program);
}

/* SHADING's uniforms as NODE shows them, into VALUES; false when its gate shows nothing. */
static bool shading_values(const struct node *node, const struct shading *shading,
                           float values[SHADER_COMPONENTS_MAX]) {
    node_shading_values(node, shading, values);
    return shader_open(shading->shader, values);
}

/* Record SHADING with VALUES, seeing a WIDTH x HEIGHT box of corner RADIUS through T, for
 * items to draw. */
static void record_shading(struct emit *e, const struct shading *shading, const float *values,
                           struct mat3 t, double width, double height, double radius,
                           struct item_shading *out) {
    struct shader *shader = shading->shader;
    out->shader = shader;
    out->size[0] = width;
    out->size[1] = height;
    out->radius = radius;
    out->time = shader->time ? shading_time(shading, e->server->advanced_at) : 0;
    out->pointer[0] = out->pointer[1] = 0;
    if (shader->pointer) local_pointer(e, t, out->pointer);
    out->to_output = out->from_output = MAT3_IDENTITY;
    out->output_size[0] = out->output_size[1] = 0;
    if (shader->output) {
        struct mat3 screen_inverse, to;
        if (mat3_invert(e->screen, &screen_inverse)) {
            to = mat3_multiply(screen_inverse, t);
            if (mat3_invert(to, &out->from_output)) out->to_output = to;
            else out->from_output = MAT3_IDENTITY;
        }
        out->output_size[0] = e->output->width;
        out->output_size[1] = e->output->height;
    }
    out->values = (int)e->values->length;
    for (int c = 0; c < shader->component_count; c++) *(float *)vec_push(e->values) = values[c];
}

/* ITEM draws SHADING as recorded: its signature takes in what the shader sees, a running
 * clock keeps frames coming, and the pointer moving rebuilds it. */
static void shading_signature(struct emit *e, struct item *item, const struct shading *shading) {
    const struct item_shading *recorded = &item->shading;
    const struct shader *shader = recorded->shader;
    item->signature = hash_bytes(item->signature, recorded, offsetof(struct item_shading, values));
    if (shader->component_count)
        item->signature = hash_bytes(item->signature, vec_at(e->values, (size_t)recorded->values),
                                     shader->component_count * sizeof(float));
    if (shader->time && shading->running) e->animating = true;
    if (shader->pointer) e->display->pointer_shaders = true;
}

/*
 * Paint SHADING of NODE with VALUES, its WIDTH x HEIGHT box of corner RADIUS
 * placed by T: its quad follows the shader's extent, a hole or the local box
 * COVER (when given) that later paints hide leaves a ring, and an opaque region
 * hides what lies beneath. A background's paints cover the plane.
 */
static void emit_paint(struct emit *e, struct node *node, const struct shading *shading,
                       const float *values, const struct box *cover, struct mat3 t, double width,
                       double height, double radius, double opacity) {
    struct shader *shader = shading->shader;
    bool plane = node->kind == KIND_BACKGROUND;
    if (shading->whole_output && !plane) {
        /* Over the whole output, positions are output-logical pixels. */
        t = e->screen;
        width = e->output->width;
        height = e->output->height;
        radius = 0;
    }
    struct box box = {0, 0, width, height};
    double pixel = plane ? mat3_plane_pixel(t, e->bounds.width, e->bounds.height)
                         : mat3_pixel_size(t, width / 2, height / 2),
           sides[4];
    shader_bound(&shader->extent, values, radius, pixel, sides);
    struct box quad = inset_box(box, (double[]){-sides[0], -sides[1], -sides[2], -sides[3]});
    if (!plane && !(quad.width > 0 && quad.height > 0)) return;
    struct box bounds = plane ? e->bounds : mat3_box_bounds(t, quad, 1);
    struct item *item =
        emit_item(e, node->id, 14, (int)(shading->key & 0x7fffffff), bounds, ITEM_PAINT);
    if (!item) return;
    /* Written in place: the signature hashes the struct, padding included. */
    struct render_paint_draw *draw = &item->paint;
    draw->transform = t;
    draw->quad = quad;
    draw->plane = plane;
    draw->opacity = opacity;
    if (!plane && shader_region_holds(&shader->hole, values, true)) {
        shader_bound(&shader->hole.inset, values, radius, pixel, sides);
        struct box hole = inset_box(box, sides);
        if (box_within(hole, quad)) {
            draw->holed = true;
            draw->hole = hole;
        }
    }
    if (cover && !plane && !shading->whole_output && box_within(*cover, quad) &&
        (!draw->holed || box_area(*cover) > box_area(draw->hole))) {
        draw->holed = true;
        draw->hole = *cover;
    }
    if (shader->backdrop) {
        /* The blur is in local units; what is read reaches beyond the paint by its margin. */
        draw->blur =
            shader->backdrop_blur >= 0 ? fmax(0, values[shader->backdrop_blur]) / pixel : 0;
        struct box sampled, limit = e->in_effect ? e->effect_area : e->bounds;
        int margin = render_blur_margin(draw->blur);
        if (box_intersect(box_inflate(bounds, margin), limit, &sampled))
            draw->area = box_pixels(sampled, (int)e->bounds.width, (int)e->bounds.height);
        item->reads = true;
        item->read_area =
            (struct box){draw->area.x, draw->area.y, draw->area.width, draw->area.height};
    }
    record_shading(e, shading, values, t, width, height, radius, &item->shading);
    item->signature = signature_of(e, draw, sizeof *draw);
    shading_signature(e, item, shading);
    set_node(item, node);
    /* A ring repaints only itself, so an animated border leaves the inside alone. */
    if (draw->holed && mat3_is_upright(t)) {
        struct box h = draw->hole;
        struct box strips[4] = {
            {quad.x, quad.y, quad.width, h.y - quad.y},
            {quad.x, box_bottom(h), quad.width, box_bottom(quad) - box_bottom(h)},
            {quad.x, h.y, h.x - quad.x, h.height},
            {box_right(h), h.y, box_right(quad) - box_right(h), h.height},
        };
        item->damage_count = 4;
        for (int i = 0; i < 4; i++) item->damage[i] = mat3_box_bounds(t, strips[i], 2);
    }
    /* What a paint reads lies beneath it, so it hides nothing; nor does one that is not
     * drawing yet. A plane in perspective may leave sky. */
    if (!item->reads && opacity >= 1 && shader_drawing(shader) &&
        shader_region_holds(&shader->opaque, values, false)) {
        if (plane && mat3_is_affine(t)) {
            item->opaque_valid = true;
            item->opaque = item->bounds;
        } else if (!plane) {
            shader_bound(&shader->opaque.inset, values, radius, pixel, sides);
            item->opaque_valid = opaque_rectangle(e, t, inset_box(box, sides), &item->opaque);
        }
    }
}

/* The local box a paint with VALUES covers opaquely over a WIDTH x HEIGHT box; false when
 * none. A paint over the whole output or reading its backdrop covers nothing of its node. */
static bool paint_cover(const struct shading *shading, const float *values, double width,
                        double height, double radius, double pixel, struct box *out) {
    const struct shader *shader = shading->shader;
    if (shading->whole_output || shader->backdrop || !shader_drawing(shader) ||
        !shader_region_holds(&shader->opaque, values, false))
        return false;
    double sides[4];
    shader_bound(&shader->opaque.inset, values, radius, pixel, sides);
    *out = inset_box((struct box){0, 0, width, height}, sides);
    return out->width > 0 && out->height > 0;
}

/*
 * NODE's paints of one layer, over its content or under it, in their order.
 * What a later paint of the layer covers opaquely is hidden from the ones
 * before, up to one reading its backdrop: a shadow under an opaque fill is
 * drawn, and damaged, as a ring.
 */
static void emit_paints(struct emit *e, struct node *node, struct mat3 t, double width,
                        double height, double radius, double opacity, bool over) {
    if (!node->shading_count) return;
    float values[SHADINGS_HELD][SHADER_COMPONENTS_MAX];
    bool shown[SHADINGS_HELD], hidden[SHADINGS_HELD];
    struct box covers[SHADINGS_HELD], cover, largest = {0};
    bool plane = node->kind == KIND_BACKGROUND, any = false;
    double pixel = 0;
    for (int i = node->shading_count - 1; i >= 0; i--) {
        const struct shading *shading = &node->shadings[i];
        shown[i] = shading->shader->stage == STAGE_PAINT && shading->over == over &&
                   shading_values(node, shading, values[i]);
        if (!shown[i]) continue;
        hidden[i] = any;
        covers[i] = largest;
        /* A paint reading its backdrop reads the ones before it whole. */
        if (shading->shader->backdrop) any = false;
        /* Only an opaque region needs the scale. */
        if (!pixel && shading->shader->opaque.given)
            pixel = mat3_pixel_size(t, width / 2, height / 2);
        if (!plane && opacity >= 1 &&
            paint_cover(shading, values[i], width, height, radius, pixel, &cover) &&
            (!any || box_area(cover) > box_area(largest))) {
            largest = cover;
            any = true;
        }
    }
    for (int i = 0; i < node->shading_count; i++) {
        if (shown[i])
            emit_paint(e, node, &node->shadings[i], values[i], hidden[i] ? &covers[i] : NULL, t,
                       width, height, radius, opacity);
    }
}

/* NODE's filter, seeing its WIDTH x HEIGHT box of corner RADIUS through T, into OUT. */
static void node_filter(struct emit *e, struct node *node, struct mat3 t, double width,
                        double height, double radius, struct filter *out) {
    memset(out, 0, sizeof *out);
    out->keeps_opacity = true;
    const struct shading *shading = node_stage_shading(node, STAGE_FILTER);
    float values[SHADER_COMPONENTS_MAX];
    if (!shading || !shading_values(node, shading, values)) return;
    out->shading = shading;
    out->keeps_opacity = shader_region_holds(&shading->shader->opaque, values, false);
    record_shading(e, shading, values, t, width, height, radius, &out->recorded);
}

/* Draw content ITEM, its signature made, through FILTER. */
static void filter_item(struct emit *e, struct item *item, struct node *node,
                        const struct filter *filter) {
    if (!filter->shading) return;
    item->shading = filter->recorded;
    shading_signature(e, item, filter->shading);
    /* A filter that fails is reported on its node. */
    if (!item->node) set_node(item, node);
}

static bool pointer_handlers(const struct node *node) {
    return node->handlers & BUBBLING_EVENTS;
}

/* Whether NODE's pointer handlers or cursor apply over it and its descendants. */
static bool claims_pointer(const struct node *node) {
    return pointer_handlers(node) || node->props[PROP_CURSOR].given;
}

static bool node_takes_pointer(const struct node *node) {
    if (claims_pointer(node)) return true;
    switch (node->kind) {
    case KIND_BACKGROUND: return node_bool(node, PROP_PAN);
    case KIND_GROUP:
    case KIND_TEXT:
    case KIND_IMAGE: return move_target(node) != NULL;
    default: return false;
    }
}

bool node_input_target(const struct node *node) {
    if (!node_bool(node, PROP_INTERACTIVE)) return false;
    if (node_takes_pointer(node)) return true;
    for (const struct node *ancestor = node->parent; ancestor; ancestor = ancestor->parent) {
        if (claims_pointer(ancestor)) return true;
    }
    return false;
}

static bool hit_target(const struct emit *e, const struct node *node) {
    return node_bool(node, PROP_INTERACTIVE) && (e->pointer_parent || node_takes_pointer(node));
}

/* Texture coordinates of a surface's corners: its source box, normalized, seen through
 * the inverse of its buffer transform. */
static void surface_uv(const struct surface_draw *draw, double uv[8]) {
    double buffer_width = 1, buffer_height = 1;
    if (draw->texture) {
        buffer_width = MAX(1, (int)draw->texture->width);
        buffer_height = MAX(1, (int)draw->texture->height);
    }
    double left = draw->source.x / buffer_width, top = draw->source.y / buffer_height;
    double width = draw->source.width / buffer_width, height = draw->source.height / buffer_height;
    int transform = wlr_output_transform_invert(draw->transform);
    static const double corners[4][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}};
    for (int i = 0; i < 4; i++) {
        double u, v;
        transform_normalized(transform, corners[i][0], corners[i][1], &u, &v);
        uv[2 * i] = left + u * width;
        uv[2 * i + 1] = top + v * height;
    }
}

/* Client content coordinates within BOUNDS to the node's local WIDTH x HEIGHT box. */
static struct mat3 content_transform(struct wlr_box bounds, double width, double height) {
    double scale_x = width / fmax(1, bounds.width), scale_y = height / fmax(1, bounds.height);
    return mat3_affine(scale_x, 0, 0, scale_y, -scale_x * bounds.x, -scale_y * bounds.y);
}

/* The item of one surface of a window's frame, through CONTENT; PART tells the live
 * frame from one fading out. */
static struct item *emit_surface(struct emit *e, struct node *node, struct window *window,
                                 const struct surface_draw *draw, struct mat3 t,
                                 struct mat3 content, double width, double height, double radius,
                                 double opacity, const struct filter *filter, int part, int index) {
    double local_x, local_y;
    mat3_apply(content, draw->x, draw->y, &local_x, &local_y);
    struct box box = {local_x, local_y, draw->width * content.a, draw->height * content.d};
    struct item *item =
        emit_item(e, node->id, part, index, mat3_box_bounds(t, box, 1), ITEM_SURFACE);
    if (!item) return NULL;
    item->surface.transform = t;
    item->surface.box = box;
    item->surface.mask = (struct box){0, 0, width, height};
    item->surface.radius = radius;
    item->surface.opacity = opacity;
    surface_uv(draw, item->surface.uv);
    item->signature = signature_of(e, &item->surface, sizeof item->surface);
    filter_item(e, item, node, filter);
    item->surface.texture = draw->texture;
    item->surface.buffer = draw->buffer;
    item->window = window;
    window_ref(window);
    item->surface_ptr = draw->surface;
    if (opacity >= 1 && filter->keeps_opacity) {
        struct box opaque;
        bool has_opaque = false;
        if (draw->opaque_whole) {
            opaque = (struct box){draw->x, draw->y, draw->width, draw->height};
            has_opaque = true;
        } else if (draw->opaque_box_valid) {
            opaque = (struct box){draw->x + draw->opaque_box.x, draw->y + draw->opaque_box.y,
                                  draw->opaque_box.width, draw->opaque_box.height};
            has_opaque = true;
        }
        if (has_opaque) {
            double ox, oy;
            mat3_apply(content, opaque.x, opaque.y, &ox, &oy);
            struct box local = {ox, oy, opaque.width * content.a, opaque.height * content.d};
            /* Only within the box it is masked to, and not at the rounded corners. */
            item->opaque_valid =
                box_intersect(local, item->surface.mask, &local) &&
                opaque_rectangle(e, t, inset_box(local, (double[]){radius, radius, radius, radius}),
                                 &item->opaque);
        }
    }
    return item;
}

/* A window's frame in NODE's box; a MIRROR draws it once more, taking no input. While
 * a resize crossfades, the frame from before it lies under the new one, which fades in. */
static void emit_window(struct emit *e, struct node *node, struct mat3 t, double width,
                        double height, double radius, double opacity, const struct filter *filter,
                        const struct mat3 *inverse, const struct mat3 *parent_inverse,
                        bool mirror) {
    struct window *window = window_for_node(e->server, node);
    if (!window) return;
    bool live = window_presentable(window);
    /* An exiting node shows the last frame of a window its client closed, and so does a
     * live one for the moment until the director removes it, so the frame never drops. */
    if (!live && node->state == NODE_LIVE && !window->bridging) return;
    window_surfaces(window, e->surfaces);
    if (!e->surfaces->length || !(width > 0 && height > 0)) return;
    double fade = live ? window_fade_progress(window) : 1;
    if (fade >= 1) window_fade_finished(window);
    int index = 0;
    if (fade < 1) {
        struct mat3 before = content_transform(window->fade_bounds, width, height);
        VEC_FOR(&window->fade, struct surface_draw, draw)
            emit_surface(e, node, window, draw, t, before, width, height, radius, opacity, filter,
                         16, index++);
    }
    struct mat3 content = content_transform(window_bounds(window), width, height);
    int shown = 0;
    struct wlr_box content_bounds = {0};
    index = 0;
    VEC_FOR(e->surfaces, struct surface_draw, draw) {
        box_union_wlr(&content_bounds,
                      &(struct wlr_box){draw->x, draw->y, draw->width, draw->height});
        struct item *item = emit_surface(e, node, window, draw, t, content, width, height, radius,
                                         opacity * fade, filter, 6, index++);
        if (item) shown++;
    }
    if (shown && live) {
        struct transform_entry *entry = vec_push(&e->display->transforms);
        entry->client = window;
        entry->transform = mat3_multiply(t, content);
        entry->mirror = mirror;
    }
    if (live && !mirror && node_bool(node, PROP_INTERACTIVE)) {
        struct mat3 content_inverse;
        if (mat3_invert(content, &content_inverse)) {
            struct hit extra = {
                .window = window, .content = content_inverse, .content_bounds = content_bounds};
            add_hit(e, node, inverse, parent_inverse, true, width, height, &extra);
        }
    }
}

/* Whether NODE's on-screen SCALE changed since the last rendered frame, which asks
 * for a refining frame that sees it settled. SCALE rounded to 1/32 goes to EXACT. */
static bool scale_changing(struct emit *e, const struct node *node, double scale, double *exact) {
    *exact = fmax(0.0625, round(scale * 32) / 32);
    void *stored = idmap_get(&e->display->raster_scales, node->id);
    double previous;
    uintptr_t bits = (uintptr_t)stored;
    memcpy(&previous, &bits, sizeof previous);
    memcpy(&bits, exact, sizeof bits);
    idmap_put(&e->display->next_raster_scales, node->id, (void *)bits);
    bool changing = stored && previous != *exact;
    if (changing) e->display->refine = true;
    return changing;
}

/* VALUE to OUT as 0 or plus or minus SCALE, when it is one of those but for rounding. */
static bool axis_factor(double value, double scale, double *out) {
    double tolerance = 1e-6 * scale;
    if (fabs(value) <= tolerance) *out = 0;
    else if (fabs(fabs(value) - scale) <= tolerance) *out = copysign(scale, value);
    else return false;
    return true;
}

/*
 * T with its final position rounded to whole pixels when it maps the node's axes
 * onto the buffer's at SCALE, turned by quarter turns or flipped at most, so a text
 * raster at SCALE lands texel for pixel; any other T as it is, resampled. Rounding
 * where the text ends up, never its motion, keeps a moving text's pixels the same
 * in every frame: it steps whole pixels instead of shimmering between resamplings.
 */
static struct mat3 pixel_aligned(struct mat3 t, double scale) {
    double a, b, c, d;
    if (t.g != 0 || t.h != 0 || t.i != 1 || !axis_factor(t.a, scale, &a) ||
        !axis_factor(t.b, scale, &b) || !axis_factor(t.c, scale, &c) ||
        !axis_factor(t.d, scale, &d))
        return t;
    bool straight = a != 0 && d != 0 && b == 0 && c == 0;
    bool turned = b != 0 && c != 0 && a == 0 && d == 0;
    if (!straight && !turned) return t;
    return (struct mat3){a, b, c, d, floor(t.e + 0.5), floor(t.f + 0.5), 0, 0, 1};
}

static void emit_text(struct emit *e, struct node *node, struct mat3 t, double width, double height,
                      double opacity, const struct filter *filter, const struct mat3 *inverse,
                      const struct mat3 *parent_inverse) {
    const struct media_text_layout *layout = content_text_layout(e->server, node);
    if (!layout) return;
    double color[4];
    double alpha = content_text_color(node, color) * opacity;
    const struct media_text_metrics *metrics = &layout->metrics;
    double scale = mat3_scale_factor(t, 0.5 * (metrics->left + metrics->right),
                                     0.5 * (metrics->top + metrics->bottom));
    /* Text scaled to nothing has no pixels, and no raster scale. */
    if (alpha > 0 && scale > 1e-6 && layout->style.text && layout->style.text[0]) {
        struct media_text_box box = media_text_raster_box(metrics, scale);
        double exact;
        bool changing = scale_changing(e, node, scale, &exact);
        double raster_scale = content_raster_scale(exact, changing, fmax(box.width, box.height));
        struct mat3 placed = pixel_aligned(t, raster_scale);
        uint64_t slot = key_of(1, node->id, 7, e->output->index);
        struct item *item = emit_item(
            e, node->id, 7, 0,
            mat3_box_bounds(placed, (struct box){box.left, box.top, box.width, box.height}, 1),
            ITEM_TEXT);
        if (item) {
            item->text.transform = placed;
            item->text.slot = slot;
            item->text.key = content_text_key(layout, color, raster_scale);
            item->text.scale = raster_scale;
            item->text.opacity = opacity;
            memcpy(item->text.color, color, sizeof color);
            item->text.metrics = *metrics;
            /* Text through a filter stays a raster: filters are compiled into the
             * programs drawing textures. */
            item->text.glyphs =
                !filter->shading && content_text_glyphs(e->server, node, raster_scale);
            item->signature = signature_of(e, &item->text, sizeof item->text);
            set_node(item, node);
            filter_item(e, item, node, filter);
            if (!item->text.glyphs) content_touch_raster(e->server, slot);
        }
    }
    if (hit_target(e, node)) add_hit(e, node, inverse, parent_inverse, true, width, height, NULL);
}

static void emit_image(struct emit *e, struct node *node, struct mat3 t, double width,
                       double height, double radius, double opacity, const struct filter *filter,
                       const struct mat3 *inverse, const struct mat3 *parent_inverse) {
    if (!(width > 0 && height > 0)) return;
    struct media_image *image = content_image(e->server, node);
    if (image && content_image_shown(e->server, image)) {
        struct box quad;
        double uv[8];
        content_image_fit(node_choice(node, PROP_FIT), image, width, height, &quad, uv);
        struct item *item = emit_item(e, node->id, 8, 0, mat3_box_bounds(t, quad, 1), ITEM_IMAGE);
        if (item) {
            item->image.transform = t;
            item->image.box = quad;
            memcpy(item->image.uv, uv, sizeof uv);
            item->image.radius = node_choice(node, PROP_FIT) == FIT_CONTAIN ? 0 : radius;
            item->image.opacity = opacity;
            item->signature = signature_of(e, &item->image, sizeof item->image);
            item->signature = hash_bytes(item->signature, &image->serial, sizeof image->serial);
            set_node(item, node);
            filter_item(e, item, node, filter);
        }
    }
    if (hit_target(e, node)) add_hit(e, node, inverse, parent_inverse, true, width, height, NULL);
}

static void emit_web(struct emit *e, struct node *node, struct mat3 t, double width, double height,
                     double radius, double opacity, const struct filter *filter,
                     const struct mat3 *inverse, const struct mat3 *parent_inverse) {
    struct web_page *page = web_node_page(node);
    if (!page || !(width > 0 && height > 0)) return;
    struct mat3 content = web_node_content(page, width, height);
    struct box box = mat3_box_bounds(t, (struct box){0, 0, width, height}, 0), screen = e->bounds;
    /* Presence follows the box, not the frames, so a page shows up as soon as its
     * first frame arrives. */
    if ((!e->clip.clipped || box_intersect(e->clip.box, e->bounds, &screen)) &&
        box_overlaps(box, screen)) {
        struct transform_entry *entry = vec_push(&e->display->transforms);
        entry->client = page;
        entry->transform = mat3_multiply(t, content);
        double scale = mat3_scale_factor(t, width / 2, height / 2);
        double exact;
        bool changing = scale_changing(e, node, scale, &exact);
        web_node_presented(node, e->output, exact, !changing, width);
    }
    if (web_page_has_frame(page)) {
        struct item *item = emit_item(
            e, node->id, 10, 0, mat3_box_bounds(t, (struct box){0, 0, width, height}, 1), ITEM_WEB);
        if (item) {
            item->web.transform = t;
            item->web.width = width;
            item->web.height = height;
            item->web.radius = radius;
            item->web.opacity = opacity;
            item->signature = signature_of(e, &item->web, sizeof item->web);
            set_node(item, node);
            filter_item(e, item, node, filter);
        }
    }
    struct mat3 content_inverse;
    if (node_bool(node, PROP_INTERACTIVE) && mat3_invert(content, &content_inverse)) {
        double page_width, page_height;
        web_page_size(page, &page_width, &page_height);
        struct hit extra = {
            .page = page,
            .content = content_inverse,
            .content_bounds = {0, 0, (int)ceil(page_width), (int)ceil(page_height)}};
        add_hit(e, node, inverse, parent_inverse, true, width, height, &extra);
    }
}

/* Emit NODE's own items, drawn through T at WIDTH x HEIGHT: paints under its
 * content, the content through its filter, then paints over it. */
static void emit_content(struct emit *e, struct node *node, struct mat3 t, double width,
                         double height, double opacity, const struct mat3 *inverse,
                         const struct mat3 *parent_inverse) {
    const struct mat3 *pi = parent_inverse;
    double radius = fmax(0, node_number(node, PROP_RADIUS, 0));
    emit_paints(e, node, t, width, height, radius, opacity, false);
    struct filter filter;
    node_filter(e, node, t, width, height, radius, &filter);
    switch (node->kind) {
    case KIND_GROUP:
        /* A sized group taking the pointer catches it over its whole box, as a div does. */
        if (node_given(node, PROP_WIDTH) && node_given(node, PROP_HEIGHT) && hit_target(e, node))
            add_hit(e, node, inverse, pi, true, width, height, NULL);
        break;
    case KIND_BACKGROUND:
        if (hit_target(e, node)) add_hit(e, node, inverse, pi, false, 0, 0, NULL);
        break;
    case KIND_WINDOW:
    case KIND_MIRROR:
        emit_window(e, node, t, width, height, radius, opacity, &filter, inverse, pi,
                    node->kind == KIND_MIRROR);
        break;
    case KIND_TEXT: emit_text(e, node, t, width, height, opacity, &filter, inverse, pi); break;
    case KIND_IMAGE:
        emit_image(e, node, t, width, height, radius, opacity, &filter, inverse, pi);
        break;
    case KIND_WEB:
        emit_web(e, node, t, width, height, radius, opacity, &filter, inverse, pi);
        break;
    default: break;
    }
    emit_paints(e, node, t, width, height, radius, opacity, true);
}

static void emit_children(struct emit *e, struct node *node, const struct mat4 *base,
                          const struct mat3 *base_inverse, double opacity);

/* Clip what is emitted next to BOX, within the clip in force. */
static void clip_to(struct emit *e, struct box box) {
    struct box clip = box;
    if (e->clip.clipped && !box_intersect(box, e->clip.box, &clip)) clip = (struct box){0};
    e->clip.clipped = true;
    e->clip.box = clip;
    if (e->has_to_logical) {
        e->clip.logical_clipped = true;
        e->clip.logical = mat3_box_bounds(e->to_logical, clip, 0);
    }
}

/* Emit NODE's children, clipped to its WIDTH x HEIGHT box through T if it clips them. */
static void emit_subtree(struct emit *e, struct node *node, struct mat3 t, double width,
                         double height, const struct mat4 *chain, const struct mat3 *local_inverse,
                         double opacity) {
    struct clip_state clip = e->clip;
    bool pointer_parent = e->pointer_parent;
    if (node_bool(node, PROP_CLIP))
        clip_to(e, mat3_box_bounds(t, (struct box){0, 0, width, height}, 0));
    e->pointer_parent = pointer_parent || claims_pointer(node);
    emit_children(e, node, chain, local_inverse, opacity);
    e->clip = clip;
    e->pointer_parent = pointer_parent;
}

/* Draw NODE and its subtree offscreen, then through SHADING, its effect, with VALUES. */
static void emit_effect(struct emit *e, struct node *node, const struct shading *shading,
                        const float *values, struct mat3 t, double node_width, double node_height,
                        const struct mat4 *chain, double opacity, const struct mat3 *inverse,
                        const struct mat3 *parent_inverse) {
    struct shader *shader = shading->shader;
    bool whole_output = shading->whole_output;
    /* Over the whole output, positions are output-logical pixels. */
    struct mat3 quad_transform = whole_output ? e->screen : t;
    double width = whole_output ? e->output->width : node_width,
           height = whole_output ? e->output->height : node_height,
           radius = whole_output ? 0 : fmax(0, node_number(node, PROP_RADIUS, 0)), sides[4];
    shader_bound(&shader->extent, values, radius,
                 mat3_pixel_size(quad_transform, width / 2, height / 2), sides);
    struct box quad = {-sides[0], -sides[1], width + sides[0] + sides[2],
                       height + sides[1] + sides[3]};
    if (!(quad.width > 0 && quad.height > 0)) return;
    struct item *item =
        emit_item(e, node->id, 12, 0, mat3_box_bounds(quad_transform, quad, 1), ITEM_EFFECT);
    if (!item) return;
    item->effect.draw.transform = quad_transform;
    item->effect.draw.quad = quad;
    item->effect.draw.opacity = opacity;
    record_shading(e, shading, values, quad_transform, width, height, radius, &item->shading);
    item->signature = signature_of(e, &item->effect.draw, sizeof item->effect.draw);
    shading_signature(e, item, shading);
    set_node(item, node);
    /* Unless the shader reads only its own pixel, any change inside repaints all of it. */
    if (!(shader->local && !shader->backdrop)) {
        item->reads = true;
        item->read_area = item->bounds;
    }
    int index = (int)(item - (struct item *)e->items->data);
    int owner = e->owner;
    struct clip_state clip = e->clip;
    bool in_effect = e->in_effect;
    struct box effect_area = e->effect_area;
    e->owner = index;
    e->in_effect = true;
    e->effect_area = item->bounds;
    /* The item's bounds already lie within the clip in force. */
    clip_to(e, item->bounds);
    /* The effect applies the node's opacity to its content as a whole. */
    emit_content(e, node, t, node_width, node_height, 1, inverse, parent_inverse);
    emit_subtree(e, node, t, node_width, node_height, chain, inverse, 1);
    ((struct item *)vec_at(e->items, index))->effect.end = (int)e->items->length;
    e->owner = owner;
    e->clip = clip;
    e->in_effect = in_effect;
    e->effect_area = effect_area;
}

static void emit_node(struct emit *e, struct node *node, const struct mat4 *base,
                      const struct mat3 *base_inverse, double opacity) {
    if (node->state == NODE_DEAD || !node_bool(node, PROP_VISIBLE)) return;
    switch (node->kind) {
    case KIND_CAMERA:
    case KIND_RESERVE:
    case KIND_SHORTCUT:
    case KIND_POINTER_BINDING:
    case KIND_WHEEL_BINDING:
    case KIND_GESTURE_BINDING: return;
    default: break;
    }
    struct mat4 identity = MAT4_IDENTITY;
    const struct mat4 *space = e->space, *space_inverse = e->space_inverse;
    if (node->kind == KIND_SCREEN) {
        const char *name = node_string(node, PROP_OUTPUT);
        if (name && strcmp(name, output_name(e->output))) return;
        /* A screen restarts from output pixels, ignoring the camera. */
        base = &identity;
        base_inverse = &MAT3_IDENTITY;
    }
    double width, height;
    node_size(e->server, node, &width, &height);
    struct mat4 local = node_matrix(node, width, height);
    struct mat4 chain = mat4_multiply(base, &local);
    if (node->kind == KIND_WEB)
        web_node_hold(node, e->space, e->space_inverse, &chain, &width, &height);
    /* The node draws on its z = 0 plane, and its hits map back onto it. */
    struct mat3 plane = mat4_plane(&chain);
    struct mat3 t = mat3_multiply(e->screen, plane);
    opacity *= CLAMP(node_number(node, PROP_OPACITY, 1), 0.0, 1.0);
    if (!(opacity > 0)) return;
    /* With its back hidden, a node turned away is not drawn, nor what it holds. */
    if (node_choice(node, PROP_BACKFACE) == BACKFACE_HIDDEN && mat3_determinant(plane) <= 0) return;
    /* Output-logical points back to the node's plane, for its hits. */
    struct mat3 local_inverse;
    const struct mat3 *inverse = mat3_invert(plane, &local_inverse) ? &local_inverse : NULL;
    bool moving = e->moving;
    e->moving = moving || node->active;
    const struct shading *effect = node_stage_shading(node, STAGE_EFFECT);
    float values[SHADER_COMPONENTS_MAX];
    if (node->kind == KIND_SCREEN) e->space = e->space_inverse = &MAT4_IDENTITY;
    /* An effect showing nothing by its gate leaves the node drawn as it is. */
    if (effect && shading_values(node, effect, values)) {
        emit_effect(e, node, effect, values, t, width, height, &chain, opacity, inverse,
                    base_inverse);
    } else {
        emit_content(e, node, t, width, height, opacity, inverse, base_inverse);
        emit_subtree(e, node, t, width, height, &chain, inverse, opacity);
    }
    e->space = space;
    e->space_inverse = space_inverse;
    e->moving = moving;
}

static void emit_children(struct emit *e, struct node *node, const struct mat4 *base,
                          const struct mat3 *base_inverse, double opacity) {
    NODE_FOR_CHILDREN(node, child) emit_node(e, child, base, base_inverse, opacity);
}

/* Lists and their lifetime. */

static void release_items(struct vec *items) {
    VEC_FOR(items, struct item, item) {
        if (item->node) node_unref(item->node);
        if (item->window) window_unref(item->window);
    }
    vec_clear(items);
}

/* Sets no frame or display holds, kept for their vectors' room. */
static struct vec spare_sets; /* struct item_set * */

static struct item_set *item_set_new(void) {
    struct item_set *set;
    if (spare_sets.length) {
        set = *(struct item_set **)vec_at(&spare_sets, spare_sets.length - 1);
        spare_sets.length--;
    } else {
        set = xcalloc(1, sizeof *set);
        vec_init(&set->items, sizeof(struct item));
        vec_init(&set->values, sizeof(float));
    }
    set->refs = 1;
    return set;
}

static void item_set_release(struct item_set *set) {
    if (--set->refs) return;
    release_items(&set->items);
    vec_clear(&set->values);
    if (!spare_sets.element) vec_init(&spare_sets, sizeof(struct item_set *));
    if (spare_sets.length < 4) {
        *(struct item_set **)vec_push(&spare_sets) = set;
        return;
    }
    vec_finish(&set->items);
    vec_finish(&set->values);
    free(set);
}

/* SET emptied for building anew: itself, unless a frame still draws it. */
static struct item_set *item_set_fresh(struct item_set *set) {
    if (set->refs == 1) {
        release_items(&set->items);
        vec_clear(&set->values);
        return set;
    }
    item_set_release(set);
    return item_set_new();
}

static void release_hits(struct display *display) {
    VEC_FOR(&display->hits, struct hit, hit) {
        if (hit->node) node_unref(hit->node);
        if (hit->window) window_unref(hit->window);
    }
    vec_clear(&display->hits);
}

struct display *display_create(struct output *output) {
    struct display *display = xcalloc(1, sizeof *display);
    display->output = output;
    wlr_damage_ring_init(&display->ring);
    pixman_region32_init(&display->pending);
    display->scene = item_set_new();
    display->seat = item_set_new();
    vec_init(&display->frames, sizeof(struct display_frame *));
    vec_init(&display->hits, sizeof(struct hit));
    vec_init(&display->transforms, sizeof(struct transform_entry));
    vec_init(&display->diffed, sizeof(struct diffed));
    vec_init(&display->seat_diffed, sizeof(struct diffed));
    vec_init(&display->spare, sizeof(struct diffed));
    vec_init(&display->kept, sizeof(struct kept));
    vec_init(&display->surfaces, sizeof(struct surface_draw));
    vec_init(&display->gathered, sizeof(pixman_box32_t));
    idmap_init(&display->raster_scales);
    idmap_init(&display->next_raster_scales);
    return display;
}

static void destroy_target(void *target) {
    render_target_destroy(target);
}

void display_destroy(struct display *display) {
    if (!display) return;
    if (display->checked)
        wlr_log(WLR_INFO, "check: %s: %d of %d frames differed from a full redraw",
                output_name(display->output), display->mismatched, display->checked);
    if (display->check_target)
        server_render(display->output->server, destroy_target, display->check_target);
    item_set_release(display->scene);
    item_set_release(display->seat);
    vec_finish(&display->frames);
    release_hits(display);
    vec_finish(&display->hits);
    vec_finish(&display->transforms);
    vec_finish(&display->diffed);
    vec_finish(&display->seat_diffed);
    vec_finish(&display->spare);
    vec_finish(&display->kept);
    vec_finish(&display->surfaces);
    vec_finish(&display->gathered);
    idmap_finish(&display->raster_scales);
    idmap_finish(&display->next_raster_scales);
    wlr_damage_ring_finish(&display->ring);
    pixman_region32_fini(&display->pending);
    free(display);
}

void display_invalidate(struct output *output) {
    if (output->display) output->display->valid = false;
}

void invalidate_displays(struct server *server) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) display_invalidate(output);
}

void scene_changed(struct server *server) {
    invalidate_displays(server);
    request_frames(server);
}

static struct mat3 screen_transform(struct output *output) {
    struct display *display = output->display;
    return output_buffer_transform(output->width, output->height, display->buffer_width,
                                   display->buffer_height, display->transform);
}

static void emit_init(struct emit *e, struct output *output, struct item_set *set, uint64_t tag) {
    struct display *display = output->display;
    *e = (struct emit){
        .server = output->server,
        .output = output,
        .display = display,
        .items = &set->items,
        .values = &set->values,
        .tag = tag,
        .screen = screen_transform(output),
        .bounds = {0, 0, display->buffer_width, display->buffer_height},
        .owner = -1,
    };
    e->has_to_logical = mat3_invert(e->screen, &e->to_logical);
    e->surfaces = &display->surfaces;
    vec_clear(e->surfaces);
}

static void build(struct output *output, struct emit *e) {
    struct server *server = output->server;
    struct display *display = output->display;
    display->scene = item_set_fresh(display->scene);
    release_hits(display);
    vec_clear(&display->transforms);
    idmap_clear(&display->next_raster_scales);
    display->pointer_shaders = false;
    display->refine = false;
    emit_init(e, output, display->scene, 0);
    struct mat3 camera = camera_transform(output), camera_inverse;
    if (!mat3_invert(camera, &camera_inverse)) camera_inverse = MAT3_IDENTITY;
    struct mat4 camera_matrix = mat4_from_mat3(camera);
    e->tag = 1;
    struct mat4 camera_matrix_inverse = mat4_from_mat3(camera_inverse);
    e->space = &camera_matrix;
    e->space_inverse = &camera_matrix_inverse;
    emit_children(e, &server->scene.root, &camera_matrix, &camera_inverse, 1);
    if (output == output_first(server)) {
        e->tag = 2;
        struct mat4 identity = MAT4_IDENTITY;
        e->space = e->space_inverse = &MAT4_IDENTITY;
        emit_children(e, &server->fallback.root, &identity, &MAT3_IDENTITY, 1);
    }
    /* Hits are recorded bottom first; picking wants the topmost first. */
    size_t count = display->hits.length;
    struct hit *hits = display->hits.data;
    for (size_t i = 0; i < count / 2; i++) {
        struct hit swap = hits[i];
        hits[i] = hits[count - 1 - i];
        hits[count - 1 - i] = swap;
    }
    /* Motion that just came into view keeps frames coming: the frame building this
     * display was asked for before it showed any. */
    if (e->animating && !display->animating) output_request_frame(output);
    display->animating = e->animating;
    display->built_at = now_seconds();
    display->diffed_current = false;
    /* Text drawn at an approximate scale is drawn again by the next frame. */
    display->valid = !display->refine;
    if (display->refine) output_request_frame(output);
}

static void refresh(struct output *output) {
    if (output->display->valid) return;
    struct emit e;
    build(output, &e);
}

struct hit *display_hits(struct output *output, size_t *count) {
    struct display *display = output->display;
    /* While a frame is on its way the hits stay those of the frame on screen, which is
     * what the user points at, so input during an animation never rebuilds between frames. */
    if (!(display->scene->items.length && output->awaiting_frame)) refresh(output);
    *count = display->hits.length;
    return display->hits.data;
}

bool display_pointer_shaders(struct output *output) {
    return output->display && output->display->pointer_shaders;
}

/* Damage. */

static void add_box_damage(struct display *display, struct box box) {
    struct pixel_box pixels = box_pixels(box, display->buffer_width, display->buffer_height);
    if (pixels.width > 0 && pixels.height > 0)
        pixman_region32_union_rect(&display->pending, &display->pending, pixels.x, pixels.y,
                                   pixels.width, pixels.height);
}

/*
 * Diffing gathers its damage as boxes, which become a region at once: united
 * rectangle by rectangle, a region of hundreds of them costs time quadratic in
 * their number.
 */
static void gather_box(struct display *display, struct box box) {
    struct pixel_box p = box_pixels(box, display->buffer_width, display->buffer_height);
    if (p.width > 0 && p.height > 0)
        *(pixman_box32_t *)vec_push(&display->gathered) =
            (pixman_box32_t){p.x, p.y, p.x + p.width, p.y + p.height};
}

static void gather_item_damage(struct display *display, const struct item *item) {
    if (item->damage_count) {
        for (int i = 0; i < item->damage_count; i++) gather_box(display, item->damage[i]);
    } else {
        gather_box(display, item->bounds);
    }
}

static void gather_diffed_damage(struct display *display, const struct diffed *old) {
    for (int i = 0; i < old->damage_count; i++) gather_box(display, old->damage[i]);
}

static void add_gathered_damage(struct display *display) {
    if (!display->gathered.length) return;
    pixman_region32_t region;
    pixman_region32_init_rects(&region, display->gathered.data, (int)display->gathered.length);
    pixman_region32_union(&display->pending, &display->pending, &region);
    pixman_region32_fini(&region);
    vec_clear(&display->gathered);
}

static int compare_diffed(const void *a, const void *b) {
    uint64_t x = ((const struct diffed *)a)->key, y = ((const struct diffed *)b)->key;
    return x < y ? -1 : x > y;
}

static struct diffed *find_diffed(struct vec *table, uint64_t key) {
    struct diffed probe = {.key = key};
    return bsearch(&probe, table->data, table->length, sizeof probe, compare_diffed);
}

/*
 * Damage every item whose pixels may have changed since PREVIOUS, the last diffed
 * table; refill PREVIOUS for ITEMS. Items appearing or leaving damage only
 * themselves; items changing places damage only the fewest that moved: all but a
 * longest run still in the old order.
 */
static void diff_items(struct display *display, struct vec *items, struct vec *previous) {
    struct vec *current = &display->spare;
    vec_clear(current);
    /* Unchanged items in new paint order, with where they were. */
    struct vec *kept = &display->kept;
    vec_clear(kept);
    bool in_order = true;
    int last_old = -1;
    for (size_t i = 0; i < items->length; i++) {
        struct item *item = vec_at(items, i);
        struct diffed *entry = vec_push(current);
        entry->key = item->key;
        entry->signature = item->signature;
        entry->index = (int)i;
        if (item->damage_count) {
            entry->damage_count = item->damage_count;
            memcpy(entry->damage, item->damage, sizeof item->damage);
        } else {
            entry->damage_count = 1;
            entry->damage[0] = item->bounds;
        }
    }
    qsort(current->data, current->length, sizeof(struct diffed), compare_diffed);
    for (size_t i = 0; i < items->length; i++) {
        struct item *item = vec_at(items, i);
        struct diffed *old = find_diffed(previous, item->key);
        if (!old || old->signature != item->signature) {
            gather_item_damage(display, item);
            if (old) gather_diffed_damage(display, old);
        } else {
            if (old->index < last_old) in_order = false;
            last_old = old->index;
            *(struct kept *)vec_push(kept) = (struct kept){(int)i, old->index};
        }
    }
    VEC_FOR(previous, struct diffed, old) {
        if (!find_diffed(current, old->key)) gather_diffed_damage(display, old);
    }
    if (!in_order) {
        /* Patience sorting finds the longest run still in old order; the rest moved. */
        size_t count = kept->length;
        const struct kept *run = kept->data;
        int *tails = xcalloc(count + 1, sizeof *tails);
        int *links = xcalloc(count + 1, sizeof *links);
        bool *steady = xcalloc(count + 1, sizeof *steady);
        int length = 0;
        for (size_t p = 0; p < count; p++) {
            int low = 0, high = length;
            while (low < high) {
                int middle = (low + high) / 2;
                if (run[tails[middle]].old < run[p].old) low = middle + 1;
                else high = middle;
            }
            links[p] = low > 0 ? tails[low - 1] : -1;
            tails[low] = (int)p;
            if (low == length) length++;
        }
        for (int p = length ? tails[length - 1] : -1; p >= 0; p = links[p]) steady[p] = true;
        for (size_t p = 0; p < count; p++) {
            if (!steady[p]) gather_item_damage(display, vec_at(items, (size_t)run[p].item));
        }
        free(tails);
        free(links);
        free(steady);
    }
    add_gathered_damage(display);
    /* The table just built becomes the previous one. */
    struct vec swap = *previous;
    *previous = *current;
    *current = swap;
}

void display_add_damage(struct output *output, const pixman_region32_t *damage) {
    if (output->display)
        pixman_region32_union(&output->display->pending, &output->display->pending,
                              (pixman_region32_t *)damage);
}

void display_set_tap(struct output *output, display_tap tap, void *data) {
    struct display *display = output->display;
    if (!display) return;
    display->tap = tap;
    display->tap_data = data;
}

void display_damage_whole(struct output *output) {
    struct display *display = output->display;
    if (!display) return;
    wlr_damage_ring_add_whole(&display->ring);
    pixman_region32_union_rect(&display->pending, &display->pending, 0, 0,
                               MAX(display->buffer_width, 1), MAX(display->buffer_height, 1));
    display->valid = false;
}

bool display_window_logical_transform(struct output *output, struct window *window,
                                      struct mat3 *out) {
    struct display *display = output->display;
    if (!display) return false;
    VEC_FOR(&display->transforms, struct transform_entry, entry) {
        if (entry->client != window || entry->mirror) continue;
        struct mat3 to_logical;
        if (!mat3_invert(screen_transform(output), &to_logical)) return false;
        *out = mat3_multiply(to_logical, entry->transform);
        return true;
    }
    return false;
}

void displays_damage_client(struct server *server, void *client, const pixman_region32_t *damage) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        struct display *display = output->display;
        bool shown = false;
        VEC_FOR(&display->transforms, struct transform_entry, entry) {
            if (entry->client != client) continue;
            shown = true;
            int count;
            pixman_box32_t *boxes = pixman_region32_rectangles((pixman_region32_t *)damage, &count);
            for (int i = 0; i < count; i++) {
                struct box box = {boxes[i].x1, boxes[i].y1, boxes[i].x2 - boxes[i].x1,
                                  boxes[i].y2 - boxes[i].y1};
                add_box_damage(display, box_inflate(mat3_box_bounds(entry->transform, box, 0), 1));
            }
        }
        if (shown) output_request_frame(output);
    }
}

void displays_forget_window(struct server *server, struct window *window) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) display_forget_client(output, window);
}

void displays_forget_surface(struct server *server, struct wlr_surface *surface) {
    struct output *output;
    wl_list_for_each(output, &server->outputs, link) {
        struct display *display = output->display;
        bool found = false;
        struct vec *lists[] = {&display->scene->items, &display->seat->items};
        for (int l = 0; l < 2; l++) {
            VEC_FOR(lists[l], struct item, item) {
                if (item->surface_ptr == surface) {
                    item->surface_ptr = NULL;
                    item->surface.texture = NULL;
                    found = true;
                }
            }
        }
        /* Frames on their way hold its buffer; only telling it goes. */
        VEC_FOR(&display->frames, struct display_frame *, frame) {
            VEC_FOR(&(*frame)->presented, struct wlr_surface *, slot)
                if (*slot == surface) *slot = NULL;
            VEC_FOR(&(*frame)->callbacks, struct wlr_surface *, slot)
                if (*slot == surface) *slot = NULL;
        }
        if (found) display->valid = false;
    }
}

bool display_shows_client(struct output *output, void *client) {
    VEC_FOR(&output->display->transforms, struct transform_entry, entry) {
        if (entry->client == client) return true;
    }
    return false;
}

void display_forget_client(struct output *output, void *client) {
    struct display *display = output->display;
    for (size_t i = 0; i < display->transforms.length;) {
        struct transform_entry *entry = vec_at(&display->transforms, i);
        if (entry->client == client) vec_remove(&display->transforms, i);
        else i++;
    }
    VEC_FOR(&display->hits, struct hit, hit)
        if (hit->page == client) hit->page = NULL;
    display->valid = false;
}

bool display_animating(struct output *output) {
    return output->display && output->display->animating;
}

bool display_damage_node(struct output *output, struct node *node) {
    struct display *display = output->display;
    struct vec *items = &display->scene->items;
    for (size_t i = 0; i < items->length; i++) {
        struct item *item = vec_at(items, i);
        if (item->node != node || item->kind != ITEM_TEXT) continue;
        while (item->owner >= 0) item = vec_at(items, item->owner);
        add_box_damage(display, item->bounds);
        output_request_frame(output);
        return true;
    }
    return false;
}

double displays_built_at(struct server *server) {
    double earliest = now_seconds();
    struct output *output;
    wl_list_for_each(output, &server->outputs, link)
        earliest = fmin(earliest, output->display->built_at);
    return earliest;
}

/* Passes. */

struct rect {
    int x0, y0, x1, y1;
};

static long rect_area(struct rect r) {
    return (long)(r.x1 - r.x0) * (r.y1 - r.y0);
}

static struct rect rect_union(struct rect a, struct rect b) {
    return (struct rect){MIN(a.x0, b.x0), MIN(a.y0, b.y0), MAX(a.x1, b.x1), MAX(a.y1, b.y1)};
}

static bool rects_overlap(struct rect a, struct rect b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/* The part of A outside HOLE, as up to four rectangles into OUT; return how many. */
static int rect_subtract(struct rect a, struct rect hole, struct rect out[4]) {
    if (!rects_overlap(a, hole)) {
        out[0] = a;
        return 1;
    }
    int count = 0, top = MAX(a.y0, hole.y0), bottom = MIN(a.y1, hole.y1);
    if (a.y0 < hole.y0) out[count++] = (struct rect){a.x0, a.y0, a.x1, hole.y0};
    if (hole.y1 < a.y1) out[count++] = (struct rect){a.x0, hole.y1, a.x1, a.y1};
    if (a.x0 < hole.x0) out[count++] = (struct rect){a.x0, top, hole.x0, bottom};
    if (hole.x1 < a.x1) out[count++] = (struct rect){hole.x1, top, a.x1, bottom};
    return count;
}

/* A and B's common part, empty (x0 >= x1 or y0 >= y1) when they do not overlap. */
static struct rect rect_intersect(struct rect a, struct rect b) {
    return (struct rect){MAX(a.x0, b.x0), MAX(a.y0, b.y0), MIN(a.x1, b.x1), MIN(a.y1, b.y1)};
}

/* The buffer pixels BOX touches, within a WIDTH x HEIGHT buffer. */
static struct rect pixel_rect(struct box box, int width, int height) {
    struct pixel_box p = box_pixels(box, width, height);
    return (struct rect){p.x, p.y, p.x + p.width, p.y + p.height};
}

static bool rect_contains(struct rect outer, struct rect inner) {
    return outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 &&
           outer.y1 >= inner.y1;
}

/* What merging A and B costs in extra pixels. */
static long merge_cost(struct rect a, struct rect b) {
    return rect_area(rect_union(a, b)) - rect_area(a) - rect_area(b);
}

/* Bound pixel damage, trading extra pixels against repeated passes: nearby rectangles
 * merge when that is cheaper, at most 32 at a time. */
static void coalesce(struct vec *region, struct rect rect, long cost) {
    while (true) {
        int best = -1;
        long best_cost = 0;
        for (size_t i = 0; i < region->length; i++) {
            long extra = merge_cost(rect, *(struct rect *)vec_at(region, i));
            if (extra <= cost && (best < 0 || extra < best_cost)) {
                best = (int)i;
                best_cost = extra;
            }
        }
        if (best < 0) break;
        rect = rect_union(rect, *(struct rect *)vec_at(region, best));
        vec_remove(region, best);
    }
    *(struct rect *)vec_push(region) = rect;
    if (region->length <= 32) return;
    int left = 0, right = 1;
    long best_cost = -1;
    for (size_t i = 0; i < region->length; i++) {
        for (size_t j = i + 1; j < region->length; j++) {
            long extra =
                merge_cost(*(struct rect *)vec_at(region, i), *(struct rect *)vec_at(region, j));
            if (best_cost < 0 || extra < best_cost) {
                best_cost = extra;
                left = (int)i;
                right = (int)j;
            }
        }
    }
    struct rect merged =
        rect_union(*(struct rect *)vec_at(region, left), *(struct rect *)vec_at(region, right));
    vec_remove(region, right);
    vec_remove(region, left);
    coalesce(region, merged, cost);
}

/* An item reading what lies under it, a backdrop or an effect, reads every pixel of its
 * area, so an area the repair reaches is painted whole by one pass, merged with any
 * area it overlaps, and no other pass touches it. */
static void reader_passes(struct vec *region, struct vec *items, int width, int height) {
    struct vec areas, reached;
    vec_init(&areas, sizeof(struct rect));
    vec_init(&reached, sizeof(struct rect));
    VEC_FOR(items, struct item, item) {
        if (!item->reads) continue;
        struct rect area = pixel_rect(item->read_area, width, height);
        if (rect_area(area) > 0) *(struct rect *)vec_push(&areas) = area;
    }
    bool changed = true;
    while (changed) {
        changed = false;
        for (size_t i = 0; i < areas.length;) {
            struct rect area = *(struct rect *)vec_at(&areas, i);
            bool touched = false;
            VEC_FOR(region, struct rect, r)
                if (rects_overlap(*r, area)) touched = true;
            VEC_FOR(&reached, struct rect, r)
                if (rects_overlap(*r, area)) touched = true;
            if (!touched) {
                i++;
                continue;
            }
            vec_remove(&areas, i);
            changed = true;
            for (size_t j = 0; j < reached.length;) {
                struct rect other = *(struct rect *)vec_at(&reached, j);
                if (rects_overlap(other, area)) {
                    area = rect_union(area, other);
                    vec_remove(&reached, j);
                    j = 0;
                } else {
                    j++;
                }
            }
            *(struct rect *)vec_push(&reached) = area;
        }
    }
    if (reached.length) {
        /* A rectangle holding an area whole paints it; otherwise the area is a pass of its own. */
        struct vec out;
        vec_init(&out, sizeof(struct rect));
        VEC_FOR(region, struct rect, r) {
            struct vec pieces;
            vec_init(&pieces, sizeof(struct rect));
            *(struct rect *)vec_push(&pieces) = *r;
            VEC_FOR(&reached, struct rect, area) {
                if (rect_contains(*r, *area)) continue;
                struct vec next;
                vec_init(&next, sizeof(struct rect));
                VEC_FOR(&pieces, struct rect, piece) {
                    struct rect cut[4];
                    int count = rect_subtract(*piece, *area, cut);
                    for (int k = 0; k < count; k++) *(struct rect *)vec_push(&next) = cut[k];
                }
                vec_finish(&pieces);
                pieces = next;
            }
            VEC_FOR(&pieces, struct rect, piece) *(struct rect *)vec_push(&out) = *piece;
            vec_finish(&pieces);
        }
        VEC_FOR(&reached, struct rect, area) {
            bool held = false;
            VEC_FOR(region, struct rect, r)
                if (rect_contains(*r, *area)) held = true;
            if (!held) *(struct rect *)vec_push(&out) = *area;
        }
        vec_finish(region);
        *region = out;
    }
    vec_finish(&areas);
    vec_finish(&reached);
}

/* Paint passes repairing REPAIR: nearby rectangles merged, whole reader areas, or the
 * whole buffer once that is cheaper. */
static void frame_passes(const pixman_region32_t *repair, struct vec *items, int width, int height,
                         struct vec *passes) {
    vec_clear(passes);
    int count;
    pixman_box32_t *boxes = pixman_region32_rectangles((pixman_region32_t *)repair, &count);
    for (int i = 0; i < count; i++) {
        struct rect r = {MAX(0, boxes[i].x1), MAX(0, boxes[i].y1), MIN(width, boxes[i].x2),
                         MIN(height, boxes[i].y2)};
        if (r.x0 < r.x1 && r.y0 < r.y1) coalesce(passes, r, PASS_COST);
    }
    if (!passes->length) return;
    reader_passes(passes, items, width, height);
    long cost = 0;
    VEC_FOR(passes, struct rect, r) cost += rect_area(*r) + PASS_COST;
    if ((long)width * height + PASS_COST <= cost) {
        vec_clear(passes);
        *(struct rect *)vec_push(passes) = (struct rect){0, 0, width, height};
    }
}

/* Drawing. */

static bool box_contains_rect(struct box outer, struct rect inner) {
    return outer.x <= inner.x0 && outer.y <= inner.y0 && box_right(outer) >= inner.x1 &&
           box_bottom(outer) >= inner.y1;
}

/* The whole pixels an opaque box covers; false when none. */
static bool covered(struct box box, struct rect *out) {
    struct rect r = {(int)ceil(box.x), (int)ceil(box.y), (int)floor(box_right(box)),
                     (int)floor(box_bottom(box))};
    *out = r;
    return r.x0 < r.x1 && r.y0 < r.y1;
}

struct hole {
    int position;
    struct rect rect;
};

static int compare_holes(const void *a, const void *b) {
    long x = rect_area(((const struct hole *)a)->rect),
         y = rect_area(((const struct hole *)b)->rect);
    return x > y ? -1 : x < y;
}

/*
 * Frames. A frame is what drawing reads, prepared on the main thread: the item sets it
 * draws, held; what each item draws from (a surface's texture, its buffer locked; a
 * raster's slot; text's glyphs); the uploads that put rasters and glyphs in place; and
 * the passes. Drawing reads nothing else, so it can run on the render thread while the
 * main thread builds the next frame. A frame whose items call into main-thread state
 * while drawing (web pages) is SYNC: the main thread waits for it.
 */

static void draw_items_range(struct display_frame *frame, int set, int first, int end, int owner,
                             struct rect pass);

static void set_scissor(struct server *server, struct rect r) {
    render_set_scissor(server->renderer, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
}

/* Add SURFACE to SURFACES, a vector of struct wlr_surface *, unless it is there. */
static void add_surface_once(struct vec *surfaces, struct wlr_surface *surface) {
    VEC_FOR(surfaces, struct wlr_surface *, slot)
        if (*slot == surface) return;
    *(struct wlr_surface **)vec_push(surfaces) = surface;
}

void display_prepare_shader(struct server *server, struct shader *shader) {
    if (!shader->program) shader->program = render_shader_create(shader);
}

/* What the renderer draws RECORDED of SET with, into OUT; NULL without a shader or its
 * program, which preparing the frame made. */
static const struct render_shading *shading_of(const struct display_frame *frame, int set,
                                               const struct item_shading *recorded,
                                               struct render_shading *out) {
    struct shader *shader = recorded->shader;
    if (!shader || !shader->program) return NULL;
    *out = (struct render_shading){
        .shader = shader->program,
        .values = shader->component_count
                      ? vec_at(&frame->sets[set]->values, (size_t)recorded->values)
                      : NULL,
        .size = {recorded->size[0], recorded->size[1]},
        .radius = recorded->radius,
        .time = recorded->time,
        .pointer = {recorded->pointer[0], recorded->pointer[1]},
        .to_output = recorded->to_output,
        .from_output = recorded->from_output,
        .output_size = {recorded->output_size[0], recorded->output_size[1]},
    };
    return out;
}

/* Keep what drawing found of item INDEX's shader, for the main thread. */
static void report(struct display_frame *frame, int set, int index,
                   const struct render_report *found) {
    if (!found->built && !found->building && !found->error) return;
    *(struct frame_report *)vec_push(&frame->reports) = (struct frame_report){set, index, *found};
}

/* What became of ITEM's shader, as REPORT says: one that failed is told to the director,
 * one building repaints the item until it is built, and one just built rebuilds the
 * display, whose occlusion waited for it. */
static void shader_trouble(struct server *server, struct display *display, const struct item *item,
                           const struct render_report *report) {
    if (report->built) {
        display->valid = false;
        output_request_frame(display->output);
    }
    if (report->error) {
        if (item->node)
            shader_report_error(server, item->node, item->shading.shader, report->error);
    } else if (report->building) {
        struct pixel_box area =
            box_pixels(item->bounds, display->buffer_width, display->buffer_height);
        pixman_region32_union_rect(&display->pending, &display->pending, area.x, area.y,
                                   (unsigned)area.width, (unsigned)area.height);
        output_request_frame(display->output);
    }
}

static void draw_item(struct display_frame *frame, int set, int index) {
    struct server *server = frame->output->server;
    struct renderer *renderer = server->renderer;
    struct item *item = vec_at(&frame->sets[set]->items, (size_t)index);
    struct item_draw *draw = vec_at(&frame->draws[set], (size_t)index);
    struct render_shading storage;
    const struct render_shading *shading = shading_of(frame, set, &item->shading, &storage);
    struct render_report found = {0};
    switch (item->kind) {
    case ITEM_PAINT:
        if (!shading) return;
        render_draw_paint(renderer, shading, &item->paint, &found);
        break;
    case ITEM_SURFACE: {
        if (!draw->surface.texture.name) return;
        struct render_texture_draw texture = {
            item->surface.transform, item->surface.box,    item->surface.uv,
            item->surface.mask,      item->surface.radius, item->surface.opacity,
        };
        if (render_draw_surface(renderer, &draw->surface, &texture, shading, item->key, &found))
            draw->presented = true;
        break;
    }
    case ITEM_TEXT: {
        if (item->text.glyphs) {
            double alpha = item->text.color[3] * item->text.opacity;
            const float color[4] = {(float)(item->text.color[0] * alpha),
                                    (float)(item->text.color[1] * alpha),
                                    (float)(item->text.color[2] * alpha), (float)alpha};
            for (size_t g = draw->first; g < draw->first + draw->count; g++) {
                const struct content_glyph *glyph = vec_at(&frame->glyphs, g);
                render_draw_glyph(renderer, glyph->page, glyph->x, glyph->y, glyph->width,
                                  glyph->height, glyph->colored, item->text.transform, glyph->box,
                                  color);
            }
            break;
        }
        struct render_raster *raster = draw->slot ? render_slot_raster(renderer, draw->slot) : NULL;
        if (!raster) return;
        /* It may be one at another scale, until the worker's arrives. */
        struct media_text_box metrics =
            media_text_raster_box(&item->text.metrics, draw->raster_scale);
        struct box box = {metrics.left, metrics.top, metrics.width, metrics.height};
        render_draw_raster(renderer, raster,
                           &(struct render_texture_draw){item->text.transform, box, RENDER_FULL_UV,
                                                         box, 0, item->text.opacity},
                           shading, &found);
        break;
    }
    case ITEM_IMAGE: {
        struct render_raster *raster = draw->slot ? render_slot_raster(renderer, draw->slot) : NULL;
        if (!raster) return;
        render_draw_raster(renderer, raster,
                           &(struct render_texture_draw){item->image.transform, item->image.box,
                                                         item->image.uv, item->image.box,
                                                         item->image.radius, item->image.opacity},
                           shading, &found);
        break;
    }
    case ITEM_WEB:
        /* Pages draw from the main thread's state: only in a frame it waits for. */
        if (!frame->sync) return;
        web_node_draw(server, item->node, item->web.transform, item->web.width, item->web.height,
                      item->web.radius, item->web.opacity, shading, &found);
        break;
    case ITEM_EFFECT: return;
    }
    if (shading) report(frame, set, index, &found);
}

/* Draw effect item INDEX within PASS, which lies inside the item's bounds. */
static void draw_effect(struct display_frame *frame, int set, int index, struct rect pass) {
    struct server *server = frame->output->server;
    struct item *item = vec_at(&frame->sets[set]->items, (size_t)index);
    struct pixel_box bounds = box_pixels(item->bounds, frame->width, frame->height);
    struct pixel_box area = {pass.x0, pass.y0, pass.x1 - pass.x0, pass.y1 - pass.y0};
    struct renderer *renderer = server->renderer;
    struct render_target *content =
        render_effect_target(renderer, bounds.width, bounds.height, RENDER_EFFECT_CONTENT);
    struct render_target *backdrop =
        item->shading.shader->backdrop
            ? render_effect_target(renderer, bounds.width, bounds.height, RENDER_EFFECT_BACKDROP)
            : NULL;
    if (!content) return;
    struct render_effect_scope scope;
    render_begin_effect(renderer, content, backdrop, area, bounds.x, bounds.y, &scope);
    draw_items_range(frame, set, index + 1, item->effect.end, index, pass);
    render_end_effect(renderer, &scope);
    /* While the shader cannot run, the content shows plain. */
    struct render_shading shading;
    struct render_report found = {0};
    render_draw_effect(renderer, shading_of(frame, set, &item->shading, &shading),
                       &item->effect.draw, content, backdrop, area, bounds.x, bounds.y, &found);
    report(frame, set, index, &found);
}

/*
 * Paint the items OWNER draws (-1: the frame) in [FIRST, END) of SET that overlap PASS,
 * bottom first. A large item paints only where no opaque item above it covers,
 * except where a reader between them reads it.
 */
static void draw_items_range(struct display_frame *frame, int set, int first, int end, int owner,
                             struct rect pass) {
    struct server *server = frame->output->server;
    struct vec *items = &frame->sets[set]->items;
    int width = frame->width, height = frame->height;
    /* Items under the topmost one painting opaquely all over the pass cannot show. */
    int start = first;
    for (int i = first; i < end; i++) {
        struct item *item = vec_at(items, i);
        if (item->owner == owner && item->opaque_valid && box_contains_rect(item->opaque, pass))
            start = i;
    }
    struct vec holes, readers;
    vec_init(&holes, sizeof(struct hole));
    vec_init(&readers, sizeof(struct hole));
    for (int i = start; i < end; i++) {
        struct item *item = vec_at(items, i);
        if (item->owner != owner) continue;
        struct rect hole;
        if (item->opaque_valid && covered(item->opaque, &hole) && rects_overlap(hole, pass))
            *(struct hole *)vec_push(&holes) = (struct hole){i, hole};
        if (item->reads)
            *(struct hole *)vec_push(&readers) =
                (struct hole){i, pixel_rect(item->read_area, width, height)};
    }
    /* The largest holes cut first. */
    qsort(holes.data, holes.length, sizeof(struct hole), compare_holes);
    for (int i = start; i < end; i++) {
        struct item *item = vec_at(items, i);
        if (item->owner != owner) continue;
        /* Bounds already lie within the item's clip. */
        struct rect bounds = pixel_rect(item->bounds, width, height);
        if (!rects_overlap(bounds, pass)) continue;
        struct rect box = rect_intersect(bounds, pass);
        if (item->kind == ITEM_EFFECT) {
            set_scissor(server, box);
            draw_effect(frame, set, i, box);
            set_scissor(server, pass);
            if (owner < 0) render_submit(server->renderer);
            continue;
        }
        struct rect parts[9];
        int part_count = 1;
        parts[0] = box;
        if (holes.length && !item->reads && rect_area(box) > OCCLUSION_CUT_AREA) {
            /* Holes of occluders above, but not where a reader between them copies the
             * framebuffer: it reads what this item paints. */
            VEC_FOR(&holes, struct hole, hole) {
                if (hole->position <= i) continue;
                bool read = false;
                VEC_FOR(&readers, struct hole, reader) {
                    read = read || (reader->position > i && reader->position < hole->position &&
                                    rects_overlap(reader->rect, hole->rect));
                }
                if (read) continue;
                struct rect cut[9 * 4];
                int cut_count = 0;
                for (int k = 0; k < part_count; k++)
                    cut_count += rect_subtract(parts[k], hole->rect, cut + cut_count);
                /* The parts must take only a few draws. */
                if (cut_count > 8) break;
                memcpy(parts, cut, cut_count * sizeof *cut);
                part_count = cut_count;
            }
        }
        bool scissored = item->clipped || part_count != 1 || memcmp(&parts[0], &box, sizeof box);
        for (int k = 0; k < part_count; k++) {
            if (scissored) set_scissor(server, parts[k]);
            draw_item(frame, set, i);
        }
        if (scissored) set_scissor(server, pass);
        if (owner < 0) render_submit(server->renderer);
    }
    vec_finish(&holes);
    vec_finish(&readers);
}

/* Repaint PASS of the bound buffer from the bottom: what lies under everything, then the
 * scene's items and the seat's. */
static void draw_pass(struct display_frame *frame, struct rect pass) {
    struct server *server = frame->output->server;
    set_scissor(server, pass);
    render_clear(server->renderer, UNDERLAY[0], UNDERLAY[1], UNDERLAY[2], 1);
    for (int set = 0; set < SET_COUNT; set++)
        draw_items_range(frame, set, 0, (int)frame->sets[set]->items.length, -1, pass);
}

static void draw_passes(struct display_frame *frame) {
    struct server *server = frame->output->server;
    if (server->damage_debug) {
        render_set_scissor(server->renderer, 0, 0, frame->width, frame->height);
        render_clear(server->renderer, 0.55, 0.015, 0.08, 1);
    }
    /* Each rectangle is repainted from the bottom, so overlapping ones never
     * accumulate translucent layers twice. */
    VEC_FOR(&frame->passes, struct rect, pass) draw_pass(frame, *pass);
}

/* Whether BOUNDS, in buffer pixels, meets any of FRAME's passes. */
static bool meets_passes(const struct display_frame *frame, struct box bounds) {
    struct rect rect = pixel_rect(bounds, frame->width, frame->height);
    VEC_FOR(&frame->passes, struct rect, pass)
        if (rects_overlap(rect, *pass)) return true;
    return false;
}

/* Resolve on the main thread what FRAME's items draw from, as drawing finds it: every item
 * when ALL, else those its passes reach. */
static void prepare_frame(struct display_frame *frame, bool all) {
    struct output *output = frame->output;
    struct server *server = output->server;
    content_frame_begin(server, &frame->uploads);
    for (int set = 0; set < SET_COUNT; set++) {
        struct vec *items = &frame->sets[set]->items;
        struct vec *draws = &frame->draws[set];
        for (size_t i = 0; i < items->length; i++) {
            struct item *item = vec_at(items, i);
            struct item_draw *draw = vec_push(draws);
            *draw = (struct item_draw){0};
            /* What an effect holds draws when the effect does. */
            draw->ready = item->owner >= 0
                              ? ((struct item_draw *)vec_at(draws, (size_t)item->owner))->ready
                              : all || meets_passes(frame, item->bounds);
            if (item->kind == ITEM_SURFACE)
                *(uint64_t *)vec_push(&frame->shown_keys) = item->key;
            if (!draw->ready) continue;
            if (item->shading.shader) display_prepare_shader(server, item->shading.shader);
            switch (item->kind) {
            case ITEM_SURFACE: {
                /* Live windows draw their newest buffer, held while the frame draws it. */
                struct wlr_surface *surface = item->surface_ptr;
                struct wlr_texture *texture =
                    surface ? wlr_surface_get_texture(surface) : item->surface.texture;
                if (!texture) break;
                struct wlr_gles2_texture_attribs attribs;
                wlr_gles2_texture_get_attribs(texture, &attribs);
                draw->surface = (struct render_surface){
                    .texture = {attribs.target, attribs.tex, texture->width, texture->height,
                                attribs.has_alpha},
                    .source = texture,
                    .generation = surface ? surface->current.seq : 0,
                };
                /* Held while the frame draws: a live surface's texture, and the client's own
                 * buffer, which it must not draw into again before the frame read it (a
                 * dma-buf); or the snapshot's, which its window may let go. */
                struct wlr_buffer *held[2] = {
                    surface ? (surface->buffer ? &surface->buffer->base : NULL)
                            : item->surface.buffer,
                    surface ? surface->current.buffer : NULL,
                };
                for (int k = 0; k < 2; k++) {
                    if (held[k])
                        *(struct wlr_buffer **)vec_push(&frame->locks) = wlr_buffer_lock(held[k]);
                }
                break;
            }
            case ITEM_TEXT:
                if (item->text.glyphs) {
                    draw->first = frame->glyphs.length;
                    bool complete = content_text_prepare_glyphs(
                        server, item->node, item->text.scale, &frame->glyphs, &frame->uploads);
                    draw->count = frame->glyphs.length - draw->first;
                    /* Text short of time or atlas room this frame (left out, or resampled
                     * from another scale) draws again with a later one. */
                    if (!complete) {
                        const struct item *root = item;
                        while (root->owner >= 0) root = vec_at(items, (size_t)root->owner);
                        add_box_damage(output->display, root->bounds);
                        output_request_frame(output);
                    }
                } else if (content_text_prepare_raster(server, item->node, output->index,
                                                       item->text.slot, item->text.key,
                                                       item->text.scale, item->text.color,
                                                       &frame->uploads, &draw->raster_scale)) {
                    draw->slot = item->text.slot;
                }
                break;
            case ITEM_IMAGE:
                if (!content_image_prepare(server, item->node, &frame->uploads, &draw->slot))
                    draw->slot = 0;
                break;
            case ITEM_WEB: frame->sync = true; break;
            default: break;
            }
        }
    }
}

/* A frame drawing OUTPUT's display as it is now, its passes to come. */
static struct display_frame *frame_new(struct output *output) {
    struct display *display = output->display;
    struct display_frame *frame = xcalloc(1, sizeof *frame);
    frame->output = output;
    frame->sets[SCENE_SET] = display->scene;
    frame->sets[SEAT_SET] = display->seat;
    for (int set = 0; set < SET_COUNT; set++) {
        frame->sets[set]->refs++;
        vec_init(&frame->draws[set], sizeof(struct item_draw));
    }
    vec_init(&frame->glyphs, sizeof(struct content_glyph));
    vec_init(&frame->uploads, sizeof(struct content_upload));
    vec_init(&frame->locks, sizeof(struct wlr_buffer *));
    vec_init(&frame->shown_keys, sizeof(uint64_t));
    vec_init(&frame->reports, sizeof(struct frame_report));
    vec_init(&frame->passes, sizeof(struct rect));
    vec_init(&frame->presented, sizeof(struct wlr_surface *));
    vec_init(&frame->callbacks, sizeof(struct wlr_surface *));
    pixman_region32_init(&frame->damage);
    frame->width = display->buffer_width;
    frame->height = display->buffer_height;
    *(struct display_frame **)vec_push(&display->frames) = frame;
    return frame;
}

/* What drawing FRAME found, back on the main thread: shader reports, the surfaces it drew
 * (those not gone since), then the buffers it held and its uploads go. Once only. */
static void take_results(struct display_frame *frame) {
    struct server *server = frame->output->server;
    struct display *display = frame->output->display;
    VEC_FOR(&frame->reports, struct frame_report, found) {
        struct item *item = vec_at(&frame->sets[found->set]->items, (size_t)found->index);
        shader_trouble(server, display, item, &found->report);
    }
    vec_clear(&frame->reports);
    for (int set = 0; set < SET_COUNT; set++) {
        for (size_t i = 0; i < frame->draws[set].length; i++) {
            struct item_draw *draw = vec_at(&frame->draws[set], i);
            struct item *item = vec_at(&frame->sets[set]->items, i);
            if (draw->presented && item->surface_ptr)
                add_surface_once(&frame->presented, item->surface_ptr);
            draw->presented = false;
        }
    }
    VEC_FOR(&frame->locks, struct wlr_buffer *, buffer) wlr_buffer_unlock(*buffer);
    vec_clear(&frame->locks);
    content_free_uploads(&frame->uploads);
}

void display_frame_free(struct display_frame *frame) {
    if (!frame) return;
    struct display *display = frame->output->display;
    take_results(frame);
    for (size_t i = 0; i < display->frames.length; i++) {
        if (*(struct display_frame **)vec_at(&display->frames, i) == frame) {
            vec_remove(&display->frames, i);
            break;
        }
    }
    for (int set = 0; set < SET_COUNT; set++) {
        item_set_release(frame->sets[set]);
        vec_finish(&frame->draws[set]);
    }
    vec_finish(&frame->glyphs);
    vec_finish(&frame->uploads);
    vec_finish(&frame->locks);
    vec_finish(&frame->shown_keys);
    vec_finish(&frame->reports);
    vec_finish(&frame->passes);
    vec_finish(&frame->presented);
    vec_finish(&frame->callbacks);
    pixman_region32_fini(&frame->damage);
    free(frame);
}

/* Track which outputs show each window; surfaces enter and leave them accordingly. */
static void apply_presence(struct server *server, struct output *output) {
    uint32_t bit = 1u << output->index;
    struct window *window;
    wl_list_for_each(window, &server->windows, link) {
        bool shown = display_shows_client(output, window);
        uint32_t outputs = shown ? window->outputs | bit : window->outputs & ~bit;
        if (outputs != window->outputs) window_set_outputs(window, outputs);
    }
    web_sync_presence(server, output);
}

/* One surface of the drag icon, as an item takes it. */
static void drag_surface(struct wlr_surface *surface, int x, int y, void *data) {
    struct wlr_texture *texture = wlr_surface_get_texture(surface);
    if (!texture) return;
    struct surface_draw *draw = vec_push(data);
    draw->surface = surface;
    draw->texture = texture;
    draw->x = x;
    draw->y = y;
    draw->width = surface->current.width;
    draw->height = surface->current.height;
    wlr_surface_get_buffer_source_box(surface, &draw->source);
    draw->transform = surface->current.transform;
}

static void emit_seat_items(struct output *output) {
    struct server *server = output->server;
    struct display *display = output->display;
    display->seat = item_set_fresh(display->seat);
    struct emit e;
    emit_init(&e, output, display->seat, 3);
    struct wlr_surface *icon;
    double x, y;
    if (input_drag_icon(server, output, &icon, &x, &y)) {
        wlr_surface_for_each_surface(icon, drag_surface, e.surfaces);
        int index = 0;
        VEC_FOR(e.surfaces, struct surface_draw, draw) {
            struct mat3 local = mat3_multiply(e.screen, mat3_translation(x + draw->x, y + draw->y));
            struct item *item =
                emit_item(&e, 0, 13, index++,
                          mat3_box_bounds(local, (struct box){0, 0, draw->width, draw->height}, 1),
                          ITEM_SURFACE);
            if (!item) continue;
            item->surface.transform = local;
            item->surface.box = (struct box){0, 0, draw->width, draw->height};
            item->surface.mask = item->surface.box;
            item->surface.opacity = 1;
            surface_uv(draw, item->surface.uv);
            item->signature = signature_of(&e, &item->surface, sizeof item->surface);
            item->surface_ptr = draw->surface;
        }
    }
}

/* SLOT's target when it is WIDTH x HEIGHT, else a new one in its place. */
static struct render_target *fitted_target(struct render_target **slot, int width, int height) {
    if (*slot && (*slot)->width == width && (*slot)->height == height) return *slot;
    render_target_destroy(*slot);
    *slot = render_target_create(width, height, false);
    return *slot;
}

/*
 * PROSCENIUM_CHECK: compare the frame just drawn into FRAMEBUFFER with a full
 * redraw of the same frame, which damage tracking must reproduce exactly. The
 * software cursor's surroundings are left out. Checked frames are drawn while the
 * main thread waits.
 */
static void check_frame(struct display_frame *frame, GLuint framebuffer) {
    struct output *output = frame->output;
    struct server *server = output->server;
    struct display *display = output->display;
    int width = frame->width, height = frame->height;
    size_t size = (size_t)width * height * 4;
    unsigned char *pixels = xmalloc(size), *full = xmalloc(size);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    gl_read_pixels(0, 0, width, height, pixels);
    struct render_target *target = fitted_target(&display->check_target, width, height);
    if (!target) goto out;
    struct gl_binding saved;
    render_target_bind(target, &saved);
    render_begin_frame(server->renderer, width, height);
    /* With no spare time, the redraw uses the mipmaps the frame had. */
    render_spend_spare_time(server->renderer, now_seconds() - 1);
    draw_pass(frame, (struct rect){0, 0, width, height});
    render_finish_frame(server->renderer);
    gl_read_pixels(0, 0, width, height, full);
    gl_restore_binding(&saved);
    double cx, cy;
    mat3_apply(screen_transform(output), server->cursor->x - output->offset, server->cursor->y, &cx,
               &cy);
    long differing = 0;
    int first_x = -1, first_y = -1;
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            if (fabs(x - cx) < 64 && fabs(y - cy) < 64) continue;
            const unsigned char *a = pixels + ((size_t)y * width + x) * 4,
                                *b = full + ((size_t)y * width + x) * 4;
            if (abs(a[0] - b[0]) > 2 || abs(a[1] - b[1]) > 2 || abs(a[2] - b[2]) > 2) {
                if (!differing++) first_x = x, first_y = y;
            }
        }
    }
    display->checked++;
    if (differing) {
        display->mismatched++;
        wlr_log(WLR_ERROR,
                "check: %s frame %d differs from a full redraw in %ld pixels, first at %d,%d",
                output_name(output), display->checked, differing, first_x, first_y);
    }
out:
    free(pixels);
    free(full);
}

/* Draw FRAME where the renderer draws: its uploads first, then its passes. */
static void draw_frame(void *data) {
    struct display_frame *frame = data;
    struct output *output = frame->output;
    struct server *server = output->server;
    struct renderer *renderer = server->renderer;
    double started = now_seconds();
    content_apply_uploads(renderer, &frame->uploads);
    GLuint framebuffer = frame->framebuffer;
    if (server->render_thread)
        framebuffer = render_buffer_framebuffer(renderer, frame->buffer,
                                                frame->has_dmabuf ? &frame->dmabuf : NULL);
    if (framebuffer && frame->passes.length) {
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        output_draw_begin(output);
        render_begin_frame(renderer, frame->width, frame->height);
        draw_passes(frame);
        render_finish_frame(renderer);
        output_draw_end(output);
        if (frame->check) check_frame(frame, framebuffer);
        if (server->render_thread) render_thread_fence_render(server->render_thread);
        /* After the fence the output's commit waits on, so the tap's copy never holds it up. */
        if (frame->tap) {
            glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
            frame->tap(framebuffer, frame->width, frame->height, frame->tap_data);
        }
        frame->drawn = true;
    }
    /* Mipmaps of surfaces shown but not drawn stay; the rest go once unused a while. */
    VEC_FOR(&frame->shown_keys, uint64_t, key) render_touch_mipmap(renderer, *key);
    render_sweep(renderer, frame->built_at);
    frame->draw_ms = (now_seconds() - started) * 1e3;
}

/* Back on the main thread once FRAME is drawn. */
static void frame_finished(void *data) {
    struct display_frame *frame = data;
    take_results(frame);
    if (frame->done) frame->done(frame, frame->data);
}

struct display_frame *display_build(struct output *output, struct wlr_buffer *buffer, double time) {
    struct server *server = output->server;
    struct display *display = output->display;
    struct wlr_output *wlr_output = output->wlr_output;
    double started = now_seconds();
    output->awaiting_frame = false;
    if (display->buffer_width != wlr_output->width ||
        display->buffer_height != wlr_output->height ||
        display->transform != (int)wlr_output->transform) {
        display->buffer_width = wlr_output->width;
        display->buffer_height = wlr_output->height;
        display->transform = wlr_output->transform;
        vec_clear(&display->diffed);
        vec_clear(&display->seat_diffed);
        display->valid = false;
        wlr_damage_ring_add_whole(&display->ring);
    }
    server_advance(server, time);
    web_prepare(server, output);
    windows_sweep_departed(server);
    refresh(output);
    if (!display->diffed_current) {
        /* A display reused from the previous frame has nothing new to diff. */
        apply_presence(server, output);
        struct idmap swap = display->raster_scales;
        display->raster_scales = display->next_raster_scales;
        display->next_raster_scales = swap;
        diff_items(display, &display->scene->items, &display->diffed);
        display->diffed_current = true;
        input_repick(server, output);
    }
    emit_seat_items(output);
    diff_items(display, &display->seat->items, &display->seat_diffed);

    pixman_region32_intersect_rect(&display->pending, &display->pending, 0, 0,
                                   display->buffer_width, display->buffer_height);
    wlr_damage_ring_add(&display->ring, &display->pending);
    pixman_region32_clear(&display->pending);
    pixman_region32_t repair;
    pixman_region32_init(&repair);
    wlr_damage_ring_rotate_buffer(&display->ring, buffer, &repair);
    if (server->damage_debug)
        pixman_region32_union_rect(&repair, &repair, 0, 0, display->buffer_width,
                                   display->buffer_height);

    struct display_frame *frame = frame_new(output);
    frame->buffer = buffer;
    frame->check = server->check;
    frame->tap = display->tap;
    frame->tap_data = display->tap_data;
    frame_passes(&repair, &display->scene->items, frame->width, frame->height, &frame->passes);
    pixman_region32_fini(&repair);
    VEC_FOR(&frame->passes, struct rect, r)
        pixman_region32_union_rect(&frame->damage, &frame->damage, r->x0, r->y0, r->x1 - r->x0,
                                   r->y1 - r->y0);
    /* Visible clients waiting for a frame progress even when their pixels were not repainted. */
    for (int set = 0; set < SET_COUNT; set++) {
        VEC_FOR(&frame->sets[set]->items, struct item, item) {
            struct wlr_surface *surface = item->surface_ptr;
            if (surface && !wl_list_empty(&surface->current.frame_callback_list))
                add_surface_once(&frame->callbacks, surface);
        }
    }
    frame->shown = pixman_region32_not_empty(&frame->damage) || frame->callbacks.length;
    if (frame->passes.length) {
        /* A checked frame redraws all of itself: every item is drawn from. */
        prepare_frame(frame, frame->check);
        if (frame->check) frame->sync = true;
        if (server->render_thread) {
            frame->has_dmabuf = wlr_buffer_get_dmabuf(buffer, &frame->dmabuf);
        } else {
            frame->framebuffer = wlr_gles2_renderer_get_buffer_fbo(server->wlr_renderer, buffer);
        }
    }
    frame->built_at = displays_built_at(server);
    content_release_stale(server);
    frame->build_ms = (now_seconds() - started) * 1e3;
    return frame;
}

void display_draw(struct display_frame *frame,
                  void (*done)(struct display_frame *frame, void *data), void *data) {
    struct server *server = frame->output->server;
    frame->done = done;
    frame->data = data;
    if (!frame->passes.length) {
        frame_finished(frame);
        return;
    }
    if (!server->render_thread || frame->sync) {
        server_render(server, draw_frame, frame);
        frame_finished(frame);
        return;
    }
    /* What the main context did so far (client buffers, imports) is fenced for the draw. */
    if (server_gl_current(server)) render_thread_fence_main(server->render_thread);
    render_thread_queue(server->render_thread, draw_frame, frame_finished, frame);
}

bool display_frame_shown(const struct display_frame *frame) {
    return frame->shown;
}

bool display_frame_drew(const struct display_frame *frame) {
    return frame->drawn || !frame->passes.length;
}

const pixman_region32_t *display_frame_damage(const struct display_frame *frame) {
    return &frame->damage;
}

void display_frame_times(const struct display_frame *frame, double *build_ms, double *draw_ms) {
    *build_ms = frame->build_ms;
    *draw_ms = frame->draw_ms;
}

void display_frame_feedback(struct display_frame *frame) {
    VEC_FOR(&frame->presented, struct wlr_surface *, surface) {
        if (*surface)
            wlr_presentation_surface_textured_on_output(*surface, frame->output->wlr_output);
    }
}

void display_frame_done(struct display_frame *frame, bool committed) {
    struct output *output = frame->output;
    if (!committed) {
        /* The next frame repaints it; when it starts is the caller's. */
        wlr_damage_ring_add(&output->display->ring, &frame->damage);
        return;
    }
    struct timespec when;
    clock_gettime(CLOCK_MONOTONIC, &when);
    VEC_FOR(&frame->callbacks, struct wlr_surface *, surface) {
        if (*surface) wlr_surface_send_frame_done(*surface, &when);
    }
}

/* Captures, through offscreen targets, so they never force an output frame. */

static void release_targets(void *data) {
    struct display_targets *targets = data;
    render_target_destroy(targets->full);
    render_target_destroy(targets->scaled);
}

void display_release_targets(struct server *server, struct display_targets *targets) {
    if (targets->full || targets->scaled) server_render(server, release_targets, targets);
    *targets = (struct display_targets){0};
}

struct region_read {
    struct display_frame *frame;
    struct box region;
    int width, height;
    void *pixels;
    struct display_targets *targets;
    bool done;
};

static void read_region(void *data);

bool display_read_region(struct output *output, struct box region, int width, int height,
                         void *pixels, struct display_targets *targets) {
    struct server *server = output->server;
    struct display *display = output->display;
    int buffer_width = display->buffer_width, buffer_height = display->buffer_height;
    if (buffer_width <= 0 || buffer_height <= 0) return false;
    refresh(output);
    emit_seat_items(output);
    /* Only the region, and what its readers sample, is drawn. */
    struct mat3 to_buffer = screen_transform(output);
    struct pixel_box area =
        box_pixels(mat3_box_bounds(to_buffer, region, 0), buffer_width, buffer_height);
    pixman_region32_t repair;
    pixman_region32_init_rect(&repair, area.x, area.y, (unsigned)area.width, (unsigned)area.height);
    struct display_frame *frame = frame_new(output);
    frame_passes(&repair, &display->scene->items, buffer_width, buffer_height, &frame->passes);
    pixman_region32_fini(&repair);
    prepare_frame(frame, false);
    frame->sync = true;
    struct region_read read = {frame, region, width, height, pixels, targets, false};
    server_render(server, read_region, &read);
    display_frame_free(frame);
    return read.done;
}

static void read_region(void *data) {
    struct region_read *read = data;
    struct display_frame *frame = read->frame;
    struct output *output = frame->output;
    struct server *server = output->server;
    struct renderer *renderer = server->renderer;
    struct box region = read->region;
    int width = read->width, height = read->height;
    int buffer_width = frame->width, buffer_height = frame->height;
    content_apply_uploads(renderer, &frame->uploads);
    struct render_target *full = fitted_target(&read->targets->full, buffer_width, buffer_height);
    struct render_target *scaled = fitted_target(&read->targets->scaled, width, height);
    if (!full || !scaled) return;
    struct mat3 to_buffer = screen_transform(output);
    struct gl_binding saved;
    render_target_bind(full, &saved);
    render_begin_frame(renderer, buffer_width, buffer_height);
    VEC_FOR(&frame->passes, struct rect, pass) draw_pass(frame, *pass);
    render_finish_frame(renderer);
    /* Corner UVs follow the output transform, so the capture stays upright. */
    double corners[4][2] = {{region.x, region.y},
                            {box_right(region), region.y},
                            {region.x, box_bottom(region)},
                            {box_right(region), box_bottom(region)}};
    double uv[8];
    for (int i = 0; i < 4; i++) {
        double bx, by;
        mat3_apply(to_buffer, corners[i][0], corners[i][1], &bx, &by);
        uv[2 * i] = bx / buffer_width;
        uv[2 * i + 1] = by / buffer_height;
    }
    struct gl_binding ignored;
    render_target_bind(scaled, &ignored);
    render_begin_frame(renderer, width, height);
    render_clear(renderer, 0, 0, 0, 1);
    struct render_texture texture = {GL_TEXTURE_2D, full->texture, buffer_width, buffer_height,
                                     true};
    struct box whole = {0, 0, width, height};
    render_draw_texture(renderer, &texture,
                        &(struct render_texture_draw){MAT3_IDENTITY, whole, uv, whole, 0, 1}, NULL,
                        NULL);
    render_finish_frame(renderer);
    gl_read_pixels(0, 0, width, height, read->pixels);
    gl_restore_binding(&saved);
    read->done = true;
}

struct window_read {
    struct server *server;
    struct box bounds;
    int width, height;
    void *pixels;
    struct display_targets *targets;
    struct vec *surfaces;
    bool done;
};

static void read_window(void *data);

bool display_read_window(struct server *server, struct window *window, struct box bounds, int width,
                         int height, void *pixels, struct display_targets *targets) {
    if (!(bounds.width > 0 && bounds.height > 0)) return false;
    struct vec surfaces;
    vec_init(&surfaces, sizeof(struct surface_draw));
    window_surfaces(window, &surfaces);
    struct window_read read = {server, bounds, width, height, pixels, targets, &surfaces, false};
    server_render(server, read_window, &read);
    vec_finish(&surfaces);
    return read.done;
}

/* The surfaces' textures are read while the main thread waits: nothing changes them. */
static void read_window(void *data) {
    struct window_read *read = data;
    struct server *server = read->server;
    struct renderer *renderer = server->renderer;
    struct box bounds = read->bounds;
    int width = read->width, height = read->height;
    struct render_target *scaled = fitted_target(&read->targets->scaled, width, height);
    if (!scaled) return;
    double sx = width / bounds.width, sy = height / bounds.height;
    struct mat3 transform = mat3_affine(sx, 0, 0, sy, -bounds.x * sx, -bounds.y * sy);
    struct gl_binding saved;
    render_target_bind(scaled, &saved);
    render_begin_frame(renderer, width, height);
    render_clear(renderer, 0.035, 0.04, 0.05, 1);
    VEC_FOR(read->surfaces, struct surface_draw, draw) {
        struct wlr_texture *texture =
            draw->surface ? wlr_surface_get_texture(draw->surface) : draw->texture;
        if (!texture) continue;
        struct wlr_gles2_texture_attribs attribs;
        wlr_gles2_texture_get_attribs(texture, &attribs);
        struct render_texture source = {attribs.target, attribs.tex, texture->width,
                                        texture->height, attribs.has_alpha};
        double uv[8];
        surface_uv(draw, uv);
        struct box box = {draw->x, draw->y, draw->width, draw->height};
        render_draw_texture(renderer, &source,
                            &(struct render_texture_draw){transform, box, uv, box, 0, 1}, NULL,
                            NULL);
    }
    render_finish_frame(renderer);
    gl_read_pixels(0, 0, width, height, read->pixels);
    gl_restore_binding(&saved);
    read->done = true;
}
