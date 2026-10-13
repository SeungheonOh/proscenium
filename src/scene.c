#include "scene.h"

#include <math.h>
#include <stdio.h>

static const struct prop_value NO_VALUE;

/* Nodes. */

static struct node *node_new(int64_t id, enum node_kind kind) {
    struct node *node = xcalloc(1, sizeof *node);
    node->id = id;
    node->kind = kind;
    node->references = 1;
    vec_init(&node->layers, sizeof(struct layer));
    return node;
}

static void channels_free(struct prop_channels *channels) {
    for (int i = 0; i < channels->count; i++) channel_finish(&channels->items[i]);
    free(channels->items);
    *channels = (struct prop_channels){0};
}

/* Give CHANNELS COUNT fresh channels unless it has as many; true when it did. */
static bool channels_resize(struct prop_channels *channels, int count) {
    if (channels->count == count) return false;
    channels_free(channels);
    channels->count = count;
    channels->items = xcalloc(count, sizeof *channels->items);
    return true;
}

static void targets_free(struct targets *targets) {
    if (!targets) return;
    for (int key = 0; key < PROP_COUNT; key++) prop_value_finish(key, &targets->values[key]);
    vec_finish(&targets->shadings);
    free(targets);
}

static void shading_finish(struct shading *shading) {
    for (int i = 0; shading->channels && i < shading->shader->component_count; i++)
        channel_finish(&shading->channels[i]);
    free(shading->channels);
    motion_unref(shading->motion);
    for (int u = 0; u < UNIFORMS_MAX; u++) motion_unref(shading->uniform_motions[u]);
    *shading = (struct shading){0};
}

static void layer_finish(struct layer *layer) {
    free(layer->id);
    free(layer->current);
    track_finish(&layer->track);
}

static void layers_free(struct vec *layers) {
    VEC_FOR(layers, struct layer, layer) layer_finish(layer);
    vec_finish(layers);
}

static void node_free(struct node *node) {
    for (int key = 0; key < PROP_COUNT; key++) {
        prop_value_finish(key, &node->props[key]);
        channels_free(&node->channels[key]);
        motion_unref(node->motions[key]);
    }
    motion_unref(node->default_motion);
    targets_free(node->initial);
    targets_free(node->exit);
    free(node->layout_id);
    free(node->web_failed);
    layers_free(&node->layers);
    for (int i = 0; i < node->shading_count; i++) shading_finish(&node->shadings[i]);
    free(node->shadings);
    if (node->cache_destroy) node->cache_destroy(node->cache);
    free(node);
}

void node_ref(struct node *node) {
    node->references++;
}

void node_unref(struct node *node) {
    if (--node->references == 0) node_free(node);
}

const struct prop_value *node_prop(const struct node *node, enum prop_key key) {
    if (node->props[key].given) return &node->props[key];
    return PROP_SPECS[key].has_default ? &PROP_SPECS[key].fallback : &NO_VALUE;
}

static double to_channel(enum prop_key key, double value) {
    return PROP_SPECS[key].logarithmic ? log(value) : value;
}

static double from_channel(enum prop_key key, double value) {
    return PROP_SPECS[key].logarithmic ? exp(value) : value;
}

static bool base_number(const struct node *node, enum prop_key key, double *out) {
    const struct prop_channels *channels = &node->channels[key];
    if (channels->count) {
        *out = from_channel(key, channels->items[0].value);
        return true;
    }
    if (node->props[key].given) {
        *out = node->props[key].number;
        return true;
    }
    if (PROP_SPECS[key].has_default) {
        *out = PROP_SPECS[key].fallback.number;
        return true;
    }
    return false;
}

/* Apply NODE's running layers for KEY over WIDTH values in VALUE; false while it has none. */
static bool layered(const struct node *node, enum prop_key key, double *value, int width,
                    bool present, bool clamp) {
    VEC_FOR(&node->layers, struct layer, layer) {
        if (!layer->has_current || layer->key != key) continue;
        if (layer->add) {
            if (!present) continue;
            for (int i = 0; i < width; i++) {
                value[i] += layer->current[i];
                if (clamp) value[i] = CLAMP(value[i], 0.0, 1.0);
            }
        } else {
            memcpy(value, layer->current, width * sizeof *value);
            present = true;
        }
    }
    return present;
}

bool node_has_number(const struct node *node, enum prop_key key) {
    double value;
    bool present = base_number(node, key, &value);
    return node->layers.length ? layered(node, key, &value, 1, present, false) : present;
}

double node_number(const struct node *node, enum prop_key key, double fallback) {
    double value;
    bool present = base_number(node, key, &value);
    if (node->layers.length) present = layered(node, key, &value, 1, present, false);
    return present ? value : fallback;
}

static void base_color(const struct node *node, enum prop_key key, double out[4]) {
    const struct prop_channels *channels = &node->channels[key];
    if (channels->count == 4) {
        for (int i = 0; i < 4; i++) out[i] = channels->items[i].value;
    } else {
        memcpy(out, node_prop(node, key)->color, 4 * sizeof *out);
    }
}

void node_color(const struct node *node, enum prop_key key, double out[4]) {
    base_color(node, key, out);
    if (node->layers.length) layered(node, key, out, 4, true, true);
}

static void channel_list(const struct node *node, struct tlist *out) {
    const struct prop_channels *channels = &node->channels[PROP_TRANSFORM];
    double parameters[TLIST_MAX * 16];
    for (int i = 0; i < channels->count; i++) parameters[i] = channels->items[i].value;
    *out = (struct tlist){0};
    tlist_set(out, node->transform_kind_count, node->transform_kinds, parameters);
}

/* NODE's displayed transform functions, animations applied. Finish OUT afterwards. */
static void node_transform_list(const struct node *node, struct tlist *out) {
    if (node->channels[PROP_TRANSFORM].count || node->transform_kind_count) channel_list(node, out);
    else tlist_copy(out, &node_prop(node, PROP_TRANSFORM)->transform);
    VEC_FOR(&node->layers, struct layer, layer) {
        if (!layer->has_current || layer->key != PROP_TRANSFORM) continue;
        struct tlist animated = {0};
        tlist_set(&animated, layer->kind_count, layer->kinds, layer->current);
        if (layer->add) {
            tlist_append(out, out, &animated);
            tlist_finish(&animated);
        } else {
            tlist_finish(out);
            *out = animated;
        }
    }
}

struct mat4 node_local_matrix(const struct node *node, double width, double height, double x,
                              double y) {
    /* Drawn every frame: only a transform with layers builds a list; channels and
     * declarations are read in place. */
    bool layered = false;
    VEC_FOR(&node->layers, struct layer, layer) {
        layered = layered || (layer->has_current && layer->key == PROP_TRANSFORM);
    }
    const struct prop_channels *channels = &node->channels[PROP_TRANSFORM];
    double parameters[TLIST_MAX * 16];
    struct tlist list;
    if (layered) {
        node_transform_list(node, &list);
    } else if (channels->count || node->transform_kind_count) {
        for (int i = 0; i < channels->count; i++) parameters[i] = channels->items[i].value;
        list = (struct tlist){.count = node->transform_kind_count, .parameters = parameters};
        memcpy(list.kinds, node->transform_kinds, list.count);
    } else {
        list = node_prop(node, PROP_TRANSFORM)->transform;
    }
    struct mat4 matrix;
    if (list.count == 0) {
        matrix = mat4_translation(x, y, 0);
    } else {
        double origin_x = width * node_prop(node, PROP_ORIGIN_X)->number;
        double origin_y = height * node_prop(node, PROP_ORIGIN_Y)->number;
        struct mat4 to = mat4_translation(x + origin_x, y + origin_y, 0);
        struct mat4 functions = tlist_matrix(&list);
        struct mat4 from = mat4_translation(-origin_x, -origin_y, 0);
        struct mat4 inner = mat4_multiply(&functions, &from);
        matrix = mat4_multiply(&to, &inner);
    }
    if (layered) tlist_finish(&list);
    return matrix;
}

struct mat4 node_matrix(const struct node *node, double width, double height) {
    return node_local_matrix(node, width, height, node_number(node, PROP_X, 0),
                             node_number(node, PROP_Y, 0));
}

bool node_moving(const struct node *node, enum prop_key key) {
    const struct prop_channels *channels = &node->channels[key];
    for (int i = 0; i < channels->count; i++) {
        if (channels->items[i].motion) return true;
    }
    return false;
}

