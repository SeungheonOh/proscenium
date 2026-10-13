#include "props.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>

#include "util.h"

static const char *const BACKFACES[] = {"visible", "hidden", NULL};
static const char *const GESTURES[] = {"swipe", "pinch", "hold", NULL};
static const char *const ACTIONS[] = {"none", "move", "resize", "pan", "zoom", NULL};
static const char *const ALIGNS[] = {"start", "center", "end", NULL};
static const char *const FITS[] = {"fill", "contain", "cover", NULL};
static const char *const CURSORS[CURSOR_COUNT + 1] = {
    "none",      "default",     "pointer",     "text",        "crosshair", "move",    "grab",
    "grabbing",  "not-allowed", "help",        "wait",        "progress",  "zoom-in", "zoom-out",
    "ew-resize", "ns-resize",   "nwse-resize", "nesw-resize", NULL,
};

const char *const MODIFIER_NAMES[MODIFIER_COUNT] = {"shift", "control", "alt", "logo"};

const char *const EVENT_NAMES[EVENT_COUNT] = {
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointerenter",
    "pointerleave",
    "wheel",
    "press",
    "release",
    "down",
    "move",
    "up",
    "begin",
    "update",
    "end",
    "moverequest",
    "resizerequest",
    "fullscreenrequest",
    "maximizerequest",
    "minimizerequest",
    "activaterequest",
    "dragstart",
    "drag",
    "dragend",
    "resizestart",
    "resize",
    "resizeend",
    "measure",
    "load",
    "error",
    "message",
};

#define NUMBER(v) .has_default = true, .fallback = {.number = (v)}
#define BOOLEAN(v) .has_default = true, .fallback = {.boolean = (v)}
#define CHOICE(v, list) .has_default = true, .fallback = {.choice = (v)}, .choices = (list)
#define COLOR0 .has_default = true, .fallback = {.color = {0, 0, 0, 0}}
#define ANIMATED(t) .animated = true, .tolerance = (t)

