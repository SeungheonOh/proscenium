#include "shader.h"

#include <math.h>

#define ID_MAX 64
#define SOURCE_MAX 65536

/* Names the preludes declare themselves. */
static const char *const PRELUDE_NAMES[] = {
    "size",   "radius", "pixel",   "time",     "pointer", "paint",
    "filter", "effect", "content", "backdrop", "main",
};

bool uniform_name_ok(const char *name, size_t length) {
    static const char *const prefixes[] = {"gl_", "u_", "v_", "a_", "stage_"};
    if (length < 1 || length > 32) return false;
    if (!((name[0] >= 'a' && name[0] <= 'z') || (name[0] >= 'A' && name[0] <= 'Z'))) return false;
    for (size_t i = 0; i < length; i++) {
        char c = name[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '_'))
            return false;
    }
    for (size_t i = 0; i < ARRAY_LENGTH(prefixes); i++) {
        if (!strncmp(name, prefixes[i], strlen(prefixes[i]))) return false;
    }
    for (size_t i = 0; i < ARRAY_LENGTH(PRELUDE_NAMES); i++) {
        if (strlen(PRELUDE_NAMES[i]) == length && !memcmp(name, PRELUDE_NAMES[i], length))
            return false;
    }
    return true;
}

static bool small_number(const struct json_value *raw, double *out) {
    if (raw->type != JSON_NUMBER || !(fabs(raw->number) < 1e12)) return false;
    *out = raw->number;
    return true;
}

bool shader_decode_value(const struct json_value *raw, int count, double out[4], int *out_count,
                         const char *what, struct protocol_error *error) {
    int given = raw->type == JSON_ARRAY ? (int)raw->array.count : 1;
    bool ok = (given == 1 || given == 2 || given == 4) && (!count || given == count);
    for (int c = 0; ok && c < given; c++)
        ok = small_number(raw->type == JSON_ARRAY ? &raw->array.items[c] : raw, &out[c]);
    if (!ok) {
        return count ? protocol_fail(error, "%s takes %d number%s.", what, count,
                                     count == 1 ? "" : "s")
                     : protocol_fail(error, "%s takes 1, 2 or 4 numbers.", what);
    }
    if (out_count) *out_count = given;
    return true;
}

bool decode_uniforms(const struct json_value *raw, struct uniform_value *out, int *count,
                     struct protocol_error *error) {
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "uniforms must be an object.");
    if (raw->object.count > UNIFORMS_MAX)
        return protocol_fail(error, "At most %d uniforms.", UNIFORMS_MAX);
    for (size_t i = 0; i < raw->object.count; i++) {
        const struct json_member *member = &raw->object.members[i];
        struct uniform_value *uniform = &out[i];
        if (!uniform_name_ok(member->key.string.chars, member->key.string.length))
            return protocol_fail(error, "\"%s\" is not a usable uniform name.",
                                 member->key.string.chars);
        memcpy(uniform->name, member->key.string.chars, member->key.string.length + 1);
        if (!shader_decode_value(&member->value, 0, uniform->components, &uniform->count,
                                 uniform->name, error))
            return false;
    }
    *count = (int)raw->object.count;
    return true;
}

static void shader_free(struct shader *shader) {
    free(shader->id);
    free(shader->source);
    free(shader);
}

void shaders_init(struct shaders *shaders) {
    vec_init(&shaders->list, sizeof(struct shader *));
}

void shaders_finish(struct shaders *shaders, void (*free_program)(void *program)) {
    VEC_FOR(&shaders->list, struct shader *, slot) {
        if ((*slot)->program && free_program) free_program((*slot)->program);
        shader_free(*slot);
    }
    vec_finish(&shaders->list);
}

struct shader *shaders_find(const struct shaders *shaders, const char *id, size_t length) {
    VEC_FOR(&shaders->list, struct shader *, slot) {
        if (strlen((*slot)->id) == length && !memcmp((*slot)->id, id, length)) return *slot;
    }
    return NULL;
}

int shader_uniform(const struct shader *shader, const char *name, size_t length) {
    for (int i = 0; i < shader->uniform_count; i++) {
        if (strlen(shader->names[i]) == length && !memcmp(shader->names[i], name, length)) return i;
    }
    return -1;
}