double node_target(const struct node *node, enum prop_key key, double fallback) {
    const struct prop_channels *channels = &node->channels[key];
    if (channels->count == 1) return from_channel(key, channels->items[0].target);
    return node->props[key].given        ? node->props[key].number
           : PROP_SPECS[key].has_default ? PROP_SPECS[key].fallback.number
                                         : fallback;
}

static bool layers_running(const struct node *node, bool finite_only) {
    VEC_FOR(&node->layers, struct layer, layer) {
        if (!layer->done && !(finite_only && track_endless(&layer->track))) return true;
    }
    return false;
}

static bool channel_runs(const struct channel *channel, bool finite_only) {
    return channel_active(channel) && !(finite_only && motion_loops(channel->motion));
}

/* Whether anything of NODE animates; with FINITE_ONLY, anything that ends. */
static bool node_running(const struct node *node, bool finite_only) {
    if (layers_running(node, finite_only)) return true;
    for (int key = 0; key < PROP_COUNT; key++) {
        const struct prop_channels *channels = &node->channels[key];
        for (int i = 0; i < channels->count; i++)
            if (channel_runs(&channels->items[i], finite_only)) return true;
    }
    for (int p = 0; p < node->shading_count; p++) {
        const struct shading *shading = &node->shadings[p];
        for (int i = 0; i < shading->shader->component_count; i++)
            if (channel_runs(&shading->channels[i], finite_only)) return true;
    }
    return false;
}

/* Shadings. */

/* Whether ID can name a shading: 1 to 32 letters, digits, _ or -. */
static bool shading_id_ok(const char *id, size_t length) {
    if (length < 1 || length > 32) return false;
    for (size_t i = 0; i < length; i++) {
        char c = id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '-'))
            return false;
    }
    return true;
}

/* NODE's shading ID, or NULL; ids are unique on a node. */
static struct shading *find_shading(const struct node *node, const char *id) {
    for (int i = 0; i < node->shading_count; i++) {
        if (!strcmp(node->shadings[i].id, id)) return &node->shadings[i];
    }
    return NULL;
}

/* Declared shadings come before those leaving. */
const struct shading *node_stage_shading(const struct node *node, enum shader_stage stage) {
    for (int i = 0; i < node->shading_count; i++) {
        if (node->shadings[i].shader->stage == stage) return &node->shadings[i];
    }
    return NULL;
}

/* How SHADING's uniform U moves. */
static struct motion *shading_motion(const struct node *node, const struct shading *shading,
                                     int u) {
    if (shading->uniform_motions[u]) return shading->uniform_motions[u];
    return shading->motion ? shading->motion : node->default_motion;
}

static bool shading_moving(const struct shading *shading) {
    for (int i = 0; i < shading->shader->component_count; i++)
        if (channel_active(&shading->channels[i])) return true;
    return false;
}

/* Move SHADING's uniforms toward flattened VALUES, or zero without, with their motions. */
static void retarget_shading(const struct node *node, struct shading *shading, const double *values,
                             double time) {
    const struct shader *shader = shading->shader;
    for (int u = 0; u < shader->uniform_count; u++) {
        struct motion *motion = shading_motion(node, shading, u);
        /* A shading moving to zero to leave must get there. */
        if (!values && motion_loops(motion)) motion = NULL;
        for (int i = shader->offsets[u]; i < shader->offsets[u] + shader->counts[u]; i++)
            channel_retarget(&shading->channels[i], values ? values[i] : 0, motion, time);
    }
}

/* Drop leaving shadings that reached zero. */
static void prune_shadings(struct node *node) {
    int kept = 0;
    for (int i = 0; i < node->shading_count; i++) {
        struct shading *shading = &node->shadings[i];
        if (shading->leaving && !shading_moving(shading)) shading_finish(shading);
        else node->shadings[kept++] = *shading;
    }
    node->shading_count = kept;
}

void node_shading_values(const struct node *node, const struct shading *shading, float *out) {
    const struct shader *shader = shading->shader;
    double value[SHADER_COMPONENTS_MAX];
    for (int i = 0; i < shader->component_count; i++) value[i] = shading->channels[i].value;
    /* Keyframes apply in order over the values shown. */
    VEC_FOR(&node->layers, struct layer, layer) {
        if (!layer->has_current || layer->key != PROP_COUNT || strcmp(layer->shading, shading->id))
            continue;
        int u = shader_uniform(shader, layer->uniform, strlen(layer->uniform));
        if (u < 0 || layer->track.width != shader->counts[u]) continue;
        double *at = &value[shader->offsets[u]];
        for (int c = 0; c < shader->counts[u]; c++)
            at[c] = layer->add ? at[c] + layer->current[c] : layer->current[c];
    }
    for (int i = 0; i < shader->component_count; i++) out[i] = (float)value[i];
}

double shading_time(const struct shading *shading, double now) {
    return shading->elapsed + (shading->running ? now - shading->since : 0);
}

bool node_receives(const struct node *node, enum event_name event) {
    if (!((1u << event) & BUBBLING_EVENTS)) return node_handles(node, event);
    for (const struct node *current = node; current; current = current->parent) {
        if (node_handles(current, event)) return true;
    }
    return false;
}

/* The identity shared across remounts: layoutId, or window:<id> for windows; into OUT. */
static bool node_identity(const struct node *node, char *out, size_t size) {
    if (node->layout_id) {
        snprintf(out, size, "%s", node->layout_id);
        return true;
    }
    if (node->kind == KIND_WINDOW && node->props[PROP_WINDOW].given) {
        snprintf(out, size, "window:%lld", (long long)node->props[PROP_WINDOW].id);
        return true;
    }
    return false;
}

void node_hold(struct node *node, enum prop_key key) {
    node->held |= 1u << key;
}

void node_release(struct node *node, enum prop_key key) {
    node->held &= ~(1u << key);
}

/* Scene bookkeeping. */

void scene_init(struct scene *scene) {
    *scene = (struct scene){0};
    idmap_init(&scene->nodes);
    scene->root.kind = KIND_ROOT;
    scene->root.references = 1;
    vec_init(&scene->root.layers, sizeof(struct layer));
    vec_init(&scene->active, sizeof(struct node *));
    vec_init(&scene->exiting, sizeof(struct node *));
    vec_init(&scene->created, sizeof(struct node *));
    vec_init(&scene->removed, sizeof(struct node *));
}

struct node *scene_node(struct scene *scene, int64_t id) {
    return id == 0 ? &scene->root : idmap_get(&scene->nodes, id);
}

static void track_activity(struct scene *scene, struct node *node) {
    bool moving = node->state != NODE_DEAD && node_running(node, false);
    if (moving && !node->active) {
        node_ref(node);
        *(struct node **)vec_push(&scene->active) = node;
    }
    node->active = moving;
    node->settling = moving && node_running(node, true);
}

static void detach(struct node *node) {
    struct node *parent = node->parent;
    if (!parent) return;
    if (node->previous) node->previous->next = node->next;
    else parent->first_child = node->next;
    if (node->next) node->next->previous = node->previous;
    else parent->last_child = node->previous;
    node->parent = node->previous = node->next = NULL;
}

static void attach_before(struct node *parent, struct node *node, struct node *before) {
    node->parent = parent;
    node->next = before;
    node->previous = before ? before->previous : parent->last_child;
    if (node->previous) node->previous->next = node;
    else parent->first_child = node;
    if (before) before->previous = node;
    else parent->last_child = node;
}

static void remove_from(struct vec *nodes, struct node *node) {
    for (size_t i = 0; i < nodes->length; i++) {
        if (*(struct node **)vec_at(nodes, i) == node) {
            vec_remove(nodes, i);
            node_unref(node);
            return;
        }
    }
}

/* Kill NODE and its subtree: cut every link, so nothing reaches freed relatives. */
static void kill_subtree(struct scene *scene, struct node *node) {
    struct node *child = node->first_child;
    while (child) {
        struct node *next = child->next;
        kill_subtree(scene, child);
        child = next;
    }
    node->state = NODE_DEAD;
    node->active = false;
    remove_from(&scene->exiting, node);
    node->parent = node->first_child = node->last_child = node->previous = node->next = NULL;
    if (scene->node_dead) scene->node_dead(scene->data, node);
    node_unref(node);
}

static void destroy_node(struct scene *scene, struct node *node) {
    detach(node);
    kill_subtree(scene, node);
}

void scene_finish(struct scene *scene) {
    while (scene->root.first_child) destroy_node(scene, scene->root.first_child);
    struct vec *lists[] = {&scene->active, &scene->exiting, &scene->created, &scene->removed};
    for (size_t i = 0; i < ARRAY_LENGTH(lists); i++) {
        VEC_FOR(lists[i], struct node *, node) node_unref(*node);
        vec_finish(lists[i]);
    }
    idmap_finish(&scene->nodes);
    layers_free(&scene->root.layers);
}

