/*
 * Shaders the director registers once by id and nodes then use (see
 * docs/SHADERS.md). Every look the scene has beyond its content comes from one:
 *
 *   paint   draws over a node's box, or a background's plane, under or over its
 *           content: fills, borders, shadows, frosted glass, grids;
 *   filter  recolors a node's own textures pixel by pixel as they are drawn;
 *   effect  draws the node through a shader that reads it as drawn, offscreen.
 *
 * A definition holds the source, its uniforms, what it reads, and how its values
 * bound what it draws, so the compositor keeps damage, occlusion and culling as
 * tight as for anything built in. Definitions never change: defining an id
 * again is accepted only with the same content.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "json.h"
#include "props.h"
#include "util.h"

#define UNIFORMS_MAX 16
#define SHADER_COMPONENTS_MAX (UNIFORMS_MAX * 4)
#define SHADER_TERMS_MAX 16
#define SHADER_FORMS_MAX 4
#define SHADER_CONDITIONS_MAX 4

enum shader_stage {
    STAGE_PAINT,
    STAGE_FILTER,
    STAGE_EFFECT,
};

/* One uniform component's part in a form: its value, raised to FLOOR, times SIDES. */
struct shader_term {
    int component;
    double floor;
    double sides[4];
};

/* Four distances (left, top, right, bottom) linear in what a paint shows. */
struct shader_form {
    double pad[4];    /* local units */
    double pixel[4];  /* output pixels */
    double radius[4]; /* times the node's corner radius */
    int term_count;
    struct shader_term terms[SHADER_TERMS_MAX];
};

/* The largest of some forms, side by side; none at all is zero. */
struct shader_bound {
    int form_count;
    struct shader_form forms[SHADER_FORMS_MAX];
};

/* A box inset from the node's by INSET, which holds while every listed component
 * is at least 1 (opaque) or at most 0 (hole). */
struct shader_region {
    bool given;
    struct shader_bound inset;
    int condition_count;
    int conditions[SHADER_CONDITIONS_MAX];
};

struct shader {
    char *id;
    enum shader_stage stage;
    char *source;
    /* Uniforms in declaration order, and where each starts among the flattened values. */
    int uniform_count;
    char names[UNIFORMS_MAX][33];
    int counts[UNIFORMS_MAX];
    int offsets[UNIFORMS_MAX];
    int component_count;
    /* What it reads: its clock, the pointer, what is behind it (blurred by the
     * component BACKDROP_BLUR in local units, or not at all for -1); an effect
     * reading the node only where it draws is LOCAL. */
    bool time, pointer, backdrop, local;
    int backdrop_blur;
    /* How far it draws beyond the box, per side. */
    struct shader_bound extent;
    /* A paint covers OPAQUE with full opacity, and draws nothing inside HOLE; a filter
     * with OPAQUE keeps opaque pixels opaque. */
    struct shader_region opaque, hole;
    /* Components of which at least one must be above zero for it to show anything
     * (for a filter, to change anything); none for always. */
    int gate_count;
    int gates[SHADER_CONDITIONS_MAX];
    /* The renderer's program, made on first use. */
    void *program;
};

struct shaders {
    struct vec list; /* struct shader * */
};

/* A uniform's value by name, as `initial` and `exit` give it. */
struct uniform_value {
    char name[33];
    int count; /* 1, 2 or 4 */
    double components[4];
};

/* Whether NAME can be a shader's uniform: a GLSL identifier of at most 32 characters,
 * none of the names or prefixes the compositor's own declarations use. */
bool uniform_name_ok(const char *name, size_t length);
/*
 * A uniform's value: a number, or 1, 2 or 4 numbers, each under 1e12 in size. COUNT
 * is how many it must be, or 0 for any; how many it is goes to *OUT_COUNT.
 */
bool shader_decode_value(const struct json_value *raw, int count, double out[4], int *out_count,
                         const char *what, struct protocol_error *error);
/* Uniform values from an object of names to values, at most UNIFORMS_MAX of them. */
bool decode_uniforms(const struct json_value *raw, struct uniform_value *out, int *count,
                     struct protocol_error *error);

void shaders_init(struct shaders *shaders);
/* Free every definition, handing each program to FREE_PROGRAM unless it is NULL. */
void shaders_finish(struct shaders *shaders, void (*free_program)(void *program));
/* Apply a commit's `shader` op; the new or existing definition goes to OUT. */
bool shaders_define(struct shaders *shaders, const struct json_value *op, struct shader **out,
                    struct protocol_error *error);
/* The definition ID names, or NULL. */
struct shader *shaders_find(const struct shaders *shaders, const char *id, size_t length);
/* The index of SHADER's uniform NAME, or -1. */
int shader_uniform(const struct shader *shader, const char *name, size_t length);
/* BOUND for flattened VALUES, a corner RADIUS and PIXEL local units per output pixel. */
void shader_bound(const struct shader_bound *bound, const float *values, double radius,
                  double pixel, double out[4]);
/* Whether REGION holds for VALUES: its conditions at least 1, or at most 0 with HOLE. */
bool shader_region_holds(const struct shader_region *region, const float *values, bool hole);
/* Whether VALUES pass SHADER's gate, so it draws (or changes) anything. */
bool shader_open(const struct shader *shader, const float *values);