const struct prop_spec PROP_SPECS[PROP_COUNT] = {
    [PROP_X] = {"x", TYPE_NUMBER, ANIMATED(1e-2), NUMBER(0)},
    [PROP_Y] = {"y", TYPE_NUMBER, ANIMATED(1e-2), NUMBER(0)},
    [PROP_WIDTH] = {"width", TYPE_NUMBER, ANIMATED(1e-2)},
    [PROP_HEIGHT] = {"height", TYPE_NUMBER, ANIMATED(1e-2)},
    [PROP_TRANSFORM] = {"transform", TYPE_TRANSFORM, ANIMATED(1e-3), .has_default = true},
    [PROP_ROTATION] = {"rotation", TYPE_NUMBER, ANIMATED(1e-3), NUMBER(0)},
    [PROP_OPACITY] = {"opacity", TYPE_NUMBER, ANIMATED(1e-3), NUMBER(1)},
    [PROP_ORIGIN_X] = {"originX", TYPE_NUMBER, NUMBER(0.5)},
    [PROP_ORIGIN_Y] = {"originY", TYPE_NUMBER, NUMBER(0.5)},
    [PROP_VISIBLE] = {"visible", TYPE_BOOLEAN, BOOLEAN(true)},
    [PROP_BACKFACE] = {"backface", TYPE_CHOICE, CHOICE(BACKFACE_VISIBLE, BACKFACES)},
    [PROP_COLOR] = {"color", TYPE_COLOR, ANIMATED(1e-3), COLOR0},
    [PROP_RADIUS] = {"radius", TYPE_NUMBER, ANIMATED(1e-2), NUMBER(0)},
    [PROP_CLIP] = {"clip", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_WINDOW] = {"window", TYPE_ID},
    [PROP_FULLSCREEN] = {"fullscreen", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_MAXIMIZED] = {"maximized", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_TILED] = {"tiled", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_FOCUSABLE] = {"focusable", TYPE_BOOLEAN, BOOLEAN(true)},
    [PROP_INTERACTIVE] = {"interactive", TYPE_BOOLEAN, BOOLEAN(true)},
    [PROP_MOVABLE] = {"movable", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_RESIZABLE] = {"resizable", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_DRAGGABLE] = {"draggable", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_PAN] = {"pan", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_OUTPUT] = {"output", TYPE_STRING},
    [PROP_ZOOM] = {"zoom", TYPE_NUMBER, ANIMATED(1e-4), .logarithmic = true, NUMBER(1)},
    [PROP_MIN_ZOOM] = {"minZoom", TYPE_NUMBER, NUMBER(0.05)},
    [PROP_MAX_ZOOM] = {"maxZoom", TYPE_NUMBER, NUMBER(8)},
    [PROP_KEY] = {"key", TYPE_STRING},
    [PROP_MODIFIERS] = {"modifiers", TYPE_MODIFIERS, .has_default = true},
    [PROP_REPEAT] = {"repeat", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_BUTTON] = {"button", TYPE_ID, .has_default = true, .fallback = {.id = 272}},
    [PROP_GESTURE] = {"gesture", TYPE_CHOICE, CHOICE(GESTURE_SWIPE, GESTURES)},
    [PROP_FINGERS] = {"fingers", TYPE_ID, .has_default = true, .fallback = {.id = 3}},
    [PROP_ACTION] = {"action", TYPE_CHOICE, CHOICE(ACTION_NONE, ACTIONS)},
    [PROP_TEXT] = {"text", TYPE_STRING},
    [PROP_MARKUP] = {"markup", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_FONT] = {"font", TYPE_STRING},
    [PROP_FONT_SIZE] = {"fontSize", TYPE_NUMBER, NUMBER(14)},
    [PROP_FONT_WEIGHT] = {"fontWeight", TYPE_NUMBER, NUMBER(400)},
    [PROP_ITALIC] = {"italic", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_ALIGN] = {"align", TYPE_CHOICE, CHOICE(ALIGN_START, ALIGNS)},
    [PROP_LINE_HEIGHT] = {"lineHeight", TYPE_NUMBER},
    [PROP_MAX_LINES] = {"maxLines", TYPE_ID},
    [PROP_SRC] = {"src", TYPE_STRING},
    [PROP_FIT] = {"fit", TYPE_CHOICE, CHOICE(FIT_FILL, FITS)},
    [PROP_DATA] = {"data", TYPE_STRING},
    [PROP_REVISION] = {"revision", TYPE_NUMBER},
    [PROP_AUTO_FOCUS] = {"autoFocus", TYPE_BOOLEAN, BOOLEAN(false)},
    [PROP_TOP] = {"top", TYPE_NUMBER, NUMBER(0)},
    [PROP_RIGHT] = {"right", TYPE_NUMBER, NUMBER(0)},
    [PROP_BOTTOM] = {"bottom", TYPE_NUMBER, NUMBER(0)},
    [PROP_LEFT] = {"left", TYPE_NUMBER, NUMBER(0)},
    /* No default: a node without a cursor shows its parent's. */
    [PROP_CURSOR] = {"cursor", TYPE_CHOICE, .choices = CURSORS},
};

#define TRANSFORM_PROPS                                                                            \
    PROP_X, PROP_Y, PROP_TRANSFORM, PROP_OPACITY, PROP_ORIGIN_X, PROP_ORIGIN_Y, PROP_VISIBLE,      \
        PROP_BACKFACE
#define BOX_PROPS PROP_WIDTH, PROP_HEIGHT, PROP_RADIUS
#define END PROP_COUNT

struct kind_row {
    const char *name;
    const enum prop_key props[48];
};