/* Declarations. */

static struct motion *node_motion(const struct node *node, enum prop_key key) {
    return node->motions[key] ? node->motions[key] : node->default_motion;
}

static void set_transform(struct node *node, const struct tlist *value, struct motion *motion,
                          double time, const struct tlist *from) {
    struct prop_channels *channels = &node->channels[PROP_TRANSFORM];
    struct tlist current;
    if (channels->count || node->transform_kind_count) channel_list(node, &current);
    else tlist_copy(&current, from ? from : value);

    int count;
    uint8_t kinds[TLIST_MAX];
    bool compatible = tlist_shape(&current, value, &count, kinds);
    struct tlist start, target;
    if (compatible) {
        tlist_pad(&start, &current, count, kinds, value);
        tlist_pad(&target, value, count, kinds, &current);
    } else {
        tlist_copy(&start, value);
        tlist_copy(&target, value);
    }
    /* Channels already running carry on; padding appends channels doing nothing yet. */
    int kept = compatible ? channels->count : 0;
    double tolerances[TLIST_MAX * 16];
    tlist_tolerances(target.count, target.kinds, tolerances);
    struct channel *items = xcalloc(start.parameter_count + 1, sizeof *items);
    for (int i = 0; i < start.parameter_count; i++) {
        if (i < kept) {
            items[i] = channels->items[i];
            channels->items[i].motion = NULL;
        } else {
            channel_init(&items[i], start.parameters[i], tolerances[i]);
        }
    }
    channels_free(channels);
    channels->count = start.parameter_count;
    channels->items = items;
    node->transform_kind_count = target.count;
    memcpy(node->transform_kinds, target.kinds, target.count);
    for (int i = 0; i < channels->count; i++)
        channel_retarget(&items[i], target.parameters[i], motion, time);
    tlist_finish(&current);
    tlist_finish(&start);
    tlist_finish(&target);
}

/* Retarget KEY's channels to VALUE; FROM starts a new channel. */
static void set_animated(struct node *node, enum prop_key key, const struct prop_value *value,
                         double time, const struct prop_value *from) {
    const struct prop_spec *spec = &PROP_SPECS[key];
    struct motion *motion = node_motion(node, key);
    struct prop_channels *channels = &node->channels[key];
    switch (spec->type) {
    case TYPE_TRANSFORM:
        set_transform(node, &value->transform, motion, time, from ? &from->transform : NULL);
        break;
    case TYPE_COLOR:
        if (channels_resize(channels, 4)) {
            const double *start = from ? from->color : value->color;
            for (int i = 0; i < 4; i++) channel_init(&channels->items[i], start[i], 1e-3);
        }
        for (int i = 0; i < 4; i++)
            channel_retarget(&channels->items[i], value->color[i], motion, time);
        break;
    default:
        if (channels_resize(channels, 1))
            channel_init(channels->items, to_channel(key, from ? from->number : value->number),
                         spec->tolerance);
        channel_retarget(channels->items, to_channel(key, value->number), motion, time);
        break;
    }
}

/* The value KEY shows now, as a declaration a new channel may start from. */
static void displayed_value(struct scene *scene, struct node *node, enum prop_key key,
                            struct prop_value *out) {
    *out = (struct prop_value){.given = true};
    switch (PROP_SPECS[key].type) {
    case TYPE_COLOR: node_color(node, key, out->color); return;
    case TYPE_TRANSFORM: node_transform_list(node, &out->transform); return;
    default:
        if (node_has_number(node, key)) out->number = node_number(node, key, 0);
        else if (!scene->natural_value ||
                 !scene->natural_value(scene->data, node, key, &out->number))
            out->number = 0;
    }
}

static void set_prop(struct scene *scene, struct node *node, enum prop_key key,
                     struct prop_value *value, bool reset, double time, bool creating) {
    const struct prop_spec *spec = &PROP_SPECS[key];
    node->revision++;
    bool animated = spec->animated && kind_animates(node->kind) && !(node->held & (1u << key));
    if (reset) {
        prop_value_finish(key, &node->props[key]);
        if (animated) {
            if (spec->has_default) set_animated(node, key, &spec->fallback, time, NULL);
            else channels_free(&node->channels[key]);
        }
        prop_value_finish(key, value);
        return;
    }
    struct prop_value from = {0};
    bool have_from = false;
    if (animated) {
        if (creating) {
            if (node->initial && node->initial->values[key].given) {
                prop_value_copy(key, &from, &node->initial->values[key]);
                have_from = true;
            }
        } else if (node->channels[key].count) {
            /* The channel carries on from where it is. */
        } else if (spec->type == TYPE_TRANSFORM) {
            /* A transform first declared starts from what was shown. */
            from.given = true;
            node_transform_list(node, &from.transform);
            have_from = true;
        } else if (scene->natural_value &&
                   scene->natural_value(scene->data, node, key, &from.number)) {
            from.given = true;
            have_from = true;
        }
    }
    prop_value_finish(key, &node->props[key]);
    node->props[key] = *value;
    *value = (struct prop_value){0};
    if (animated) set_animated(node, key, &node->props[key], time, have_from ? &from : NULL);
    if (have_from) prop_value_finish(key, &from);
}

/* A shading as declared, before it is applied. */
struct shading_decl {
    char id[33];
    struct shader *shader;
    bool over, whole_output, running;
    struct motion *motion;
    struct motion *uniform_motions[UNIFORMS_MAX];
    double values[SHADER_COMPONENTS_MAX];
};

/* Decoded declarations, applied only when everything decoded. */
struct pending {
    struct {
        enum prop_key key;
        struct prop_value value;
        bool reset;
    } values[PROP_COUNT];
    int value_count;
    bool has_motions;
    struct motion *motions[PROP_COUNT], *default_motion;
    struct targets *initial;
    bool has_exit;
    struct targets *exit;
    bool has_layout_id;
    char *layout_id;
    bool has_layers;
    struct vec layers;
    bool has_handlers;
    uint32_t handlers;
    bool has_shadings;
    int shading_count;
    struct shading_decl shadings[SHADINGS_MAX];
};

static void pending_free(struct pending *pending) {
    for (int i = 0; i < pending->shading_count; i++) {
        motion_unref(pending->shadings[i].motion);
        for (int u = 0; u < UNIFORMS_MAX; u++)
            motion_unref(pending->shadings[i].uniform_motions[u]);
    }
    for (int i = 0; i < pending->value_count; i++)
        prop_value_finish(pending->values[i].key, &pending->values[i].value);
    for (int key = 0; key < PROP_COUNT; key++) motion_unref(pending->motions[key]);
    motion_unref(pending->default_motion);
    targets_free(pending->initial);
    targets_free(pending->exit);
    free(pending->layout_id);
    layers_free(&pending->layers);
}

static bool prop_for(const struct node *node, const struct json_value *name, enum prop_key *out,
                     struct protocol_error *error) {
    enum prop_key key = prop_from_name(name->string.chars, name->string.length);
    *out = key;
    if (key == PROP_COUNT || !kind_has_prop(node->kind, key))
        return protocol_fail(error, "A %s node has no property \"%s\".", kind_name(node->kind),
                             name->string.chars);
    return true;
}

/* `initial` or `exit` values of shader uniforms: shading id to uniform name to values. */
static bool decode_shading_targets(const struct node *node, const struct json_value *raw,
                                   struct vec *out, struct protocol_error *error) {
    if (!kind_has_shaders(node->kind))
        return protocol_fail(error, "A %s node takes no shaders.", kind_name(node->kind));
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "shaders targets must be an object.");
    for (size_t i = 0; i < raw->object.count; i++) {
        const struct json_member *member = &raw->object.members[i];
        if (!shading_id_ok(member->key.string.chars, member->key.string.length))
            return protocol_fail(error, "\"%s\" is not a shading id.", member->key.string.chars);
        struct uniform_value values[UNIFORMS_MAX];
        int count;
        if (!decode_uniforms(&member->value, values, &count, error)) return false;
        for (int u = 0; u < count; u++) {
            struct shading_target *target = vec_push(out);
            memcpy(target->shading, member->key.string.chars, member->key.string.length + 1);
            target->value = values[u];
        }
    }
    return true;
}

/* The `initial` or `exit` value of uniform NAME of shading SHADING, or NULL. */
static const struct uniform_value *shading_target(const struct targets *targets,
                                                  const char *shading, const char *name) {
    VEC_FOR(&targets->shadings, struct shading_target, target) {
        if (!strcmp(target->shading, shading) && !strcmp(target->value.name, name))
            return &target->value;
    }
    return NULL;
}

