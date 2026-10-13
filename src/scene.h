/*
 * The retained scene graph and director commits.
 *
 * A commit is applied in order and finished as one unit. Nodes removed in a
 * commit hand their displayed motion to new nodes with the same identity, so
 * remounts, re-parenting and hot reloads animate instead of jumping. A removed
 * node with exit values stays visible until they settle.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "json.h"
#include "motion.h"
#include "props.h"
#include "shader.h"
#include "util.h"

struct stage_page;

enum node_state {
    NODE_LIVE,
    NODE_REMOVED, /* during the commit that removes it */
    NODE_EXITING,
    NODE_DEAD,
};

/* A property's channels: one, four for a color, or one per transform parameter. */
struct prop_channels {
    int count;
    struct channel *items;
};

/* A keyframe track on one property, replacing its value or added to it. */
struct layer {
    /* The declaration's id: a later one with the same id keeps running. */
    char *id;
    /* PROP_COUNT for a shading's uniform: UNIFORM of the shading with id SHADING. */
    enum prop_key key;
    char shading[33], uniform[33];
    struct track track;
    bool add;
    /* A transform track animates the parameters of these functions. */
    int kind_count;
    uint8_t kinds[TLIST_MAX];
    double start;
    bool has_current;
    double *current;
    /* Finished layers stay until the director drops them, so declaring the same
     * animation again does not replay it. */
    bool done;
};

#define SHADINGS_MAX 8
/* A node holds at most this many: those it declares and as many leaving. */
#define SHADINGS_HELD (2 * SHADINGS_MAX)

/* A node's use of a registered shader: a paint, a filter or its effect. */
struct shading {
    char id[33];
    /* The id hashed, which keys what the shading draws. */
    uint32_t key;
    struct shader *shader;
    /* A paint drawn over the node's content rather than under it. */
    bool over;
    /* An effect or paint covering the whole output, in output-logical pixels. */
    bool whole_output;
    /* Its clock, for a shader reading `time`: seconds run before SINCE, when it
     * last started running. */
    bool running;
    double elapsed, since;
    /* How its uniforms move: per uniform where given, else MOTION, else the node's
     * default transition. */
    struct motion *motion;
    struct motion *uniform_motions[UNIFORMS_MAX];
    /* One per uniform component: the shader's offsets say where each uniform starts. */
    struct channel *channels;
    /* No longer declared: it moves to zero, then goes. */
    bool leaving;
    /* Its shader failed to build, and the director was told. */
    bool reported;
};

/* A shading uniform's value in `initial` or `exit`. */
struct shading_target {
    char shading[33];
    struct uniform_value value;
};

/* Animated values a new node starts from (`initial`) or a removed one goes to (`exit`). */
struct targets {
    struct prop_value values[PROP_COUNT];
    struct vec shadings; /* struct shading_target */
};

struct node {
    int64_t id;
    enum node_kind kind;
    int references;
    enum node_state state;
    struct node *parent, *first_child, *last_child, *previous, *next;

    struct prop_value props[PROP_COUNT];
    struct prop_channels channels[PROP_COUNT];
    int transform_kind_count;
    uint8_t transform_kinds[TLIST_MAX];
    /* Transition per property; the default covers properties without one. */
    struct motion *motions[PROP_COUNT];
    struct motion *default_motion;
    struct targets *initial, *exit;
    char *layout_id;
    uint32_t handlers;
    struct vec layers; /* struct layer */
    /* Shaders it uses in declaration order, those leaving last. */
    struct shading *shadings;
    int shading_count;
    /* x, y, width, height bits held by direct manipulation: director values wait. */
    uint32_t held;
    /* Counts declarations, so what is derived from them knows when it is current. */
    uint64_t revision;
    /* Something of it animates; SETTLING, something that ends rather than loops. */
    bool active, settling;

    /* Derived per kind by the compositor: a text layout, an image. */
    void *cache;
    void (*cache_destroy)(void *cache);
    /* A web node's page, and the source that failed to load, not retried. */
    struct stage_page *web_page;
    char *web_failed;
};

struct scene {
    struct idmap nodes;
    struct node root;
    struct vec active;  /* struct node *: nodes with a moving channel or layer */
    struct vec exiting; /* struct node * */
    struct vec created, removed;
    /*
     * The value KEY shows before it is first declared, e.g. a window's natural
     * width before it is constrained; false when there is none.
     */
    bool (*natural_value)(void *data, struct node *node, enum prop_key key, double *out);
    /* NODE's size as drawn, which its transform origin is relative to. */
    void (*size)(void *data, const struct node *node, double *width, double *height);
    /* A node is about to be freed: drop every reference to it. */
    void (*node_dead)(void *data, struct node *node);
    void *data;
    /* The shaders nodes may name. */
    const struct shaders *shaders;
};