static const struct kind_row KINDS[KIND_COUNT] = {
    [KIND_ROOT] = {"root", {END}},
    [KIND_GROUP] = {"group",
                    {TRANSFORM_PROPS, BOX_PROPS, PROP_CLIP, PROP_DRAGGABLE, PROP_INTERACTIVE,
                     PROP_CURSOR, END}},
    [KIND_TEXT] = {"text",
                   {TRANSFORM_PROPS, PROP_WIDTH, PROP_TEXT, PROP_MARKUP, PROP_FONT, PROP_FONT_SIZE,
                    PROP_FONT_WEIGHT, PROP_ITALIC, PROP_COLOR, PROP_ALIGN, PROP_LINE_HEIGHT,
                    PROP_MAX_LINES, PROP_DRAGGABLE, PROP_INTERACTIVE, PROP_CURSOR, END}},
    [KIND_IMAGE] = {"image",
                    {TRANSFORM_PROPS, BOX_PROPS, PROP_SRC, PROP_FIT, PROP_DRAGGABLE,
                     PROP_INTERACTIVE, PROP_CURSOR, END}},
    [KIND_WEB] = {"web",
                  {TRANSFORM_PROPS, BOX_PROPS, PROP_SRC, PROP_DATA, PROP_REVISION, PROP_FOCUSABLE,
                   PROP_INTERACTIVE, PROP_AUTO_FOCUS, PROP_CURSOR, END}},
    [KIND_WINDOW] = {"window",
                     {TRANSFORM_PROPS, BOX_PROPS, PROP_WINDOW, PROP_FULLSCREEN, PROP_MAXIMIZED,
                      PROP_TILED, PROP_FOCUSABLE, PROP_INTERACTIVE, PROP_MOVABLE, PROP_RESIZABLE,
                      END}},
    [KIND_BACKGROUND] = {"background",
                         {PROP_X, PROP_Y, PROP_TRANSFORM, PROP_OPACITY, PROP_VISIBLE, PROP_BACKFACE,
                          PROP_PAN, PROP_CURSOR, END}},
    [KIND_CAMERA] = {"camera",
                     {PROP_OUTPUT, PROP_X, PROP_Y, PROP_ZOOM, PROP_ROTATION, PROP_MIN_ZOOM,
                      PROP_MAX_ZOOM, END}},
    [KIND_SCREEN] = {"screen",
                     {PROP_OUTPUT, PROP_X, PROP_Y, PROP_TRANSFORM, PROP_OPACITY, PROP_VISIBLE,
                      PROP_BACKFACE, END}},
    [KIND_RESERVE] = {"reserve", {PROP_OUTPUT, PROP_TOP, PROP_RIGHT, PROP_BOTTOM, PROP_LEFT, END}},
    [KIND_SHORTCUT] = {"shortcut", {PROP_KEY, PROP_MODIFIERS, PROP_REPEAT, END}},
    [KIND_POINTER_BINDING] = {"pointer-binding", {PROP_BUTTON, PROP_MODIFIERS, PROP_ACTION, END}},
    [KIND_WHEEL_BINDING] = {"wheel-binding", {PROP_MODIFIERS, PROP_ACTION, END}},
    [KIND_GESTURE_BINDING] = {"gesture-binding",
                              {PROP_GESTURE, PROP_FINGERS, PROP_MODIFIERS, PROP_ACTION, END}},
};

static bool kind_props[KIND_COUNT][PROP_COUNT];
static bool kind_props_ready;

static void index_kinds(void) {
    for (int kind = 0; kind < KIND_COUNT; kind++) {
        for (const enum prop_key *key = KINDS[kind].props; *key != END; key++)
            kind_props[kind][*key] = true;
    }
    kind_props_ready = true;
}

const char *kind_name(enum node_kind kind) {
    return KINDS[kind].name;
}

enum node_kind kind_from_name(const char *name, size_t length) {
    for (int kind = KIND_GROUP; kind < KIND_COUNT; kind++) {
        if (strlen(KINDS[kind].name) == length && !memcmp(KINDS[kind].name, name, length))
            return kind;
    }
    return KIND_COUNT;
}

bool kind_has_prop(enum node_kind kind, enum prop_key key) {
    if (!kind_props_ready) index_kinds();
    return kind_props[kind][key];
}

bool kind_has_shaders(enum node_kind kind) {
    switch (kind) {
    case KIND_GROUP:
    case KIND_TEXT:
    case KIND_IMAGE:
    case KIND_WEB:
    case KIND_WINDOW:
    case KIND_BACKGROUND: return true;
    default: return false;
    }
}

bool kind_animates(enum node_kind kind) {
    return kind != KIND_CAMERA;
}

enum prop_key prop_from_name(const char *name, size_t length) {
    for (int key = 0; key < PROP_COUNT; key++) {
        const char *candidate = PROP_SPECS[key].name;
        if (strlen(candidate) == length && !memcmp(candidate, name, length)) return key;
    }
    return PROP_COUNT;
}