static bool decode_targets(const struct node *node, const struct json_value *object,
                           struct targets **out, struct protocol_error *error) {
    if (object->type != JSON_OBJECT)
        return protocol_fail(error, "Expected an object of property values.");
    struct targets *targets = xcalloc(1, sizeof *targets);
    vec_init(&targets->shadings, sizeof(struct shading_target));
    for (size_t i = 0; i < object->object.count; i++) {
        const struct json_member *member = &object->object.members[i];
        if (json_is_string(&member->key, "shaders")) {
            if (!decode_shading_targets(node, &member->value, &targets->shadings, error)) goto fail;
            continue;
        }
        enum prop_key key;
        if (!prop_for(node, &member->key, &key, error)) goto fail;
        if (!PROP_SPECS[key].animated) {
            protocol_fail(error, "Property %s cannot animate.", PROP_SPECS[key].name);
            goto fail;
        }
        if (member->value.type == JSON_NULL) {
            protocol_fail(error, "Animation target %s needs a value.", PROP_SPECS[key].name);
            goto fail;
        }
        prop_value_finish(key, &targets->values[key]);
        if (!prop_decode(key, &member->value, &targets->values[key], error)) goto fail;
    }
    *out = targets;
    return true;
fail:
    targets_free(targets);
    return false;
}

static bool decode_motions(const struct node *node, const struct json_value *object,
                           struct pending *pending, struct protocol_error *error) {
    pending->has_motions = true;
    if (object->type == JSON_NULL) return true;
    if (object->type != JSON_OBJECT) return protocol_fail(error, "transition must be an object.");
    for (size_t i = 0; i < object->object.count; i++) {
        const struct json_member *member = &object->object.members[i];
        struct motion **slot;
        if (json_is_string(&member->key, "default")) {
            slot = &pending->default_motion;
        } else {
            enum prop_key key = prop_from_name(member->key.string.chars, member->key.string.length);
            if (key == PROP_COUNT)
                return protocol_fail(error, "Unknown property \"%s\".", member->key.string.chars);
            slot = kind_has_prop(node->kind, key) ? &pending->motions[key] : NULL;
        }
        struct motion *motion = decode_motion(&member->value, error);
        if (!motion) return false;
        if (slot) {
            motion_unref(*slot);
            *slot = motion;
        } else {
            motion_unref(motion);
        }
    }
    return true;
}

/* Decode FRAMES, values of KEY, into LAYER's track: its keyframes and, for a
 * transform, the functions they share. */
static bool decode_keyframes(enum prop_key key, const struct json_value *frames,
                             struct layer *layer, struct protocol_error *error) {
    if (!frames || frames->type != JSON_ARRAY || frames->array.count < 2 ||
        frames->array.count > 1024)
        return protocol_fail(error, "keyframes needs 2 to 1024 entries.");
    const struct prop_spec *spec = &PROP_SPECS[key];
    int count = (int)frames->array.count;
    struct prop_value *values = xcalloc(count, sizeof *values);
    bool ok = true;
    for (int i = 0; ok && i < count; i++) {
        if (frames->array.items[i].type == JSON_NULL)
            ok = protocol_fail(error, "Keyframes need values.");
        else ok = prop_decode(key, &frames->array.items[i], &values[i], error);
    }
    int width = 1;
    if (ok && spec->type == TYPE_COLOR) {
        width = 4;
    } else if (ok && spec->type == TYPE_TRANSFORM) {
        struct tlist shape = {0};
        for (int i = 0; ok && i < count; i++) {
            int shape_count;
            uint8_t kinds[TLIST_MAX];
            ok = tlist_shape(&shape, &values[i].transform, &shape_count, kinds);
            if (!ok) {
                protocol_fail(error, "Transform keyframes must list the same functions.");
                break;
            }
            shape.count = shape_count;
            memcpy(shape.kinds, kinds, shape_count);
        }
        layer->kind_count = shape.count;
        memcpy(layer->kinds, shape.kinds, shape.count);
        width = 0;
        for (int i = 0; i < shape.count; i++) width += tfunc_arity(shape.kinds[i]);
        tlist_finish(&shape);
    }
    if (ok) {
        struct track *track = &layer->track;
        track->count = count;
        track->width = width;
        track->keyframes = xcalloc((size_t)count * width + 1, sizeof *track->keyframes);
        for (int i = 0; i < count; i++) {
            double *place = track->keyframes + i * width;
            if (spec->type == TYPE_COLOR) {
                memcpy(place, values[i].color, 4 * sizeof *place);
            } else if (spec->type == TYPE_TRANSFORM) {
                struct tlist padded;
                tlist_pad(&padded, &values[i].transform, layer->kind_count, layer->kinds, NULL);
                memcpy(place, padded.parameters, width * sizeof *place);
                tlist_finish(&padded);
            } else {
                place[0] = values[i].number;
            }
        }
    }
    for (int i = 0; i < count; i++) prop_value_finish(key, &values[i]);
    free(values);
    return ok;
}

/* Decode FRAMES, values of a shading uniform, each of the size of the first. */
static bool decode_uniform_keyframes(const struct json_value *frames, struct layer *layer,
                                     struct protocol_error *error) {
    if (!frames || frames->type != JSON_ARRAY || frames->array.count < 2 ||
        frames->array.count > 1024)
        return protocol_fail(error, "keyframes needs 2 to 1024 entries.");
    int count = (int)frames->array.count, width = 0;
    struct track *track = &layer->track;
    track->keyframes = xcalloc((size_t)count * 4 + 1, sizeof *track->keyframes);
    track->count = count;
    for (int i = 0; i < count; i++) {
        if (!shader_decode_value(&frames->array.items[i], width, track->keyframes + i * width,
                                 i ? NULL : &width, "A keyframe of a uniform", error))
            return false;
    }
    track->width = width;
    return true;
}

/* A layer on a shading's uniform: PROPERTY is "shaders.<shading id>.<uniform>". */
static bool shading_layer_target(const struct node *node, const struct json_value *property,
                                 struct layer *layer, struct protocol_error *error) {
    const char *text = property->string.chars + 8;
    size_t length = property->string.length - 8;
    const char *dot = memchr(text, '.', length);
    size_t id_length = dot ? (size_t)(dot - text) : 0;
    size_t name_length = dot ? length - id_length - 1 : 0;
    if (!dot || !shading_id_ok(text, id_length) || !uniform_name_ok(dot + 1, name_length))
        return protocol_fail(error, "\"%s\" names no shading uniform.", property->string.chars);
    if (!kind_has_shaders(node->kind))
        return protocol_fail(error, "A %s node takes no shaders.", kind_name(node->kind));
    layer->key = PROP_COUNT;
    memcpy(layer->shading, text, id_length);
    memcpy(layer->uniform, dot + 1, name_length);
    return true;
}

/* TRACK's keyframe offsets: OFFSETS, rising from 0 to 1, or evenly spaced without. */
static bool decode_offsets(const struct json_value *offsets, struct track *track,
                           struct protocol_error *error) {
    int count = track->count;
    track->offsets = xcalloc(count, sizeof *track->offsets);
    if (offsets && (offsets->type != JSON_ARRAY || (int)offsets->array.count != count))
        return protocol_fail(error, "offsets needs one entry per keyframe.");
    for (int i = 0; i < count; i++) {
        if (!offsets) {
            track->offsets[i] = (double)i / (count - 1);
            continue;
        }
        const struct json_value *offset = &offsets->array.items[i];
        if (offset->type != JSON_NUMBER) return protocol_fail(error, "offsets requires numbers.");
        track->offsets[i] = offset->number;
    }
    for (int i = 0; i < count; i++) {
        if ((i == 0 && track->offsets[i] != 0) ||
            (i > 0 && track->offsets[i] < track->offsets[i - 1]) ||
            (i == count - 1 && track->offsets[i] != 1))
            return protocol_fail(error, "Keyframe offsets must rise from 0 to 1.");
    }
    return true;
}