void scene_init(struct scene *scene);
void scene_finish(struct scene *scene);
/* Node ID, the root for 0, or NULL. */
struct node *scene_node(struct scene *scene, int64_t id);

bool scene_create_node(struct scene *scene, int64_t id, const struct json_value *type,
                       const struct json_value *props, double time, struct protocol_error *error);
bool scene_update(struct scene *scene, int64_t id, const struct json_value *props, double time,
                  struct protocol_error *error);
/* Put node ID into PARENT before BEFORE, or last when BEFORE is 0. */
bool scene_insert(struct scene *scene, int64_t parent, int64_t id, int64_t before,
                  struct protocol_error *error);
bool scene_remove(struct scene *scene, int64_t parent, int64_t id, struct protocol_error *error);
/* Remove every top-level node within the current commit, without exit animations. */
void scene_clear(struct scene *scene);
/* Hand motion over between same-identity nodes, then retire removed nodes. */
void scene_finish_commit(struct scene *scene, double time);
/* Sample every moving channel at TIME. */
void scene_advance(struct scene *scene, double time);
/* True while a motion that will finish runs, as opposed to an endless loop. */
bool scene_settling(const struct scene *scene);

void node_ref(struct node *node);
void node_unref(struct node *node);

/* Declared value, or the default. */
const struct prop_value *node_prop(const struct node *node, enum prop_key key);
static inline bool node_given(const struct node *node, enum prop_key key) {
    return node->props[key].given;
}
static inline bool node_bool(const struct node *node, enum prop_key key) {
    return node_prop(node, key)->boolean;
}
static inline int node_choice(const struct node *node, enum prop_key key) {
    return node_prop(node, key)->choice;
}
/* The node's string, or NULL. */
static inline const char *node_string(const struct node *node, enum prop_key key) {
    return node->props[key].given ? node->props[key].string : NULL;
}
/* Displayed value of a numeric property, or FALLBACK when it is unset. */
double node_number(const struct node *node, enum prop_key key, double fallback);
/* Whether a numeric property has a displayed value at all. */
bool node_has_number(const struct node *node, enum prop_key key);
/* Whether a property is on its way to a new value. */
bool node_moving(const struct node *node, enum prop_key key);
/* SHADING's uniforms as displayed, keyframes included, flattened in the shader's order into OUT. */
void node_shading_values(const struct node *node, const struct shading *shading, float *out);
/* Seconds SHADING's clock has run at NOW. */
double shading_time(const struct shading *shading, double now);
/* NODE's filter or effect, of which it declares one at most: the one declared, else one
 * leaving, or NULL. */
const struct shading *node_stage_shading(const struct node *node, enum shader_stage stage);
/* Displayed straight-alpha color. */
void node_color(const struct node *node, enum prop_key key, double out[4]);
/*
 * NODE's local space to its parent's: transformed about its origin, a point in
 * the WIDTH x HEIGHT box, then moved to (X, Y).
 */
struct mat4 node_local_matrix(const struct node *node, double width, double height, double x,
                              double y);
/* The same at the node's displayed position. */
struct mat4 node_matrix(const struct node *node, double width, double height);
/* Destination of KEY: its channel target while one runs, else the declared value. */
double node_target(const struct node *node, enum prop_key key, double fallback);
/* Show VALUE for numeric KEY at once, as direct manipulation does. */
void node_jump(struct scene *scene, struct node *node, enum prop_key key, double value);
void node_hold(struct node *node, enum prop_key key);
void node_release(struct node *node, enum prop_key key);
static inline bool node_handles(const struct node *node, enum event_name event) {
    return node->handlers & (1u << event);
}
/* Whether NODE handles EVENT or, for a bubbling EVENT, any of its ancestors does. */
bool node_receives(const struct node *node, enum event_name event);

#define NODE_FOR_CHILDREN(parent, child)                                                           \
    for (struct node *child = (parent)->first_child; child; child = child->next)

/* Call FUNCTION on every live node in shading order. */
void scene_for_each(struct scene *scene, void (*function)(struct node *node, void *data),
                    void *data);