void shader_bound(const struct shader_bound *bound, const float *values, double radius,
                  double pixel, double out[4]) {
    for (int side = 0; side < 4; side++) out[side] = bound->form_count ? -INFINITY : 0;
    for (int f = 0; f < bound->form_count; f++) {
        const struct shader_form *form = &bound->forms[f];
        double sides[4];
        for (int side = 0; side < 4; side++)
            sides[side] = form->pad[side] + form->pixel[side] * pixel + form->radius[side] * radius;
        for (int t = 0; t < form->term_count; t++) {
            const struct shader_term *term = &form->terms[t];
            double value = fmax(values[term->component], term->floor);
            for (int side = 0; side < 4; side++) sides[side] += term->sides[side] * value;
        }
        for (int side = 0; side < 4; side++) out[side] = fmax(out[side], sides[side]);
    }
}

bool shader_region_holds(const struct shader_region *region, const float *values, bool hole) {
    if (!region->given) return false;
    for (int i = 0; i < region->condition_count; i++) {
        float value = values[region->conditions[i]];
        if (hole ? !(value <= 0) : !(value >= 1)) return false;
    }
    return true;
}

bool shader_open(const struct shader *shader, const float *values) {
    for (int i = 0; i < shader->gate_count; i++) {
        if (values[shader->gates[i]] > 0) return true;
    }
    return !shader->gate_count;
}

/* Decoding. */

/* Whether OBJECT has only fields among the NULL-terminated NAMES; WHAT names it. */
static bool known_fields(const struct json_value *object, const char *const *names,
                         const char *what, struct protocol_error *error) {
    for (size_t i = 0; i < object->object.count; i++) {
        const struct json_value *key = &object->object.members[i].key;
        bool known = false;
        for (const char *const *name = names; *name && !known; name++)
            known = json_is_string(key, *name);
        if (!known) return protocol_fail(error, "%s has no field \"%s\".", what, key->string.chars);
    }
    return true;
}

static bool id_ok(const struct json_value *id) {
    if (!id || id->type != JSON_STRING || id->string.length < 1 || id->string.length > ID_MAX)
        return false;
    for (size_t i = 0; i < id->string.length; i++) {
        char c = id->string.chars[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '-' || c == '.' || c == ':'))
            return false;
    }
    return true;
}

/* Four finite numbers, one per side, or one number for all four, into OUT. */
static bool decode_sides(const struct json_value *raw, double out[4], const char *what,
                         struct protocol_error *error) {
    if (raw && raw->type == JSON_NUMBER && isfinite(raw->number)) {
        for (int side = 0; side < 4; side++) out[side] = raw->number;
        return true;
    }
    if (!raw || raw->type != JSON_ARRAY || raw->array.count != 4)
        return protocol_fail(error, "%s needs a number or four: left, top, right, bottom.", what);
    for (int side = 0; side < 4; side++) {
        const struct json_value *value = &raw->array.items[side];
        if (value->type != JSON_NUMBER || !isfinite(value->number))
            return protocol_fail(error, "%s needs a number or four: left, top, right, bottom.",
                                 what);
        out[side] = value->number;
    }
    return true;
}

/* A uniform component named by {uniform, component?}. */
static bool decode_component(const struct shader *shader, const struct json_value *raw, int *out,
                             const char *what, struct protocol_error *error) {
    const struct json_value *name =
        raw && raw->type == JSON_OBJECT ? json_get(raw, "uniform") : NULL;
    int index = name && name->type == JSON_STRING
                    ? shader_uniform(shader, name->string.chars, name->string.length)
                    : -1;
    if (index < 0) return protocol_fail(error, "%s names no uniform of the shader.", what);
    int64_t component = 0;
    const struct json_value *given = json_given(raw, "component");
    if (given && !json_integer(given, 0, shader->counts[index] - 1, &component))
        return protocol_fail(error, "%s's component is outside uniform %s.", what,
                             shader->names[index]);
    *out = shader->offsets[index] + (int)component;
    return true;
}