static bool decode_layer(const struct node *node, const struct json_value *object,
                         struct layer *layer, struct protocol_error *error) {
    *layer = (struct layer){0};
    if (object->type != JSON_OBJECT)
        return protocol_fail(error, "Each animation must be an object.");
    const struct json_value *id = json_get(object, "id");
    int64_t number;
    if (id && id->type == JSON_STRING) {
        layer->id = xstrndup(id->string.chars, id->string.length);
    } else if (json_integer(id, 0, (int64_t)1 << 53, &number)) {
        char text[32];
        snprintf(text, sizeof text, "#%lld", (long long)number);
        layer->id = xstrdup(text);
    } else {
        return protocol_fail(error, "An animation needs a string or numeric id.");
    }
    struct track *track = &layer->track;
    const struct json_value *name = json_get(object, "property");
    enum prop_key key = PROP_COUNT;
    if (!name || name->type != JSON_STRING) {
        protocol_fail(error, "An animation needs a property.");
        goto fail;
    }
    bool uniform = name->string.length > 8 && !memcmp(name->string.chars, "shaders.", 8);
    if (uniform) {
        if (!shading_layer_target(node, name, layer, error)) goto fail;
    } else {
        if (!prop_for(node, name, &key, error)) goto fail;
        if (!PROP_SPECS[key].animated || !kind_animates(node->kind)) {
            protocol_fail(error, "Property %s cannot animate.", PROP_SPECS[key].name);
            goto fail;
        }
        layer->key = key;
    }
    const struct json_value *frames = json_get(object, "keyframes");
    if (!(uniform ? decode_uniform_keyframes(frames, layer, error)
                  : decode_keyframes(key, frames, layer, error)) ||
        !decode_offsets(json_given(object, "offsets"), track, error) ||
        !decode_ease(json_get(object, "ease"), &track->eased, track->ease, error) ||
        !decode_field(object, "duration", 1, true, &track->duration, error) ||
        !decode_field(object, "delay", 0, false, &track->delay, error))
        goto fail;
    const struct json_value *iterations = json_given(object, "iterations");
    int64_t runs;
    if (!iterations) track->iterations = 1;
    else if (json_is_string(iterations, "forever")) track->iterations = MOTION_FOREVER;
    else if (json_integer(iterations, 1, 1000000, &runs)) track->iterations = (int)runs;
    else {
        protocol_fail(error, "iterations must be a count or \"forever\".");
        goto fail;
    }
    const struct json_value *direction = json_given(object, "direction");
    static const char *const directions[] = {"normal", "reverse", "alternate", "alternate-reverse"};
    track->direction = TRACK_NORMAL;
    if (direction) {
        int found = -1;
        for (int i = 0; i < 4; i++) {
            if (json_is_string(direction, directions[i])) found = i;
        }
        if (found < 0) {
            protocol_fail(error, "Unknown direction.");
            goto fail;
        }
        track->direction = found;
    }
    const struct json_value *composite = json_given(object, "composite");
    if (composite && !json_is_string(composite, "replace")) {
        if (!json_is_string(composite, "add")) {
            protocol_fail(error, "Unknown composite.");
            goto fail;
        }
        layer->add = true;
    }
    layer->current = xcalloc(track->width, sizeof *layer->current);
    return true;
fail:
    layer_finish(layer);
    return false;
}

static bool decode_layers(const struct node *node, const struct json_value *raw, struct vec *layers,
                          struct protocol_error *error) {
    if (raw->type == JSON_NULL) return true;
    if (raw->type != JSON_ARRAY) return protocol_fail(error, "animate requires an array.");
    if (raw->array.count > 32) return protocol_fail(error, "At most 32 animations per node.");
    for (size_t i = 0; i < raw->array.count; i++) {
        struct layer layer;
        if (!decode_layer(node, &raw->array.items[i], &layer, error)) return false;
        *(struct layer *)vec_push(layers) = layer;
    }
    return true;
}

/* VALUE for the uniforms of DECL's shader, by name, into its flattened values. */
static bool decode_shading_uniforms(struct shading_decl *decl, const struct json_value *value,
                                    struct protocol_error *error) {
    if (value->type != JSON_OBJECT)
        return protocol_fail(error, "The uniforms of shading %s must be an object.", decl->id);
    const struct shader *shader = decl->shader;
    for (size_t u = 0; u < value->object.count; u++) {
        const struct json_member *member = &value->object.members[u];
        int index = shader_uniform(shader, member->key.string.chars, member->key.string.length);
        if (index < 0)
            return protocol_fail(error, "Shader %s has no uniform %s.", shader->id,
                                 member->key.string.chars);
        if (!shader_decode_value(&member->value, shader->counts[index],
                                 &decl->values[shader->offsets[index]], NULL, shader->names[index],
                                 error))
            return false;
    }
    return true;
}

/* A shading's transition: one motion, or {default?, <uniform>: motion}. */
static bool decode_shading_motions(struct shading_decl *decl, const struct json_value *value,
                                   struct protocol_error *error) {
    if (value->type == JSON_NULL) return true;
    /* A motion names its type; parts may include a uniform named `type`. */
    const struct json_value *type = value->type == JSON_OBJECT ? json_given(value, "type") : NULL;
    bool parts = value->type == JSON_OBJECT && (!type || type->type != JSON_STRING);
    if (!parts) return (decl->motion = decode_motion(value, error)) != NULL;
    for (size_t i = 0; i < value->object.count; i++) {
        const struct json_member *member = &value->object.members[i];
        struct motion **slot;
        if (json_is_string(&member->key, "default")) {
            slot = &decl->motion;
        } else {
            int index =
                shader_uniform(decl->shader, member->key.string.chars, member->key.string.length);
            if (index < 0)
                return protocol_fail(error, "Shader %s has no uniform %s to move.",
                                     decl->shader->id, member->key.string.chars);
            slot = &decl->uniform_motions[index];
        }
        motion_unref(*slot);
        if (!(*slot = decode_motion(&member->value, error))) return false;
    }
    return true;
}

static bool decode_shading(const struct shaders *shaders, const struct json_value *raw,
                           struct shading_decl *out, struct protocol_error *error) {
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "Each shading must be an object.");
    const struct json_value *id = json_get(raw, "id");
    if (!id || id->type != JSON_STRING || !shading_id_ok(id->string.chars, id->string.length))
        return protocol_fail(error, "A shading id is 1 to 32 letters, digits, _ or -.");
    memcpy(out->id, id->string.chars, id->string.length + 1);
    const struct json_value *shader = json_get(raw, "shader");
    if (!shader || shader->type != JSON_STRING ||
        !(out->shader = shaders_find(shaders, shader->string.chars, shader->string.length)))
        return protocol_fail(error, "Shading %s names no defined shader.", out->id);
    out->running = true;
    for (size_t i = 0; i < raw->object.count; i++) {
        const struct json_value *name = &raw->object.members[i].key;
        const struct json_value *value = &raw->object.members[i].value;
        if (json_is_string(name, "id") || json_is_string(name, "shader")) continue;
        if (json_is_string(name, "layer")) {
            if (out->shader->stage != STAGE_PAINT ||
                (!json_is_string(value, "under") && !json_is_string(value, "over")))
                return protocol_fail(error, "A paint's layer is \"under\" or \"over\".");
            out->over = json_is_string(value, "over");
        } else if (json_is_string(name, "area")) {
            if (out->shader->stage == STAGE_FILTER ||
                (!json_is_string(value, "box") && !json_is_string(value, "output")))
                return protocol_fail(error, "A paint's or effect's area is \"box\" or "
                                            "\"output\".");
            out->whole_output = json_is_string(value, "output");
        } else if (json_is_string(name, "time")) {
            if (value->type != JSON_TRUE && value->type != JSON_FALSE)
                return protocol_fail(error, "A shading's time is a boolean.");
            out->running = value->type == JSON_TRUE;
        } else if (json_is_string(name, "transition")) {
            if (!decode_shading_motions(out, value, error)) return false;
        } else if (json_is_string(name, "uniforms")) {
            if (!decode_shading_uniforms(out, value, error)) return false;
        } else {
            return protocol_fail(error, "Shading %s has no field \"%s\".", out->id,
                                 name->string.chars);
        }
    }
    return true;
}