enum event_name event_from_name(const char *name, size_t length) {
    for (int event = 0; event < EVENT_COUNT; event++) {
        if (strlen(EVENT_NAMES[event]) == length && !memcmp(EVENT_NAMES[event], name, length))
            return event;
    }
    return EVENT_COUNT;
}

bool protocol_fail(struct protocol_error *error, const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(error->message, sizeof error->message, format, arguments);
    va_end(arguments);
    return false;
}

/* Transform functions. */

static const struct {
    const char *name;
    int arity;
    double tolerance;
} TFUNCS[] = {
    [TF_TRANSLATE] = {"translate", 3, 1e-2},     [TF_SCALE] = {"scale", 3, 1e-4},
    [TF_ROTATE] = {"rotate", 4, 1e-4},           [TF_SKEW] = {"skew", 2, 1e-4},
    [TF_PERSPECTIVE] = {"perspective", 1, 1e-7}, [TF_MATRIX] = {"matrix", 16, 1e-4},
};

int tfunc_arity(enum tfunc kind) {
    return TFUNCS[kind].arity;
}

void tlist_finish(struct tlist *list) {
    free(list->parameters);
    *list = (struct tlist){0};
}

void tlist_set(struct tlist *out, int count, const uint8_t *kinds, const double *parameters) {
    int parameter_count = 0;
    for (int i = 0; i < count; i++) parameter_count += tfunc_arity(kinds[i]);
    double *copy = parameter_count ? xmalloc(parameter_count * sizeof *copy) : NULL;
    if (parameter_count) memcpy(copy, parameters, parameter_count * sizeof *copy);
    free(out->parameters);
    out->count = count;
    memcpy(out->kinds, kinds, count);
    out->parameter_count = parameter_count;
    out->parameters = copy;
}

void tlist_copy(struct tlist *out, const struct tlist *list) {
    *out = (struct tlist){0};
    tlist_set(out, list->count, list->kinds, list->parameters);
}