static bool decode_form(const struct shader *shader, const struct json_value *raw,
                        struct shader_form *form, struct protocol_error *error) {
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "A bound is an object.");
    for (size_t i = 0; i < raw->object.count; i++) {
        const struct json_value *key = &raw->object.members[i].key;
        const struct json_value *value = &raw->object.members[i].value;
        if (json_is_string(key, "pad")) {
            if (!decode_sides(value, form->pad, "pad", error)) return false;
        } else if (json_is_string(key, "pixel")) {
            if (!decode_sides(value, form->pixel, "pixel", error)) return false;
        } else if (json_is_string(key, "radius")) {
            if (!decode_sides(value, form->radius, "radius", error)) return false;
        } else if (json_is_string(key, "uniforms") || json_is_string(key, "floor")) {
            if (value->type != JSON_OBJECT)
                return protocol_fail(error, "A bound's %s must be an object.", key->string.chars);
        } else {
            return protocol_fail(error, "A bound has no field \"%s\".", key->string.chars);
        }
    }
    const struct json_value *terms = json_given(raw, "uniforms");
    const struct json_value *floors = json_given(raw, "floor");
    for (size_t i = 0; floors && i < floors->object.count; i++) {
        const char *name = floors->object.members[i].key.string.chars;
        if (!terms || !json_get(terms, name))
            return protocol_fail(error, "A bound's floor names %s, which it does not use.", name);
    }
    for (size_t i = 0; terms && i < terms->object.count; i++) {
        const struct json_member *member = &terms->object.members[i];
        int index = shader_uniform(shader, member->key.string.chars, member->key.string.length);
        if (index < 0)
            return protocol_fail(error, "A bound names unknown uniform %s.",
                                 member->key.string.chars);
        int count = shader->counts[index];
        const struct json_value *rows = &member->value;
        /* One row of side coefficients per component; a float's may stand alone. */
        bool single = count == 1 && (rows->type == JSON_NUMBER ||
                                     (rows->type == JSON_ARRAY && rows->array.count == 4 &&
                                      rows->array.items[0].type == JSON_NUMBER));
        if (!single && (rows->type != JSON_ARRAY || (int)rows->array.count != count))
            return protocol_fail(error, "A bound's %s needs one row per component.",
                                 member->key.string.chars);
        const struct json_value *floor = floors ? json_get(floors, member->key.string.chars) : NULL;
        if (floor && floor->type != JSON_NUMBER)
            return protocol_fail(error, "A bound's floor is a number.");
        for (int c = 0; c < count; c++) {
            if (form->term_count == SHADER_TERMS_MAX)
                return protocol_fail(error, "A bound takes at most %d components.",
                                     SHADER_TERMS_MAX);
            struct shader_term *term = &form->terms[form->term_count++];
            term->component = shader->offsets[index] + c;
            term->floor = floor ? floor->number : -INFINITY;
            if (!decode_sides(single ? rows : &rows->array.items[c], term->sides, "A coefficient",
                              error))
                return false;
        }
    }
    return true;
}

/* A bound: one form, or an array of them standing for their largest. */
static bool decode_bound(const struct shader *shader, const struct json_value *raw,
                         struct shader_bound *bound, struct protocol_error *error) {
    *bound = (struct shader_bound){0};
    if (!raw || raw->type == JSON_NULL) return true;
    bool list = raw->type == JSON_ARRAY;
    size_t count = list ? raw->array.count : 1;
    if (count < 1 || count > SHADER_FORMS_MAX)
        return protocol_fail(error, "A bound has 1 to %d forms.", SHADER_FORMS_MAX);
    for (size_t i = 0; i < count; i++) {
        if (!decode_form(shader, list ? &raw->array.items[i] : raw, &bound->forms[i], error))
            return false;
        bound->form_count++;
    }
    return true;
}

/* One component, or a list of up to four, into OUT; none without RAW. */
static bool decode_components(const struct shader *shader, const struct json_value *raw, int *out,
                              int *count, const char *what, struct protocol_error *error) {
    *count = 0;
    if (!raw || raw->type == JSON_NULL) return true;
    bool list = raw->type == JSON_ARRAY;
    size_t length = list ? raw->array.count : 1;
    if (length > SHADER_CONDITIONS_MAX)
        return protocol_fail(error, "%s lists up to %d components.", what, SHADER_CONDITIONS_MAX);
    for (size_t i = 0; i < length; i++) {
        if (!decode_component(shader, list ? &raw->array.items[i] : raw, &out[(*count)++], what,
                              error))
            return false;
    }
    return true;
}