static bool decode_shadings(const struct shaders *shaders, const struct node *node,
                            const struct json_value *raw, struct pending *pending,
                            struct protocol_error *error) {
    pending->has_shadings = true;
    pending->shading_count = 0;
    if (raw->type == JSON_NULL) return true;
    if (!kind_has_shaders(node->kind))
        return protocol_fail(error, "A %s node takes no shaders.", kind_name(node->kind));
    if (raw->type != JSON_ARRAY) return protocol_fail(error, "shaders requires an array.");
    if (raw->array.count > SHADINGS_MAX)
        return protocol_fail(error, "At most %d shaders per node.", SHADINGS_MAX);
    int filters = 0, effects = 0;
    for (size_t i = 0; i < raw->array.count; i++) {
        struct shading_decl *decl = &pending->shadings[pending->shading_count++];
        if (!decode_shading(shaders, &raw->array.items[i], decl, error)) return false;
        for (int other = 0; other < pending->shading_count - 1; other++) {
            if (!strcmp(pending->shadings[other].id, decl->id))
                return protocol_fail(error, "Two shadings share id %s.", decl->id);
        }
        enum shader_stage stage = decl->shader->stage;
        if (node->kind == KIND_BACKGROUND && stage != STAGE_PAINT)
            return protocol_fail(error, "A background takes only paints.");
        if (node->kind == KIND_GROUP && stage == STAGE_FILTER)
            return protocol_fail(error, "A group has no content to filter.");
        if (stage == STAGE_FILTER && ++filters > 1)
            return protocol_fail(error, "A node takes one filter.");
        if (stage == STAGE_EFFECT && ++effects > 1)
            return protocol_fail(error, "A node takes one effect.");
    }
    return true;
}

static bool decode_props(const struct scene *scene, const struct node *node,
                         const struct json_value *props, bool creating, struct pending *pending,
                         struct protocol_error *error) {
    vec_init(&pending->layers, sizeof(struct layer));
    if (!props || props->type != JSON_OBJECT)
        return protocol_fail(error, "Node properties must be an object.");
    for (size_t i = 0; i < props->object.count; i++) {
        const struct json_member *member = &props->object.members[i];
        const struct json_value *name = &member->key, *raw = &member->value;
        if (json_is_string(name, "shaders")) {
            if (!decode_shadings(scene->shaders, node, raw, pending, error)) return false;
        } else if (json_is_string(name, "transition")) {
            if (!decode_motions(node, raw, pending, error)) return false;
        } else if (json_is_string(name, "initial")) {
            if (creating && raw->type != JSON_NULL) {
                if (!decode_targets(node, raw, &pending->initial, error)) return false;
            }
        } else if (json_is_string(name, "exit")) {
            pending->has_exit = true;
            if (raw->type != JSON_NULL && !decode_targets(node, raw, &pending->exit, error))
                return false;
        } else if (json_is_string(name, "layoutId")) {
            /* Identities compare in 128 bytes. */
            if (raw->type != JSON_NULL && (raw->type != JSON_STRING || raw->string.length > 120))
                return protocol_fail(error, "layoutId must be a string of at most 120 bytes.");
            pending->has_layout_id = true;
            if (raw->type == JSON_STRING)
                pending->layout_id = xstrndup(raw->string.chars, raw->string.length);
        } else if (json_is_string(name, "animate")) {
            pending->has_layers = true;
            if (!decode_layers(node, raw, &pending->layers, error)) return false;
        } else if (json_is_string(name, "handlers")) {
            pending->has_handlers = true;
            if (raw->type == JSON_NULL) continue;
            if (raw->type != JSON_ARRAY) return protocol_fail(error, "handlers requires an array.");
            for (size_t h = 0; h < raw->array.count; h++) {
                const struct json_value *event = &raw->array.items[h];
                if (event->type != JSON_STRING) continue;
                enum event_name found = event_from_name(event->string.chars, event->string.length);
                if (found != EVENT_COUNT) pending->handlers |= 1u << found;
            }
        } else {
            enum prop_key key;
            if (!prop_for(node, name, &key, error)) return false;
            int index = pending->value_count++;
            pending->values[index].key = key;
            pending->values[index].reset = raw->type == JSON_NULL;
            if (!prop_decode(key, raw, &pending->values[index].value, error)) {
                pending->value_count--;
                return false;
            }
        }
    }
    return true;
}

/* Sample NODE's layers at TIME; true while any runs on, with FINITE set while one
 * that ends does. */
static bool sample_layers(struct node *node, double time, bool *finite) {
    bool running = false;
    VEC_FOR(&node->layers, struct layer, layer) {
        if (layer->done) continue;
        switch (track_sample(&layer->track, time - layer->start, layer->current)) {
        case TRACK_DONE:
            layer->has_current = false;
            layer->done = true;
            break;
        case TRACK_PENDING: layer->has_current = false; break;
        case TRACK_RUNNING: layer->has_current = true; break;
        }
        if (layer->done) continue;
        running = true;
        if (finite && !track_endless(&layer->track)) *finite = true;
    }
    return running;
}

/* Make LAYERS the node's animations. One declared before keeps its start, so it
 * runs on (or stays finished); the others start at TIME. */
static void start_layers(struct node *node, struct vec *layers, double time) {
    VEC_FOR(layers, struct layer, layer) {
        layer->start = time;
        VEC_FOR(&node->layers, struct layer, previous) {
            if (!strcmp(previous->id, layer->id)) {
                layer->start = previous->start;
                layer->done = previous->done;
                break;
            }
        }
    }
    layers_free(&node->layers);
    node->layers = *layers;
    vec_init(layers, sizeof(struct layer));
    sample_layers(node, time, NULL);
}

/*
 * Declare shadings. One keeping its id keeps its displayed uniforms, which move to
 * the new values with its motions, and its clock. A new one starts as declared
 * (or from `initial`) on a new node, and from zero on a node already shown; one
 * no longer declared moves to zero and then goes. A shader at zero is meant to
 * show nothing (a filter, to change nothing).
 */
static void set_shadings(struct node *node, struct shading_decl *decls, int count, double time,
                         bool creating) {
    int previous_count = node->shading_count;
    struct shading *next = xcalloc(MAX(1, count + previous_count), sizeof *next);
    bool *claimed = xcalloc(MAX(1, previous_count), sizeof *claimed);
    int n = 0;
    for (int i = 0; i < count; i++) {
        struct shading_decl *decl = &decls[i];
        const struct shader *shader = decl->shader;
        struct shading *old = NULL;
        for (int p = 0; p < previous_count && !old; p++) {
            if (!claimed[p] && !strcmp(node->shadings[p].id, decl->id)) {
                old = &node->shadings[p];
                claimed[p] = true;
            }
        }
        struct shading *shading = &next[n++];
        memcpy(shading->id, decl->id, sizeof shading->id);
        shading->key = (uint32_t)hash_bytes(HASH_SEED, decl->id, strlen(decl->id));
        shading->shader = decl->shader;
        shading->over = decl->over;
        shading->whole_output = decl->whole_output;
        shading->motion = decl->motion;
        decl->motion = NULL;
        memcpy(shading->uniform_motions, decl->uniform_motions, sizeof shading->uniform_motions);
        memset(decl->uniform_motions, 0, sizeof decl->uniform_motions);
        /* The clock carries on from the shading this one continues; it runs while
         * declared with `time` and holds where it was otherwise. */
        if (old && old->shader == shading->shader) {
            shading->elapsed = old->elapsed;
            shading->since = old->since;
            shading->running = old->running;
            shading->reported = old->reported;
        }
        if (decl->running && !shading->running) shading->since = time;
        if (!decl->running && shading->running) shading->elapsed += time - shading->since;
        shading->running = decl->running;
        shading->channels = xcalloc(MAX(1, shader->component_count), sizeof *shading->channels);
        for (int u = 0; u < shader->uniform_count; u++) {
            struct channel *channels = &shading->channels[shader->offsets[u]];
            int count = shader->counts[u];
            int k =
                old ? shader_uniform(old->shader, shader->names[u], strlen(shader->names[u])) : -1;
            if (k >= 0 && old->shader->counts[k] == count) {
                /* The channels move here, motion and all; OLD keeps none to finish. */
                struct channel *kept = &old->channels[old->shader->offsets[k]];
                for (int c = 0; c < count; c++) {
                    channels[c] = kept[c];
                    kept[c].motion = NULL;
                }
                continue;
            }
            static const double zero[4];
            const double *start = zero;
            if (creating) {
                const struct uniform_value *initial =
                    node->initial ? shading_target(node->initial, shading->id, shader->names[u])
                                  : NULL;
                start = initial && initial->count == count ? initial->components
                                                           : &decl->values[shader->offsets[u]];
            }
            for (int c = 0; c < count; c++) channel_init(&channels[c], start[c], 1e-3);
        }
        retarget_shading(node, shading, decl->values, time);
        if (old) shading_finish(old);
    }
    /* What is no longer declared moves out after what is, at most SHADINGS_MAX of it. A
     * filter or effect only shows while none is declared, so one replaced goes at once. */
    int leaving = 0;
    for (int p = 0; p < previous_count; p++) {
        if (claimed[p]) continue;
        struct shading *shading = &next[n];
        *shading = node->shadings[p];
        shading->leaving = true;
        bool replaced = false;
        for (int i = 0; i < count && shading->shader->stage != STAGE_PAINT; i++)
            replaced = replaced || decls[i].shader->stage == shading->shader->stage;
        if (!replaced) retarget_shading(node, shading, NULL, time);
        if (!replaced && shading_moving(shading) && leaving < SHADINGS_MAX) {
            n++;
            leaving++;
        } else {
            shading_finish(shading);
        }
    }
    free(claimed);
    free(node->shadings);
    node->shadings = next;
    node->shading_count = n;
}