static struct mat4 function_matrix(enum tfunc kind, const double *p) {
    switch (kind) {
    case TF_TRANSLATE: return mat4_translation(p[0], p[1], p[2]);
    case TF_SCALE: return (struct mat4){{p[0], 0, 0, 0, 0, p[1], 0, 0, 0, 0, p[2], 0, 0, 0, 0, 1}};
    case TF_ROTATE: {
        double x = p[0], y = p[1], z = p[2];
        double length = sqrt(x * x + y * y + z * z);
        if (length < 1e-12) return MAT4_IDENTITY;
        x /= length, y /= length, z /= length;
        double cosine = cos(p[3]), sine = sin(p[3]), turn = 1 - cosine;
        /* Rodrigues' rotation about the unit axis; clockwise on screen about z, as y points down.
         */
        return (struct mat4){{turn * x * x + cosine, turn * x * y - sine * z,
                              turn * x * z + sine * y, 0, turn * x * y + sine * z,
                              turn * y * y + cosine, turn * y * z - sine * x, 0,
                              turn * x * z - sine * y, turn * y * z + sine * x,
                              turn * z * z + cosine, 0, 0, 0, 0, 1}};
    }
    case TF_SKEW:
        return (struct mat4){{1, tan(p[0]), 0, 0, tan(p[1]), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};
    case TF_PERSPECTIVE:
        /* The viewer sits on the z axis, which points toward them. */
        return (struct mat4){{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -p[0], 1}};
    case TF_MATRIX: {
        struct mat4 matrix;
        memcpy(matrix.m, p, sizeof matrix.m);
        return matrix;
    }
    }
    return MAT4_IDENTITY;
}

struct mat4 tlist_matrix(const struct tlist *list) {
    struct mat4 matrix = MAT4_IDENTITY;
    int start = 0;
    for (int i = 0; i < list->count; i++) {
        struct mat4 function = function_matrix(list->kinds[i], list->parameters + start);
        matrix = mat4_multiply(&matrix, &function);
        start += tfunc_arity(list->kinds[i]);
    }
    return matrix;
}

void tlist_append(struct tlist *out, const struct tlist *first, const struct tlist *second) {
    int count = MIN(first->count + second->count, TLIST_MAX);
    uint8_t kinds[TLIST_MAX * 2];
    memcpy(kinds, first->kinds, first->count);
    memcpy(kinds + first->count, second->kinds, second->count);
    double parameters[TLIST_MAX * 2 * 16];
    memcpy(parameters, first->parameters, first->parameter_count * sizeof *parameters);
    memcpy(parameters + first->parameter_count, second->parameters,
           second->parameter_count * sizeof *parameters);
    struct tlist result = {0};
    tlist_set(&result, count, kinds, parameters);
    tlist_finish(out);
    *out = result;
}

bool tlist_shape(const struct tlist *first, const struct tlist *second, int *count,
                 uint8_t *kinds) {
    const struct tlist *longer = first->count >= second->count ? first : second;
    const struct tlist *shorter = longer == first ? second : first;
    if (memcmp(longer->kinds, shorter->kinds, shorter->count)) return false;
    *count = longer->count;
    memcpy(kinds, longer->kinds, longer->count);
    return true;
}

/* Parameters making a KIND function do nothing; a rotation keeps LIKE's axis. */
static void identity_parameters(enum tfunc kind, const double *like, double *out) {
    switch (kind) {
    case TF_TRANSLATE:
    case TF_SKEW:
    case TF_PERSPECTIVE: memset(out, 0, tfunc_arity(kind) * sizeof *out); break;
    case TF_SCALE: out[0] = out[1] = out[2] = 1; break;
    case TF_ROTATE:
        if (like) {
            out[0] = like[0], out[1] = like[1], out[2] = like[2];
        } else {
            out[0] = 0, out[1] = 0, out[2] = 1;
        }
        out[3] = 0;
        break;
    case TF_MATRIX: memcpy(out, MAT4_IDENTITY.m, sizeof MAT4_IDENTITY.m); break;
    }
}

void tlist_pad(struct tlist *out, const struct tlist *list, int count, const uint8_t *kinds,
               const struct tlist *like) {
    double parameters[TLIST_MAX * 16];
    memcpy(parameters, list->parameters, list->parameter_count * sizeof *parameters);
    int start = list->parameter_count;
    for (int i = list->count; i < count; i++) {
        const double *axis = like ? like->parameters + start : NULL;
        identity_parameters(kinds[i], axis, parameters + start);
        start += tfunc_arity(kinds[i]);
    }
    *out = (struct tlist){0};
    tlist_set(out, count, kinds, parameters);
}

void tlist_tolerances(int count, const uint8_t *kinds, double *tolerances) {
    int index = 0;
    for (int i = 0; i < count; i++) {
        for (int j = 0; j < tfunc_arity(kinds[i]); j++)
            tolerances[index++] = TFUNCS[kinds[i]].tolerance;
    }
}

/* Values. */

void prop_value_finish(enum prop_key key, struct prop_value *value) {
    switch (PROP_SPECS[key].type) {
    case TYPE_STRING: free(value->string); break;
    case TYPE_TRANSFORM: tlist_finish(&value->transform); break;
    default: break;
    }
    *value = (struct prop_value){0};
}

void prop_value_copy(enum prop_key key, struct prop_value *out, const struct prop_value *value) {
    *out = *value;
    switch (PROP_SPECS[key].type) {
    case TYPE_STRING:
        if (value->string) out->string = xstrdup(value->string);
        break;
    case TYPE_TRANSFORM: tlist_copy(&out->transform, &value->transform); break;
    default: break;
    }
}

static bool finite_number(const struct json_value *raw, const char *name, double *out,
                          struct protocol_error *error) {
    if (!raw || raw->type != JSON_NUMBER || !(fabs(raw->number) < 1e12))
        return protocol_fail(error, "Property %s requires a finite number.", name);
    *out = raw->number;
    return true;
}

static bool decode_transform(const struct json_value *raw, const char *name, struct tlist *out,
                             struct protocol_error *error) {
    if (raw->type != JSON_ARRAY)
        return protocol_fail(error, "Property %s requires an array.", name);
    if (raw->array.count > TLIST_MAX)
        return protocol_fail(error, "At most 32 transform functions.");
    uint8_t kinds[TLIST_MAX];
    double parameters[TLIST_MAX * 16];
    int parameter_count = 0;
    for (size_t i = 0; i < raw->array.count; i++) {
        const struct json_value *entry = &raw->array.items[i];
        if (entry->type != JSON_ARRAY || entry->array.count == 0 ||
            entry->array.items[0].type != JSON_STRING)
            return protocol_fail(error, "Property %s requires an array.", name);
        const struct json_value *function = &entry->array.items[0];
        int kind = -1;
        for (size_t k = 0; k < ARRAY_LENGTH(TFUNCS); k++) {
            if (json_is_string(function, TFUNCS[k].name)) kind = (int)k;
        }
        int given = (int)entry->array.count - 1;
        if (kind < 0 || given != TFUNCS[kind].arity)
            return protocol_fail(error, "\"%s\" is not a transform function with %d numbers.",
                                 function->string.chars, given);
        double numbers[16];
        for (int n = 0; n < given; n++) {
            if (!finite_number(&entry->array.items[n + 1], name, &numbers[n], error)) return false;
        }
        kinds[i] = (uint8_t)kind;
        double *place = parameters + parameter_count;
        if (kind == TF_PERSPECTIVE) {
            place[0] = numbers[0] > 0 ? 1 / numbers[0] : 0;
        } else if (kind == TF_MATRIX) {
            /* Column by column on the wire, as CSS matrix3d() writes it. */
            for (int index = 0; index < 16; index++)
                place[index] = numbers[4 * (index % 4) + index / 4];
        } else {
            memcpy(place, numbers, given * sizeof *numbers);
        }
        parameter_count += TFUNCS[kind].arity;
    }
    *out = (struct tlist){0};
    tlist_set(out, (int)raw->array.count, kinds, parameters);
    return true;
}

/* Wire modifier names to a bitmask. */
static bool decode_modifiers(const struct json_value *raw, uint32_t *out,
                             struct protocol_error *error) {
    if (raw->type != JSON_ARRAY)
        return protocol_fail(error, "Property modifiers requires an array.");
    uint32_t modifiers = 0;
    for (size_t i = 0; i < raw->array.count; i++) {
        int found = -1;
        for (int n = 0; n < MODIFIER_COUNT; n++) {
            if (json_is_string(&raw->array.items[i], MODIFIER_NAMES[n])) found = n;
        }
        if (found < 0) return protocol_fail(error, "Unknown modifier.");
        modifiers |= 1u << found;
    }
    *out = modifiers;
    return true;
}

bool prop_decode(enum prop_key key, const struct json_value *raw, struct prop_value *out,
                 struct protocol_error *error) {
    const struct prop_spec *spec = &PROP_SPECS[key];
    *out = (struct prop_value){0};
    if (!raw || raw->type == JSON_NULL) return true;
    out->given = true;
    switch (spec->type) {
    case TYPE_NUMBER:
        if (!finite_number(raw, spec->name, &out->number, error)) return false;
        if (spec->logarithmic && !(out->number > 0))
            return protocol_fail(error, "Property %s must be positive.", spec->name);
        return true;
    case TYPE_COLOR:
        if (raw->type != JSON_ARRAY || raw->array.count != 4)
            return protocol_fail(error, "Property %s requires [r, g, b, a].", spec->name);
        for (int i = 0; i < 4; i++) {
            double component;
            if (!finite_number(&raw->array.items[i], spec->name, &component, error)) return false;
            out->color[i] = CLAMP(component, 0.0, 1.0);
        }
        return true;
    case TYPE_TRANSFORM: return decode_transform(raw, spec->name, &out->transform, error);
    case TYPE_BOOLEAN:
        if (raw->type != JSON_TRUE && raw->type != JSON_FALSE)
            return protocol_fail(error, "Property %s requires a boolean.", spec->name);
        out->boolean = raw->type == JSON_TRUE;
        return true;
    case TYPE_STRING:
        if (raw->type != JSON_STRING)
            return protocol_fail(error, "Property %s requires a string.", spec->name);
        out->string = xstrndup(raw->string.chars, raw->string.length);
        return true;
    case TYPE_ID:
        if (!json_integer(raw, 0, (int64_t)1 << 53, &out->id))
            return protocol_fail(error, "Property %s requires a non-negative integer.", spec->name);
        return true;
    case TYPE_CHOICE:
        for (int i = 0; raw->type == JSON_STRING && spec->choices[i]; i++) {
            if (json_is_string(raw, spec->choices[i])) {
                out->choice = i;
                return true;
            }
        }
        return protocol_fail(error, "Property %s has an unknown value.", spec->name);
    case TYPE_MODIFIERS: return decode_modifiers(raw, &out->modifiers, error);
    }
    return false;
}

bool decode_field(const struct json_value *object, const char *name, double fallback, bool positive,
                  double *out, struct protocol_error *error) {
    const struct json_value *raw = json_given(object, name);
    if (!raw) {
        *out = fallback;
        return true;
    }
    double number;
    if (!finite_number(raw, name, &number, error)) return false;
    if (number < 0 || (positive && number == 0))
        return protocol_fail(error, "Field %s is out of range.", name);
    *out = number;
    return true;
}

bool decode_ease(const struct json_value *raw, bool *eased, double ease[4],
                 struct protocol_error *error) {
    *eased = false;
    if (!raw || raw->type == JSON_NULL) return true;
    if (raw->type != JSON_ARRAY || raw->array.count != 4)
        return protocol_fail(error, "An ease must be a CSS cubic-bezier.");
    for (int i = 0; i < 4; i++) {
        if (!finite_number(&raw->array.items[i], "ease", &ease[i], error)) return false;
    }
    if (ease[0] < 0 || ease[0] > 1 || ease[2] < 0 || ease[2] > 1)
        return protocol_fail(error, "An ease must be a CSS cubic-bezier.");
    *eased = true;
    return true;
}

static bool decode_repeat(const struct json_value *raw, int *out, struct protocol_error *error) {
    int64_t count;
    if (!raw || raw->type == JSON_NULL) *out = 0;
    else if (json_is_string(raw, "forever")) *out = MOTION_FOREVER;
    else if (json_integer(raw, 0, 10000, &count)) *out = (int)count;
    else return protocol_fail(error, "repeat must be a count or \"forever\".");
    return true;
}

struct motion *decode_motion(const struct json_value *raw, struct protocol_error *error) {
    if (!raw || raw->type != JSON_OBJECT) {
        protocol_fail(error, "A transition must be an object.");
        return NULL;
    }
    const struct json_value *type = json_get(raw, "type");
    struct motion *motion = NULL;
    bool ok = true;
    if (json_is_string(type, "spring")) {
        motion = motion_create(MOTION_SPRING);
        ok = decode_field(raw, "stiffness", 170, true, &motion->stiffness, error) &&
             decode_field(raw, "damping", 26, true, &motion->damping, error) &&
             decode_field(raw, "mass", 1, true, &motion->mass, error) &&
             decode_field(raw, "delay", 0, false, &motion->delay, error);
    } else if (json_is_string(type, "tween")) {
        motion = motion_create(MOTION_TWEEN);
        ok = decode_field(raw, "duration", 0.25, true, &motion->duration, error) &&
             decode_ease(json_get(raw, "ease"), &motion->eased, motion->ease, error) &&
             decode_field(raw, "delay", 0, false, &motion->delay, error) &&
             decode_repeat(json_get(raw, "repeat"), &motion->repeat, error);
    } else if (json_is_string(type, "curve")) {
        motion = motion_create(MOTION_CURVE);
        const struct json_value *points = json_get(raw, "points");
        ok = decode_field(raw, "duration", 0.25, true, &motion->duration, error) &&
             decode_field(raw, "delay", 0, false, &motion->delay, error) &&
             decode_repeat(json_get(raw, "repeat"), &motion->repeat, error);
        if (ok && (!points || points->type != JSON_ARRAY || points->array.count < 2 ||
                   points->array.count > 1024))
            ok = protocol_fail(error, "points needs 2 to 1024 entries.");
        if (ok) {
            motion->point_count = (int)points->array.count;
            motion->points = xmalloc(motion->point_count * sizeof *motion->points);
            for (int i = 0; ok && i < motion->point_count; i++)
                ok = finite_number(&points->array.items[i], "points", &motion->points[i], error);
        }
    } else if (json_is_string(type, "instant")) {
        motion = motion_create(MOTION_INSTANT);
    } else {
        protocol_fail(error, "Unknown transition type.");
        return NULL;
    }
    if (!ok) {
        motion_unref(motion);
        return NULL;
    }
    return motion;
}