static bool decode_region(const struct shader *shader, const struct json_value *raw,
                          struct shader_region *region, const char *what,
                          struct protocol_error *error) {
    *region = (struct shader_region){0};
    if (!raw || raw->type == JSON_NULL) return true;
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "%s must be an object.", what);
    static const char *const fields[] = {"inset", "when", NULL};
    if (!known_fields(raw, fields, what, error)) return false;
    region->given = true;
    if (!decode_bound(shader, json_given(raw, "inset"), &region->inset, error)) return false;
    return decode_components(shader, json_given(raw, "when"), region->conditions,
                             &region->condition_count, what, error);
}

static bool decode_uniform_list(const struct json_value *raw, struct shader *shader,
                                struct protocol_error *error) {
    if (!raw || raw->type == JSON_NULL) return true;
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "uniforms must be an object.");
    if (raw->object.count > UNIFORMS_MAX)
        return protocol_fail(error, "At most %d uniforms per shader.", UNIFORMS_MAX);
    for (size_t i = 0; i < raw->object.count; i++) {
        const struct json_member *member = &raw->object.members[i];
        const char *name = member->key.string.chars;
        size_t length = member->key.string.length;
        if (!uniform_name_ok(name, length))
            return protocol_fail(error, "\"%s\" is not a usable uniform name.", name);
        if (shader_uniform(shader, name, length) >= 0)
            return protocol_fail(error, "Uniform %s is declared twice.", name);
        int64_t count;
        if (!json_integer(&member->value, 1, 4, &count) || count == 3)
            return protocol_fail(error, "Uniform %s takes 1, 2 or 4 numbers.", name);
        int index = shader->uniform_count++;
        memcpy(shader->names[index], name, length + 1);
        shader->counts[index] = (int)count;
        shader->offsets[index] = shader->component_count;
        shader->component_count += (int)count;
    }
    return true;
}

/* READS: {time?, pointer?, local?, backdrop?: true or {blur: uniform}}. */
static bool decode_reads(const struct json_value *raw, struct shader *shader,
                         struct protocol_error *error) {
    shader->backdrop_blur = -1;
    if (!raw || raw->type == JSON_NULL) return true;
    if (raw->type != JSON_OBJECT) return protocol_fail(error, "reads must be an object.");
    for (size_t i = 0; i < raw->object.count; i++) {
        const struct json_value *key = &raw->object.members[i].key;
        const struct json_value *value = &raw->object.members[i].value;
        bool flag = value->type == JSON_TRUE;
        if (!json_is_string(key, "backdrop") && !flag && value->type != JSON_FALSE)
            return protocol_fail(error, "reads.%s is true or false.", key->string.chars);
        if (json_is_string(key, "time")) {
            shader->time = flag;
        } else if (json_is_string(key, "pointer")) {
            shader->pointer = flag;
        } else if (json_is_string(key, "local")) {
            shader->local = flag;
        } else if (json_is_string(key, "backdrop")) {
            if (value->type == JSON_OBJECT) {
                shader->backdrop = true;
                const struct json_value *blur = json_get(value, "blur");
                int index = blur && blur->type == JSON_STRING
                                ? shader_uniform(shader, blur->string.chars, blur->string.length)
                                : -1;
                if (index < 0 || shader->counts[index] != 1)
                    return protocol_fail(error, "reads.backdrop.blur names a float uniform.");
                shader->backdrop_blur = shader->offsets[index];
            } else {
                shader->backdrop = flag;
            }
        } else {
            return protocol_fail(error, "A shader reads no \"%s\".", key->string.chars);
        }
    }
    if (shader->stage == STAGE_FILTER && shader->backdrop)
        return protocol_fail(error, "A filter cannot read the backdrop.");
    if (shader->stage == STAGE_EFFECT && shader->backdrop_blur >= 0)
        return protocol_fail(error, "An effect reads the backdrop as it is.");
    if (shader->local && shader->stage != STAGE_EFFECT)
        return protocol_fail(error, "Only an effect reads locally.");
    return true;
}

static bool same_bound(const struct shader_bound *a, const struct shader_bound *b) {
    return a->form_count == b->form_count &&
           !memcmp(a->forms, b->forms, a->form_count * sizeof a->forms[0]);
}