static void apply_pending(struct scene *scene, struct node *node, struct pending *pending,
                          double time, bool creating) {
    /* Metadata first: a commit changing both a transition and a value animates
     * that value with the new transition. */
    if (pending->has_motions) {
        for (int key = 0; key < PROP_COUNT; key++) {
            motion_unref(node->motions[key]);
            node->motions[key] = pending->motions[key];
            pending->motions[key] = NULL;
        }
        motion_unref(node->default_motion);
        node->default_motion = pending->default_motion;
        pending->default_motion = NULL;
    }
    if (pending->initial) {
        targets_free(node->initial);
        node->initial = pending->initial;
        pending->initial = NULL;
    }
    if (pending->has_exit) {
        targets_free(node->exit);
        node->exit = pending->exit;
        pending->exit = NULL;
    }
    if (pending->has_layout_id) {
        free(node->layout_id);
        node->layout_id = pending->layout_id;
        pending->layout_id = NULL;
    }
    if (pending->has_handlers) node->handlers = pending->handlers;
    if (pending->has_layers) start_layers(node, &pending->layers, time);
    for (int i = 0; i < pending->value_count; i++) {
        set_prop(scene, node, pending->values[i].key, &pending->values[i].value,
                 pending->values[i].reset, time, creating);
    }
    pending->value_count = 0;
    if (pending->has_shadings)
        set_shadings(node, pending->shadings, pending->shading_count, time, creating);
    track_activity(scene, node);
}

static bool apply_props(struct scene *scene, struct node *node, const struct json_value *props,
                        double time, bool creating, struct protocol_error *error) {
    struct pending *pending = xcalloc(1, sizeof *pending);
    bool ok = decode_props(scene, node, props, creating, pending, error);
    if (ok) apply_pending(scene, node, pending, time, creating);
    pending_free(pending);
    free(pending);
    return ok;
}

bool scene_create_node(struct scene *scene, int64_t id, const struct json_value *type,
                       const struct json_value *props, double time, struct protocol_error *error) {
    if (id <= 0) return protocol_fail(error, "Node ids must be positive integers.");
    if (idmap_get(&scene->nodes, id))
        return protocol_fail(error, "Node %lld already exists.", (long long)id);
    enum node_kind kind = type && type->type == JSON_STRING
                              ? kind_from_name(type->string.chars, type->string.length)
                              : KIND_COUNT;
    if (kind == KIND_COUNT) return protocol_fail(error, "Unknown node type.");
    struct node *node = node_new(id, kind);
    if (!apply_props(scene, node, props, time, true, error)) {
        /* Props that fail to decode leave it untouched and unseen. */
        node_unref(node);
        return false;
    }
    idmap_put(&scene->nodes, id, node);
    node_ref(node);
    *(struct node **)vec_push(&scene->created) = node;
    return true;
}

bool scene_update(struct scene *scene, int64_t id, const struct json_value *props, double time,
                  struct protocol_error *error) {
    struct node *node = scene_node(scene, id);
    if (!node || node == &scene->root)
        return protocol_fail(error, "Unknown node %lld.", (long long)id);
    return apply_props(scene, node, props, time, false, error);
}

bool scene_insert(struct scene *scene, int64_t parent_id, int64_t id, int64_t before_id,
                  struct protocol_error *error) {
    struct node *parent = scene_node(scene, parent_id);
    struct node *node = scene_node(scene, id);
    struct node *before = before_id ? scene_node(scene, before_id) : NULL;
    if (!parent) return protocol_fail(error, "Unknown node %lld.", (long long)parent_id);
    if (!node || node == &scene->root)
        return protocol_fail(error, "Unknown node %lld.", (long long)id);
    if (before_id && !before)
        return protocol_fail(error, "Unknown node %lld.", (long long)before_id);
    for (struct node *ancestor = parent; ancestor; ancestor = ancestor->parent) {
        if (ancestor == node)
            return protocol_fail(error, "Node %lld cannot contain itself.", (long long)id);
    }
    if (before && before->parent != parent)
        return protocol_fail(error, "Node %lld is not a child of %lld.", (long long)before_id,
                             (long long)parent_id);
    if (before == node) return true;
    detach(node);
    attach_before(parent, node, before);
    return true;
}

static void mark_removed(struct scene *scene, struct node *node) {
    if (node->state == NODE_LIVE) node->state = NODE_REMOVED;
    if (idmap_get(&scene->nodes, node->id) == node) idmap_remove(&scene->nodes, node->id);
    NODE_FOR_CHILDREN(node, child) mark_removed(scene, child);
}

bool scene_remove(struct scene *scene, int64_t parent_id, int64_t id,
                  struct protocol_error *error) {
    struct node *node = scene_node(scene, id);
    struct node *parent = scene_node(scene, parent_id);
    if (!node || node == &scene->root)
        return protocol_fail(error, "Unknown node %lld.", (long long)id);
    if (!parent || node->parent != parent)
        return protocol_fail(error, "Node %lld is not a child of %lld.", (long long)id,
                             (long long)parent_id);
    mark_removed(scene, node);
    node_ref(node);
    *(struct node **)vec_push(&scene->removed) = node;
    return true;
}

void scene_clear(struct scene *scene) {
    struct node *child = scene->root.first_child;
    while (child) {
        struct node *next = child->next;
        if (child->state == NODE_LIVE) {
            targets_free(child->exit);
            child->exit = NULL;
            struct protocol_error ignored;
            scene_remove(scene, 0, child->id, &ignored);
        } else if (child->state != NODE_REMOVED) {
            destroy_node(scene, child);
        }
        child = next;
    }
}

/* Motion hand-over. */

/* The map from NODE's parent plane to the scene's, as its ancestors show now; false
 * under a screen, whose space follows an output rather than the scene. */
static bool parent_space(const struct scene *scene, const struct node *node, struct mat3 *out) {
    struct mat4 matrix = MAT4_IDENTITY;
    for (const struct node *ancestor = node->parent; ancestor && ancestor->parent;
         ancestor = ancestor->parent) {
        if (ancestor->kind == KIND_SCREEN) return false;
        double width = node_number(ancestor, PROP_WIDTH, 0),
               height = node_number(ancestor, PROP_HEIGHT, 0);
        if (scene->size) scene->size(scene->data, ancestor, &width, &height);
        struct mat4 local = node_matrix(ancestor, width, height);
        matrix = mat4_multiply(&local, &matrix);
    }
    *out = mat4_plane(&matrix);
    return true;
}

static void inherit_motion(struct scene *scene, struct node *node, struct node *previous,
                           double time) {
    double x_velocity = 0, y_velocity = 0, x = 0, y = 0;
    bool moved = false;
    struct mat3 map;
    /* Under another parent, the position and its velocity move into NODE's parent
     * space, so NODE continues from where PREVIOUS was shown. */
    if (previous->parent != node->parent) {
        struct mat3 from, to, inverse;
        if (parent_space(scene, previous, &from) && parent_space(scene, node, &to) &&
            mat3_invert(to, &inverse)) {
            map = mat3_multiply(inverse, from);
            moved = true;
        }
    }
    if (moved) {
        const struct prop_channels *xs = &previous->channels[PROP_X],
                                   *ys = &previous->channels[PROP_Y];
        x = xs->count ? xs->items[0].value : node_number(previous, PROP_X, 0);
        y = ys->count ? ys->items[0].value : node_number(previous, PROP_Y, 0);
        x_velocity = xs->count ? xs->items[0].velocity : 0;
        y_velocity = ys->count ? ys->items[0].velocity : 0;
    }
    for (int key = 0; key < PROP_COUNT; key++) {
        const struct prop_channels *source = &previous->channels[key];
        struct prop_channels *heir = &node->channels[key];
        if (!source->count && !(moved && (key == PROP_X || key == PROP_Y))) continue;
        if (key == PROP_TRANSFORM &&
            (previous->transform_kind_count != node->transform_kind_count ||
             memcmp(previous->transform_kinds, node->transform_kinds, node->transform_kind_count)))
            continue;
        if (!heir->count) continue;
        struct motion *motion = node_motion(node, key);
        if (moved && (key == PROP_X || key == PROP_Y)) {
            double new_x, new_y, j[4];
            mat3_apply(map, x, y, &new_x, &new_y);
            mat3_jacobian(map, x, y, j);
            if (key == PROP_X)
                channel_inherit(&heir->items[0], new_x, j[0] * x_velocity + j[2] * y_velocity,
                                motion, time);
            else
                channel_inherit(&heir->items[0], new_y, j[1] * x_velocity + j[3] * y_velocity,
                                motion, time);
            continue;
        }
        for (int i = 0; i < MIN(source->count, heir->count); i++)
            channel_inherit(&heir->items[i], source->items[i].value, source->items[i].velocity,
                            motion, time);
    }
    /* Shadings continue from what PREVIOUS showed of the shading with the same id. */
    for (int i = 0; i < node->shading_count; i++) {
        struct shading *shading = &node->shadings[i];
        const struct shading *source = find_shading(previous, shading->id);
        const struct shader *shader = shading->shader;
        for (int u = 0; source && u < shader->uniform_count; u++) {
            int k = shader_uniform(source->shader, shader->names[u], strlen(shader->names[u]));
            if (k < 0 || source->shader->counts[k] != shader->counts[u]) continue;
            const struct channel *from = &source->channels[source->shader->offsets[k]];
            struct channel *to = &shading->channels[shader->offsets[u]];
            for (int c = 0; c < shader->counts[u]; c++)
                channel_inherit(&to[c], from[c].value, from[c].velocity,
                                shading_motion(node, shading, u), time);
        }
        if (source && source->shader == shading->shader) {
            shading->elapsed = shading_time(source, time);
            shading->since = time;
        }
    }
    track_activity(scene, node);
}

/* A removed node a created one with the same identity may take over. */
struct stashed {
    struct node *node;
    char identity[128];
};

static void stash_identities(struct node *node, struct vec *stash) {
    struct stashed entry = {node};
    if (node_identity(node, entry.identity, sizeof entry.identity)) {
        bool known = false;
        VEC_FOR(stash, struct stashed, other)
            known = known || !strcmp(entry.identity, other->identity);
        if (!known) *(struct stashed *)vec_push(stash) = entry;
    }
    NODE_FOR_CHILDREN(node, child) stash_identities(child, stash);
}

static void begin_exit(struct scene *scene, struct node *node, double time) {
    node->state = NODE_EXITING;
    /* An endless animation would keep the node from ever leaving. */
    for (size_t i = 0; i < node->layers.length;) {
        struct layer *layer = vec_at(&node->layers, i);
        if (track_endless(&layer->track)) {
            layer_finish(layer);
            vec_remove(&node->layers, i);
        } else {
            i++;
        }
    }
    struct targets *exit = node->exit;
    for (int key = 0; key < PROP_COUNT; key++) {
        if (!exit->values[key].given) continue;
        struct prop_value displayed;
        displayed_value(scene, node, key, &displayed);
        set_animated(node, key, &exit->values[key], time, &displayed);
        prop_value_finish(key, &displayed);
    }
    VEC_FOR(&exit->shadings, struct shading_target, target) {
        struct shading *shading = find_shading(node, target->shading);
        int u = shading ? shader_uniform(shading->shader, target->value.name,
                                         strlen(target->value.name))
                        : -1;
        if (u < 0 || shading->shader->counts[u] != target->value.count) continue;
        for (int c = 0; c < target->value.count; c++)
            channel_retarget(&shading->channels[shading->shader->offsets[u] + c],
                             target->value.components[c], shading_motion(node, shading, u), time);
    }
    /* So would an endless motion: whatever loops arrives at once. */
    for (int key = 0; key < PROP_COUNT; key++) {
        for (int c = 0; c < node->channels[key].count; c++) {
            struct channel *channel = &node->channels[key].items[c];
            if (motion_loops(channel->motion)) channel_jump(channel, channel->target);
        }
    }
    for (int i = 0; i < node->shading_count; i++) {
        struct shading *shading = &node->shadings[i];
        for (int c = 0; c < shading->shader->component_count; c++) {
            struct channel *channel = &shading->channels[c];
            if (motion_loops(channel->motion)) channel_jump(channel, channel->target);
        }
    }
    track_activity(scene, node);
    if (node_running(node, false)) {
        node_ref(node);
        *(struct node **)vec_push(&scene->exiting) = node;
    } else {
        destroy_node(scene, node);
    }
}

void scene_finish_commit(struct scene *scene, double time) {
    struct vec stash;
    vec_init(&stash, sizeof(struct stashed));
    VEC_FOR(&scene->removed, struct node *, removed) stash_identities(*removed, &stash);
    VEC_FOR(&scene->created, struct node *, created) {
        struct node *node = *created;
        char identity[128];
        if (node->state == NODE_DEAD || !node_identity(node, identity, sizeof identity)) continue;
        for (size_t i = 0; i < stash.length; i++) {
            struct stashed *stashed = vec_at(&stash, i);
            if (strcmp(identity, stashed->identity)) continue;
            struct node *previous = stashed->node;
            vec_remove(&stash, i);
            inherit_motion(scene, node, previous, time);
            /* A claimed node lives on elsewhere; never draw it twice. */
            previous->state = NODE_DEAD;
            break;
        }
    }
    vec_finish(&stash);
    VEC_FOR(&scene->removed, struct node *, slot) {
        struct node *removed = *slot;
        bool exits = removed->exit && removed->state == NODE_REMOVED && removed->parent &&
                     removed->parent->state != NODE_DEAD;
        if (exits) begin_exit(scene, removed, time);
        else if (removed->parent || removed->state != NODE_DEAD) destroy_node(scene, removed);
        node_unref(removed);
    }
    vec_clear(&scene->removed);
    VEC_FOR(&scene->created, struct node *, created) node_unref(*created);
    vec_clear(&scene->created);
}

/* Sample CHANNEL at TIME, noting in MOVING and FINITE whether it moves on and ends. */
static void sample_channel(struct channel *channel, double time, bool *moving, bool *finite) {
    if (!channel_sample(channel, time)) return;
    *moving = true;
    if (!motion_loops(channel->motion)) *finite = true;
}

void scene_advance(struct scene *scene, double time) {
    size_t kept = 0;
    for (size_t i = 0; i < scene->active.length; i++) {
        struct node *node = *(struct node **)vec_at(&scene->active, i);
        if (node->active && node->state != NODE_DEAD) {
            bool moving = false, finite = false;
            for (int key = 0; key < PROP_COUNT; key++) {
                struct prop_channels *channels = &node->channels[key];
                for (int c = 0; c < channels->count; c++)
                    sample_channel(&channels->items[c], time, &moving, &finite);
            }
            for (int p = 0; p < node->shading_count; p++) {
                struct shading *shading = &node->shadings[p];
                for (int c = 0; c < shading->shader->component_count; c++)
                    sample_channel(&shading->channels[c], time, &moving, &finite);
            }
            prune_shadings(node);
            node->active = sample_layers(node, time, &finite) || moving;
            node->settling = finite;
        }
        if (node->active && node->state != NODE_DEAD) {
            *(struct node **)vec_at(&scene->active, kept++) = node;
        } else {
            node->active = node->settling = false;
            node_unref(node);
        }
    }
    scene->active.length = kept;
    for (size_t i = 0; i < scene->exiting.length;) {
        struct node *node = *(struct node **)vec_at(&scene->exiting, i);
        if (node->state != NODE_DEAD && !node_running(node, false)) {
            destroy_node(scene, node); /* removes it from the exiting list */
            continue;
        }
        i++;
    }
}

bool scene_settling(const struct scene *scene) {
    VEC_FOR(&scene->active, struct node *, slot) {
        if ((*slot)->active && (*slot)->settling) return true;
    }
    return false;
}

void node_jump(struct scene *scene, struct node *node, enum prop_key key, double value) {
    struct prop_channels *channels = &node->channels[key];
    if (channels_resize(channels, 1)) channel_init(channels->items, 0, PROP_SPECS[key].tolerance);
    channel_jump(channels->items, to_channel(key, value));
    track_activity(scene, node);
}

static void for_each(struct node *node, void (*function)(struct node *, void *), void *data) {
    NODE_FOR_CHILDREN(node, child) {
        if (child->state != NODE_LIVE) continue;
        function(child, data);
        for_each(child, function, data);
    }
}

void scene_for_each(struct scene *scene, void (*function)(struct node *node, void *data),
                    void *data) {
    for_each(&scene->root, function, data);
}