static bool same_region(const struct shader_region *a, const struct shader_region *b) {
    return a->given == b->given && same_bound(&a->inset, &b->inset) &&
           a->condition_count == b->condition_count &&
           !memcmp(a->conditions, b->conditions, a->condition_count * sizeof a->conditions[0]);
}

static bool same_shader(const struct shader *a, const struct shader *b) {
    if (a->stage != b->stage || strcmp(a->source, b->source) ||
        a->uniform_count != b->uniform_count || a->gate_count != b->gate_count ||
        memcmp(a->gates, b->gates, a->gate_count * sizeof a->gates[0]) || a->time != b->time ||
        a->pointer != b->pointer || a->backdrop != b->backdrop || a->local != b->local ||
        a->backdrop_blur != b->backdrop_blur || !same_bound(&a->extent, &b->extent) ||
        !same_region(&a->opaque, &b->opaque) || !same_region(&a->hole, &b->hole))
        return false;
    for (int i = 0; i < a->uniform_count; i++) {
        if (strcmp(a->names[i], b->names[i]) || a->counts[i] != b->counts[i]) return false;
    }
    return true;
}

static bool decode_definition(const struct json_value *op, struct shader *shader,
                              struct protocol_error *error) {
    static const char *const fields[] = {"op",     "id",     "stage", "source", "uniforms", "reads",
                                         "extent", "opaque", "hole",  "gate",   NULL};
    if (!known_fields(op, fields, "A shader", error)) return false;
    const struct json_value *stage = json_get(op, "stage");
    if (json_is_string(stage, "paint")) shader->stage = STAGE_PAINT;
    else if (json_is_string(stage, "filter")) shader->stage = STAGE_FILTER;
    else if (json_is_string(stage, "effect")) shader->stage = STAGE_EFFECT;
    else return protocol_fail(error, "A shader's stage is \"paint\", \"filter\" or \"effect\".");
    if (!decode_uniform_list(json_given(op, "uniforms"), shader, error) ||
        !decode_reads(json_given(op, "reads"), shader, error) ||
        !decode_bound(shader, json_given(op, "extent"), &shader->extent, error) ||
        !decode_region(shader, json_given(op, "opaque"), &shader->opaque, "opaque", error) ||
        !decode_region(shader, json_given(op, "hole"), &shader->hole, "hole", error))
        return false;
    if (shader->stage == STAGE_EFFECT && shader->opaque.given)
        return protocol_fail(error, "An effect has no opaque region.");
    if (shader->stage != STAGE_PAINT && shader->hole.given)
        return protocol_fail(error, "Only a paint has a hole.");
    if (shader->stage == STAGE_FILTER && shader->opaque.inset.form_count)
        return protocol_fail(error, "A filter's opaque region is its node's: it takes no inset.");
    if (shader->stage == STAGE_FILTER && shader->extent.form_count)
        return protocol_fail(error, "A filter draws only where its node does.");
    return decode_components(shader, json_given(op, "gate"), shader->gates, &shader->gate_count,
                             "gate", error);
}

bool shaders_define(struct shaders *shaders, const struct json_value *op, struct shader **out,
                    struct protocol_error *error) {
    const struct json_value *id = json_get(op, "id");
    if (!id_ok(id))
        return protocol_fail(error, "A shader id is 1 to %d letters, digits or _-.:", ID_MAX);
    const struct json_value *source = json_get(op, "source");
    if (!source || source->type != JSON_STRING)
        return protocol_fail(error, "Shader %s needs its source.", id->string.chars);
    if (source->string.length > SOURCE_MAX)
        return protocol_fail(error, "Shader %s exceeds 64 KiB.", id->string.chars);
    struct shader *shader = xcalloc(1, sizeof *shader);
    if (!decode_definition(op, shader, error)) {
        shader_free(shader);
        return false;
    }
    shader->id = xstrndup(id->string.chars, id->string.length);
    shader->source = xstrndup(source->string.chars, source->string.length);
    struct shader *existing = shaders_find(shaders, id->string.chars, id->string.length);
    if (existing) {
        bool same = same_shader(existing, shader);
        shader_free(shader);
        if (!same)
            return protocol_fail(error, "Shader %s is already defined otherwise.",
                                 id->string.chars);
        *out = existing;
        return true;
    }
    *(struct shader **)vec_push(&shaders->list) = shader;
    *out = shader;
    return true;
}
