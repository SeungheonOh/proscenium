#include "render.h"

#include <EGL/egl.h>
#include <math.h>
#include <wlr/util/log.h>

#include "shader.h"
#include "util.h"

/*
 * All programs share one vertex layout: homogeneous buffer position, node-local
 * position and texture coordinates. Dividing by w gives the buffer pixel, and
 * makes the local position and texture coordinates interpolate correctly under
 * perspective.
 */
static const char vertex_shader[] =
    "attribute vec3 a_position;\n"
    "attribute vec2 a_local;\n"
    "attribute vec2 a_uv;\n"
    "uniform vec2 u_viewport;\n"
    "varying vec2 v_local;\n"
    "varying vec2 v_uv;\n"
    "void main() {\n"
    "  gl_Position = vec4(a_position.xy / u_viewport * 2.0 - a_position.z, 0.0, a_position.z);\n"
    "  v_local = a_local;\n"
    "  v_uv = a_uv;\n"
    "}\n";

/*
 * Textures. Drawn small, a texture is box filtered over one output pixel's
 * footprint. Only the mask box's own corners are rounded; popups outside it are
 * untouched. A filter recolors each texel before the mask applies.
 */
static const char texture_prelude[] =
    "precision highp float;\n"
    "varying vec2 v_local;\n"
    "varying vec2 v_uv;\n"
    "uniform float u_opacity;\n"
    "uniform float u_has_alpha;\n"
    "uniform vec4 u_mask;\n"
    "uniform float u_mask_radius;\n"
    "uniform float pixel;\n"
    "uniform vec2 u_filter_x;\n"
    "uniform vec2 u_filter_y;\n"
    "uniform vec2 u_taps;\n"
    "uniform vec4 u_uv_bounds;\n"
    "float stage_box_distance(vec2 point, vec2 half_size, float radius) {\n"
    "  vec2 q = abs(point) - half_size + radius;\n"
    "  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;\n"
    "}\n"
    "vec4 stage_sample(vec2 uv) {\n"
    "  if (u_taps.x <= 1.0 && u_taps.y <= 1.0) return texture2D(u_texture, uv);\n"
    "  vec4 sum = vec4(0.0);\n"
    "  for (int y = 0; y < 6; ++y) {\n"
    "    if (float(y) >= u_taps.y) break;\n"
    "    for (int x = 0; x < 6; ++x) {\n"
    "      if (float(x) >= u_taps.x) break;\n"
    "      vec2 offset = u_filter_x * ((float(x) + 0.5) / u_taps.x - 0.5)\n"
    "                  + u_filter_y * ((float(y) + 0.5) / u_taps.y - 0.5);\n"
    "      sum += texture2D(u_texture, clamp(uv + offset, u_uv_bounds.xy, u_uv_bounds.zw));\n"
    "    }\n"
    "  }\n"
    "  return sum / (u_taps.x * u_taps.y);\n"
    "}\n";

static const char texture_main[] =
    "void main() {\n"
    "  vec4 color = stage_sample(v_uv);\n"
    "  color.a = mix(1.0, color.a, u_has_alpha);\n"
    "  STAGE_FILTER\n"
    "  float coverage = 1.0;\n"
    "  vec2 half_size = u_mask.zw * 0.5;\n"
    "  vec2 point = v_local - u_mask.xy - half_size;\n"
    "  if (u_mask_radius > 0.0 && abs(point.x) <= half_size.x && abs(point.y) <= half_size.y) {\n"
    "    float corner = min(u_mask_radius, min(half_size.x, half_size.y));\n"
    "    coverage = clamp(0.5 - stage_box_distance(point, half_size, corner) / pixel, 0.0, 1.0);\n"
    "  }\n"
    "  gl_FragColor = color * (u_opacity * coverage);\n"
    "}\n";

/*
 * Dual Kawase blur (Bjørge, "Bandwidth-Efficient Rendering", 2015): each
 * downsample halves the image, each upsample doubles it back, and the passes
 * sample between texels so a few taps give a wide, smooth kernel.
 */
#define BLUR_SAMPLING                                                                              \
    "precision highp float;\n"                                                                     \
    "varying vec2 v_uv;\n"                                                                         \
    "uniform sampler2D u_texture;\n"                                                               \
    "uniform vec2 u_offset;\n"                                                                     \
    "uniform vec4 u_bounds;\n"                                                                     \
    "vec4 at(vec2 uv) { return texture2D(u_texture, clamp(uv, u_bounds.xy, u_bounds.zw)); }\n"

static const char blur_down_fragment[] =
    BLUR_SAMPLING "void main() {\n"
                  "  vec4 sum = at(v_uv) * 4.0;\n"
                  "  sum += at(v_uv - u_offset);\n"
                  "  sum += at(v_uv + u_offset);\n"
                  "  sum += at(v_uv + vec2(u_offset.x, -u_offset.y));\n"
                  "  sum += at(v_uv - vec2(u_offset.x, -u_offset.y));\n"
                  "  gl_FragColor = sum / 8.0;\n"
                  "}\n";

static const char blur_up_fragment[] =
    BLUR_SAMPLING "void main() {\n"
                  "  vec4 sum = at(v_uv + vec2(-u_offset.x * 2.0, 0.0));\n"
                  "  sum += at(v_uv + vec2(-u_offset.x, u_offset.y)) * 2.0;\n"
                  "  sum += at(v_uv + vec2(0.0, u_offset.y * 2.0));\n"
                  "  sum += at(v_uv + vec2(u_offset.x, u_offset.y)) * 2.0;\n"
                  "  sum += at(v_uv + vec2(u_offset.x * 2.0, 0.0));\n"
                  "  sum += at(v_uv + vec2(u_offset.x, -u_offset.y)) * 2.0;\n"
                  "  sum += at(v_uv + vec2(0.0, -u_offset.y * 2.0));\n"
                  "  sum += at(v_uv + vec2(-u_offset.x, -u_offset.y)) * 2.0;\n"
                  "  gl_FragColor = sum / 12.0;\n"
                  "}\n";

/*
 * What paints and effects see. POSITION, SIZE, RADIUS, PIXEL and POINTER are in
 * the node's local units; colors are premultiplied, as the shader returns them.
 * Pixels read from a target, the effect's content or a backdrop, are found
 * through the rows of the transform to buffer pixels.
 */
static const char director_prelude[] = "precision highp float;\n"
                                       "varying vec2 v_local;\n"
                                       "uniform float u_opacity;\n"
                                       "uniform float pixel;\n";

static const char read_prelude[] =
    "uniform vec4 u_row_x;\n"
    "uniform vec4 u_row_y;\n"
    "uniform vec4 u_row_w;\n"
    "uniform vec2 u_read_offset;\n"
    "uniform vec2 u_read_size;\n"
    "uniform vec4 u_read_area;\n"
    "vec2 stage_uv(vec2 position) {\n"
    "  vec3 point = vec3(position, 1.0);\n"
    "  vec2 buffer = vec2(dot(u_row_x.xyz, point), dot(u_row_y.xyz, point))\n"
    "                / dot(u_row_w.xyz, point);\n"
    "  return clamp((buffer - u_read_offset) / u_read_size, u_read_area.xy, u_read_area.zw);\n"
    "}\n";

/* What an effect draws through while its own program builds, or failed. */
static const struct shader passthrough_effect = {
    .stage = STAGE_EFFECT,
    .source = "vec4 effect(vec2 position) { return content(position); }",
    .backdrop_blur = -1,
};

/* Seconds a frame may spend on work it could leave to later frames. */
#define SPARE_TIME 0.003
/* Seconds of drawing after which commands recorded so far go to the GPU. */
#define SUBMIT_INTERVAL 0.001
/* Pixels a surface's smaller side needs for drawing it small to be worth a mipmap. */
#define MIPMAP_MINIMUM 64
/* Effect targets come in sizes stepped by this, so a moving effect keeps reusing one. */
#define EFFECT_TARGET_STEP 256
#define MAX_BLUR_PASSES 5
/* Vertices of the most triangles one draw takes: a ring's eight. */
#define MAX_VERTICES 24

enum uniform {
    U_VIEWPORT,
    U_OPACITY,
    U_SIZE,
    U_RADIUS,
    U_PIXEL,
    U_TIME,
    U_POINTER,
    U_HAS_ALPHA,
    U_MASK,
    U_MASK_RADIUS,
    U_FILTER_X,
    U_FILTER_Y,
    U_TAPS,
    U_UV_BOUNDS,
    U_OFFSET,
    U_BOUNDS,
    U_ROW_X,
    U_ROW_Y,
    U_ROW_W,
    U_READ_OFFSET,
    U_READ_SIZE,
    U_READ_AREA,
    U_BACKDROP,
    UNIFORM_COUNT,
};

static const char *const uniform_names[UNIFORM_COUNT] = {
    [U_VIEWPORT] = "u_viewport",
    [U_OPACITY] = "u_opacity",
    [U_SIZE] = "size",
    [U_RADIUS] = "radius",
    [U_PIXEL] = "pixel",
    [U_TIME] = "time",
    [U_POINTER] = "pointer",
    [U_HAS_ALPHA] = "u_has_alpha",
    [U_MASK] = "u_mask",
    [U_MASK_RADIUS] = "u_mask_radius",
    [U_FILTER_X] = "u_filter_x",
    [U_FILTER_Y] = "u_filter_y",
    [U_TAPS] = "u_taps",
    [U_UV_BOUNDS] = "u_uv_bounds",
    [U_OFFSET] = "u_offset",
    [U_BOUNDS] = "u_bounds",
    [U_ROW_X] = "u_row_x",
    [U_ROW_Y] = "u_row_y",
    [U_ROW_W] = "u_row_w",
    [U_READ_OFFSET] = "u_read_offset",
    [U_READ_SIZE] = "u_read_size",
    [U_READ_AREA] = "u_read_area",
    [U_BACKDROP] = "u_backdrop",
};

/*
 * A linked program, the locations of the uniforms it declares (-1 for the
 * rest), and what each holds where SET has its bit: a draw sends only values
 * that changed, and many draws of one frame mostly repeat them.
 */
struct program {
    GLuint handle;
    GLint at[UNIFORM_COUNT];
    uint32_t set;
    float held[UNIFORM_COUNT][4];
};

/* A slot's cached object, kept sorted by slot. */
struct slot_entry {
    uint64_t slot;
    void *value;
};

/* A client surface's half-size copy with mip levels, for drawing it small. */
struct mipmap {
    struct render_target *target;
    /* The source and generation the copy was made from. */
    const void *source;
    uint64_t generation;
    double used;
};

/* Render targets halving in size, for blurring a WIDTH x HEIGHT buffer. */
struct blur_chain {
    int width, height, count;
    struct render_target *levels[MAX_BLUR_PASSES + 1];
    double used;
};

struct effect_target {
    int width, height, depth;
    enum render_effect_role role;
    struct render_target *target;
    double used;
};

/* A program being built: compiling and linking run on the driver's threads where it
 * has them, and nothing waits for them until the program is used. */
struct build {
    GLuint program, vertex, fragment;
};

/* A program running a director's shader, and what its own uniforms hold. */
struct shaded {
    struct program program;
    /* Building until unset; then the program, or why it failed. */
    struct build build;
    char *error;
    GLint locations[UNIFORMS_MAX];
    bool primed;
    float held[SHADER_COMPONENTS_MAX];
};

struct render_shader {
    const struct shader *shader;
    /* A paint's or effect's program; a filter's over ordinary textures, then over
     * external images, made on first use. */
    struct shaded *programs[2];
};

struct renderer {
    struct program texture, external, blur_down, blur_up;
    struct shaded *passthrough;
    /* The program in use, while a frame draws. */
    GLuint current;
    /* The driver builds programs on threads of its own (KHR_parallel_shader_compile). */
    bool parallel_compile;
    float vertices[MAX_VERTICES * 7];
    int viewport_width, viewport_height;
    /* Buffer pixel of the bound target's first pixel: nonzero inside an effect's content. */
    int origin_x, origin_y;
    /* Buffer-space scissor of the damage rectangle being repainted. */
    int scissor[4];
    int effect_depth;
    struct vec rasters, mipmaps; /* struct slot_entry */
    struct vec blur_chains;      /* struct blur_chain */
    struct vec effect_targets;   /* struct effect_target */
    /* Seconds this frame may still spend on work that could come later. */
    double spare;
    /* When drawing last handed its commands to the GPU. */
    double submitted_at;
};

const double RENDER_FULL_UV[8] = {0, 0, 1, 0, 0, 1, 1, 1};

/* Programs. */

static void object_log(GLuint object, bool program, struct strbuf *out) {
    GLint length = 0;
    if (program) {
        glGetProgramiv(object, GL_INFO_LOG_LENGTH, &length);
    } else {
        glGetShaderiv(object, GL_INFO_LOG_LENGTH, &length);
    }
    char *log = xcalloc((size_t)MAX(length, 1), 1);
    GLsizei written = 0;
    if (program) {
        glGetProgramInfoLog(object, MAX(length, 1), &written, log);
    } else {
        glGetShaderInfoLog(object, MAX(length, 1), &written, log);
    }
    /* Logs end in a newline the message does not need. */
    while (written > 0 && (log[written - 1] == '\n' || log[written - 1] == '\0')) written--;
    strbuf_append(out, log, (size_t)MAX(written, 0));
    free(log);
}

static GLuint start_shader(GLenum kind, const char *source) {
    GLuint shader = glCreateShader(kind);
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    return shader;
}

/* Start building a program of the shared vertex shader and FRAGMENT. */
static struct build start_program(const char *fragment) {
    struct build build = {glCreateProgram(), start_shader(GL_VERTEX_SHADER, vertex_shader),
                          start_shader(GL_FRAGMENT_SHADER, fragment)};
    glAttachShader(build.program, build.vertex);
    glAttachShader(build.program, build.fragment);
    glBindAttribLocation(build.program, 0, "a_position");
    glBindAttribLocation(build.program, 1, "a_local");
    glBindAttribLocation(build.program, 2, "a_uv");
    glLinkProgram(build.program);
    return build;
}

/* Finish BUILD into OUT, waiting for it if need be; false with ERROR filled. */
static bool finish_program(struct build *build, struct program *out, struct strbuf *error) {
    GLint status = 0;
    bool ok = true;
    GLuint shaders[] = {build->vertex, build->fragment};
    for (int i = 0; i < 2 && ok; i++) {
        glGetShaderiv(shaders[i], GL_COMPILE_STATUS, &status);
        if (!status) {
            strbuf_puts(error, "Shader compilation failed: ");
            object_log(shaders[i], false, error);
            ok = false;
        }
    }
    if (ok) {
        glGetProgramiv(build->program, GL_LINK_STATUS, &status);
        if (!status) {
            strbuf_puts(error, "Program link failed: ");
            object_log(build->program, true, error);
            ok = false;
        }
    }
    glDeleteShader(build->vertex);
    glDeleteShader(build->fragment);
    if (!ok) {
        glDeleteProgram(build->program);
    } else {
        *out = (struct program){.handle = build->program};
        for (int i = 0; i < UNIFORM_COUNT; i++)
            out->at[i] = glGetUniformLocation(out->handle, uniform_names[i]);
    }
    *build = (struct build){0};
    return ok;
}

static void abandon_build(struct build *build) {
    if (!build->program) return;
    glDeleteShader(build->vertex);
    glDeleteShader(build->fragment);
    glDeleteProgram(build->program);
    *build = (struct build){0};
}

static void destroy_program(struct program *program) {
    if (program->handle) glDeleteProgram(program->handle);
    program->handle = 0;
}

/* Whether BUILD can be finished without waiting. */
static bool build_ready(const struct renderer *renderer, const struct build *build) {
    if (!renderer->parallel_compile) return true;
    GLint done = 0;
    glGetProgramiv(build->program, GL_COMPLETION_STATUS_KHR, &done);
    return done;
}

/* Set uniform U to N VALUES, unless it holds them already. */
static void set_uniform(struct program *p, enum uniform u, int n, const float *values) {
    GLint at = p->at[u];
    if (at < 0) return;
    uint32_t bit = 1u << u;
    if ((p->set & bit) && !memcmp(p->held[u], values, n * sizeof *values)) return;
    p->set |= bit;
    memcpy(p->held[u], values, n * sizeof *values);
    switch (n) {
    case 1: glUniform1fv(at, 1, values); break;
    case 2: glUniform2fv(at, 1, values); break;
    case 4: glUniform4fv(at, 1, values); break;
    }
}

static void set_1f(struct program *p, enum uniform u, double x) {
    set_uniform(p, u, 1, (float[]){(float)x});
}

static void set_2f(struct program *p, enum uniform u, double x, double y) {
    set_uniform(p, u, 2, (float[]){(float)x, (float)y});
}

static void set_4f(struct program *p, enum uniform u, double x, double y, double z, double w) {
    set_uniform(p, u, 4, (float[]){(float)x, (float)y, (float)z, (float)w});
}

/* Set M's rows in the vec4 uniforms u_row_x, u_row_y and u_row_w. */
static void set_rows(struct program *p, struct mat3 m) {
    set_4f(p, U_ROW_X, m.a, m.c, m.e, 0);
    set_4f(p, U_ROW_Y, m.b, m.d, m.f, 0);
    set_4f(p, U_ROW_W, m.g, m.h, m.i, 0);
}

/* The texture coordinates within buffer AREA of a W x H texture whose first pixel is (X, Y). */
static void set_area(struct program *p, enum uniform u, struct pixel_box area, int x, int y,
                     double width, double height) {
    set_4f(p, u, (area.x - x + 0.5) / width, (area.y - y + 0.5) / height,
           (area.x - x + area.width - 0.5) / width, (area.y - y + area.height - 0.5) / height);
}

static void use(struct renderer *renderer, struct program *p) {
    if (renderer->current != p->handle) {
        glUseProgram(p->handle);
        renderer->current = p->handle;
    }
    set_2f(p, U_VIEWPORT, renderer->viewport_width, renderer->viewport_height);
}

/* Slots. */

static size_t slot_search(const struct vec *entries, uint64_t slot) {
    size_t low = 0, high = entries->length;
    const struct slot_entry *data = entries->data;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (data[middle].slot < slot) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

static void *slot_find(const struct vec *entries, uint64_t slot) {
    size_t index = slot_search(entries, slot);
    const struct slot_entry *data = entries->data;
    return index < entries->length && data[index].slot == slot ? data[index].value : NULL;
}

/* Store VALUE under SLOT, which holds nothing yet. */
static void slot_insert(struct vec *entries, uint64_t slot, void *value) {
    size_t index = slot_search(entries, slot);
    vec_push(entries);
    struct slot_entry *data = entries->data;
    memmove(data + index + 1, data + index, (entries->length - 1 - index) * sizeof(*data));
    data[index] = (struct slot_entry){slot, value};
}

static void slot_remove(struct vec *entries, uint64_t slot) {
    size_t index = slot_search(entries, slot);
    struct slot_entry *data = entries->data;
    if (index < entries->length && data[index].slot == slot) vec_remove(entries, index);
}

/* Director shaders. */

static const char *glsl_type(int count) {
    return count == 1 ? "float" : count == 2 ? "vec2" : "vec4";
}

/* Declare what SHADER reads of its node beyond the prelude, then its own uniforms. */
static void declare_inputs(struct strbuf *text, const struct shader *shader) {
    strbuf_puts(text, "uniform vec2 size;\nuniform float radius;\n");
    if (shader->time) strbuf_puts(text, "uniform float time;\n");
    if (shader->pointer) strbuf_puts(text, "uniform vec2 pointer;\n");
    for (int i = 0; i < shader->uniform_count; i++)
        strbuf_printf(text, "uniform %s %s;\n", glsl_type(shader->counts[i]), shader->names[i]);
    /* The director's lines number from 1 in compile errors. */
    strbuf_printf(text, "#line 1\n%s\n", shader->source);
}

/* The fragment shader running SHADER: a paint or an effect, or a filter of textures in
 * EXTERNAL images or ordinary ones. */
static void shader_source(struct strbuf *text, const struct shader *shader, bool external) {
    if (shader->stage == STAGE_FILTER) {
        if (external) strbuf_puts(text, "#extension GL_OES_EGL_image_external : require\n");
        strbuf_printf(text, "uniform %s u_texture;\n",
                      external ? "samplerExternalOES" : "sampler2D");
        strbuf_puts(text, texture_prelude);
        declare_inputs(text, shader);
        strbuf_puts(text, "#define STAGE_FILTER color = filter(color, v_local);\n");
        strbuf_puts(text, texture_main);
        return;
    }
    bool effect = shader->stage == STAGE_EFFECT;
    strbuf_puts(text, director_prelude);
    if (effect || shader->backdrop) strbuf_puts(text, read_prelude);
    if (effect)
        strbuf_puts(text, "uniform sampler2D u_content;\n"
                          "vec4 content(vec2 position) {\n"
                          "  return texture2D(u_content, stage_uv(position));\n"
                          "}\n");
    if (shader->backdrop)
        strbuf_puts(text, "uniform sampler2D u_backdrop;\n"
                          "vec4 backdrop(vec2 position) {\n"
                          "  return texture2D(u_backdrop, stage_uv(position));\n"
                          "}\n");
    declare_inputs(text, shader);
    strbuf_printf(text, "void main() { gl_FragColor = %s(v_local) * u_opacity; }\n",
                  effect ? "effect" : "paint");
}

static struct shaded *start_shaded(const struct shader *shader, bool external) {
    struct shaded *shaded = xcalloc(1, sizeof *shaded);
    struct strbuf text;
    strbuf_init(&text);
    shader_source(&text, shader, external);
    shaded->build = start_program(text.data);
    strbuf_finish(&text);
    return shaded;
}

/* Take SHADED's program, waiting for it if need be, or why it failed. */
static void finish_shaded(struct renderer *renderer, const struct shader *shader,
                          struct shaded *shaded) {
    struct strbuf error;
    strbuf_init(&error);
    if (finish_program(&shaded->build, &shaded->program, &error)) {
        GLuint handle = shaded->program.handle;
        for (int i = 0; i < shader->uniform_count; i++)
            shaded->locations[i] = glGetUniformLocation(handle, shader->names[i]);
        /* An effect reads its content from unit 0, its backdrop from unit 1. */
        if (shader->stage == STAGE_EFFECT && shaded->program.at[U_BACKDROP] >= 0) {
            glUseProgram(handle);
            glUniform1i(shaded->program.at[U_BACKDROP], 1);
            renderer->current = handle;
        }
    } else {
        shaded->error = xstrdup(error.data ? error.data : "Unknown error.");
    }
    strbuf_finish(&error);
}

static void destroy_shaded(struct shaded *shaded) {
    if (!shaded) return;
    abandon_build(&shaded->build);
    destroy_program(&shaded->program);
    free(shaded->error);
    free(shaded);
}

/* SHADED once it can run; NULL while it builds or once it failed, as REPORT says. */
static struct shaded *ready(struct renderer *renderer, const struct shader *shader,
                            struct shaded *shaded, struct render_report *report) {
    struct render_report ignored;
    if (!report) report = &ignored;
    if (shaded->build.program) {
        if (!build_ready(renderer, &shaded->build)) {
            report->building = true;
            return NULL;
        }
        finish_shaded(renderer, shader, shaded);
        report->built = !shaded->error;
    }
    if (shaded->error) {
        report->error = shaded->error;
        return NULL;
    }
    return shaded;
}

struct render_shader *render_shader_create(const struct shader *shader) {
    struct render_shader *out = xcalloc(1, sizeof *out);
    out->shader = shader;
    out->programs[0] = start_shaded(shader, false);
    return out;
}

bool render_shader_ready(const struct render_shader *shader) {
    const struct shaded *main = shader->programs[0];
    return main->program.handle && !main->build.program && !main->error;
}

void render_shader_destroy(struct render_shader *shader) {
    if (!shader) return;
    for (int i = 0; i < 2; i++) destroy_shaded(shader->programs[i]);
    free(shader);
}

/* Set what SHADING sees of its node, PIXEL local units per output pixel. */
static void set_shading(struct shaded *shaded, const struct render_shading *shading, double pixel) {
    struct program *p = &shaded->program;
    set_2f(p, U_SIZE, shading->size[0], shading->size[1]);
    set_1f(p, U_RADIUS, shading->radius);
    set_1f(p, U_PIXEL, pixel);
    set_1f(p, U_TIME, shading->time);
    set_2f(p, U_POINTER, shading->pointer[0], shading->pointer[1]);
    /* Uniforms the shader never reads were compiled away: they cost no call. */
    const struct shader *shader = shading->shader->shader;
    const float *values = shading->values;
    float *held = shaded->held;
    for (int i = 0; i < shader->uniform_count; i++) {
        int n = shader->counts[i];
        GLint at = shaded->locations[i];
        if (at >= 0 && (!shaded->primed || memcmp(held, values, n * sizeof *values))) {
            switch (n) {
            case 1: glUniform1fv(at, 1, values); break;
            case 2: glUniform2fv(at, 1, values); break;
            case 4: glUniform4fv(at, 1, values); break;
            }
            memcpy(held, values, n * sizeof *values);
        }
        values += n;
        held += n;
    }
    shaded->primed = true;
}

/* Lifetime. */

struct renderer *render_create(void) {
    struct renderer *renderer = xcalloc(1, sizeof(*renderer));
    vec_init(&renderer->rasters, sizeof(struct slot_entry));
    vec_init(&renderer->mipmaps, sizeof(struct slot_entry));
    vec_init(&renderer->blur_chains, sizeof(struct blur_chain));
    vec_init(&renderer->effect_targets, sizeof(struct effect_target));
    renderer->viewport_width = renderer->viewport_height = 1;
    const char *extensions = (const char *)glGetString(GL_EXTENSIONS);
    PFNGLMAXSHADERCOMPILERTHREADSKHRPROC compiler_threads =
        extensions && strstr(extensions, "GL_KHR_parallel_shader_compile")
            ? (PFNGLMAXSHADERCOMPILERTHREADSKHRPROC)eglGetProcAddress(
                  "glMaxShaderCompilerThreadsKHR")
            : NULL;
    if (compiler_threads) {
        compiler_threads(0xffffffff);
        renderer->parallel_compile = true;
    }

    struct strbuf texture, external;
    strbuf_init(&texture);
    strbuf_init(&external);
    strbuf_printf(&texture, "uniform sampler2D u_texture;\n%s#define STAGE_FILTER\n%s",
                  texture_prelude, texture_main);
    strbuf_printf(&external,
                  "#extension GL_OES_EGL_image_external : require\n"
                  "uniform samplerExternalOES u_texture;\n%s#define STAGE_FILTER\n%s",
                  texture_prelude, texture_main);
    struct {
        struct program *program;
        const char *fragment;
    } programs[] = {
        {&renderer->texture, texture.data},
        {&renderer->blur_down, blur_down_fragment},
        {&renderer->blur_up, blur_up_fragment},
    };
    /* Every program is started before any is waited for, so they build together. */
    struct build builds[ARRAY_LENGTH(programs) + 1];
    for (size_t i = 0; i < ARRAY_LENGTH(programs); i++)
        builds[i] = start_program(programs[i].fragment);
    builds[ARRAY_LENGTH(programs)] = start_program(external.data);
    renderer->passthrough = start_shaded(&passthrough_effect, false);
    struct strbuf error;
    strbuf_init(&error);
    bool ok = true;
    for (size_t i = 0; i < ARRAY_LENGTH(programs); i++) {
        if (!finish_program(&builds[i], programs[i].program, &error) && ok) {
            wlr_log(WLR_ERROR, "Renderer program %zu: %s", i, error.data);
            ok = false;
        }
    }
    /* External images are optional; a context without them still renders ordinary buffers. */
    strbuf_clear(&error);
    if (!finish_program(&builds[ARRAY_LENGTH(programs)], &renderer->external, &error))
        wlr_log(WLR_INFO, "No external image program: %s", error.data);
    finish_shaded(renderer, &passthrough_effect, renderer->passthrough);
    if (renderer->passthrough->error) {
        wlr_log(WLR_ERROR, "Renderer effect program: %s", renderer->passthrough->error);
        ok = false;
    }
    strbuf_finish(&error);
    strbuf_finish(&texture);
    strbuf_finish(&external);
    GLenum code = glGetError();
    if (ok && code != GL_NO_ERROR) {
        wlr_log(WLR_ERROR, "Renderer creation failed with GLES error 0x%x", code);
        ok = false;
    }
    if (!ok) {
        render_destroy(renderer);
        return NULL;
    }
    return renderer;
}

static void destroy_raster(struct render_raster *raster) {
    gl_delete_texture(raster->texture);
    free(raster);
}

static void destroy_mipmap(struct mipmap *mipmap) {
    render_target_destroy(mipmap->target);
    free(mipmap);
}

static void destroy_blur_chain(struct blur_chain *chain) {
    for (int i = 0; i < chain->count; i++) render_target_destroy(chain->levels[i]);
}

void render_destroy(struct renderer *renderer) {
    if (!renderer) return;
    struct program *programs[] = {&renderer->texture, &renderer->external, &renderer->blur_down,
                                  &renderer->blur_up};
    for (size_t i = 0; i < ARRAY_LENGTH(programs); i++) destroy_program(programs[i]);
    destroy_shaded(renderer->passthrough);
    VEC_FOR(&renderer->rasters, struct slot_entry, entry) destroy_raster(entry->value);
    VEC_FOR(&renderer->mipmaps, struct slot_entry, entry) destroy_mipmap(entry->value);
    VEC_FOR(&renderer->blur_chains, struct blur_chain, chain) destroy_blur_chain(chain);
    VEC_FOR(&renderer->effect_targets, struct effect_target, target) {
        render_target_destroy(target->target);
    }
    vec_finish(&renderer->rasters);
    vec_finish(&renderer->mipmaps);
    vec_finish(&renderer->blur_chains);
    vec_finish(&renderer->effect_targets);
    free(renderer);
}

/* Frames. */

void render_begin_frame(struct renderer *renderer, int width, int height) {
    double now = now_seconds();
    renderer->spare = SPARE_TIME;
    renderer->submitted_at = now;
    renderer->viewport_width = width;
    renderer->viewport_height = height;
    renderer->origin_x = renderer->origin_y = 0;
    renderer->effect_depth = 0;
    /* wlroots draws with programs of its own between frames. */
    renderer->current = 0;
    glViewport(0, 0, width, height);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glDisable(GL_STENCIL_TEST);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    /* Premultiplied blending throughout; offscreen copies only turn it off and on. */
    glEnable(GL_BLEND);
    glBlendEquation(GL_FUNC_ADD);
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    /* Vertices come from client memory, as in wlroots' own renderer: every draw from
     * the same array, so the attributes are set once a frame. Samplers stay at their
     * linked default, unit 0, which is the active one but while an effect paints. */
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    const GLsizei stride = 7 * sizeof(float);
    for (GLuint i = 0; i < 3; i++) glEnableVertexAttribArray(i);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, renderer->vertices);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, stride, renderer->vertices + 3);
    glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, stride, renderer->vertices + 5);
    glActiveTexture(GL_TEXTURE0);
    glEnable(GL_SCISSOR_TEST);
    render_set_scissor(renderer, 0, 0, width, height);
}

void render_set_scissor(struct renderer *renderer, int x, int y, int width, int height) {
    renderer->scissor[0] = x;
    renderer->scissor[1] = y;
    renderer->scissor[2] = width;
    renderer->scissor[3] = height;
    glScissor(x - renderer->origin_x, y - renderer->origin_y, width, height);
}

void render_clear(struct renderer *renderer, double red, double green, double blue, double alpha) {
    glClearColor((float)red, (float)green, (float)blue, (float)alpha);
    glClear(GL_COLOR_BUFFER_BIT);
}

void render_submit(struct renderer *renderer) {
    /*
     * The driver otherwise holds a frame's commands until it ends, leaving the
     * GPU idle while the CPU records them and the CPU idle while the GPU draws.
     */
    double now = now_seconds();
    if (now - renderer->submitted_at > SUBMIT_INTERVAL) {
        glFlush();
        renderer->submitted_at = now;
    }
}

void render_finish_frame(struct renderer *renderer) {
    glDisable(GL_SCISSOR_TEST);
    for (GLuint i = 0; i < 3; i++) glDisableVertexAttribArray(i);
    glFlush();
    renderer->current = 0;
    GLenum code = glGetError();
    if (code != GL_NO_ERROR) wlr_log(WLR_ERROR, "Frame drawing failed with GLES error 0x%x", code);
}

bool render_spare_time(const struct renderer *renderer) {
    return renderer->spare > 0;
}

void render_spend_spare_time(struct renderer *renderer, double since) {
    renderer->spare -= now_seconds() - since;
}

/* Geometry. */

/* Write the vertex at local (X, Y) through T, with texture coordinates (U, V), at OUT; return
 * where the next goes. */
static float *put_vertex(float *out, struct mat3 t, double x, double y, double u, double v) {
    out[0] = (float)(t.a * x + t.c * y + t.e);
    out[1] = (float)(t.b * x + t.d * y + t.f);
    out[2] = (float)(t.g * x + t.h * y + t.i);
    out[3] = (float)x;
    out[4] = (float)y;
    out[5] = (float)u;
    out[6] = (float)v;
    return out + 7;
}

/*
 * Draw local rectangle BOX through TRANSFORM. UV holds the texture coordinates
 * of its top-left, top-right, bottom-left and bottom-right corners, or is NULL.
 */
static void draw_quad(struct renderer *renderer, struct mat3 t, struct box box, const double *uv) {
    static const int corners[6] = {0, 1, 2, 1, 3, 2};
    float *v = renderer->vertices;
    for (int i = 0; i < 6; i++) {
        int corner = corners[i];
        double x = corner & 1 ? box.x + box.width : box.x;
        double y = corner >= 2 ? box.y + box.height : box.y;
        v = put_vertex(v, t, x, y, uv ? uv[2 * corner] : 0, uv ? uv[2 * corner + 1] : 0);
    }
    glDrawArrays(GL_TRIANGLES, 0, 6);
}

/*
 * Draw OUTER less INNER, which lies inside it, through T: eight triangles
 * joining their corners, every edge shared whole, so no pixel is drawn twice.
 */
static void draw_ring(struct renderer *renderer, struct mat3 t, struct box outer,
                      struct box inner) {
    double ox[4] = {outer.x, box_right(outer), box_right(outer), outer.x};
    double oy[4] = {outer.y, outer.y, box_bottom(outer), box_bottom(outer)};
    double ix[4] = {inner.x, box_right(inner), box_right(inner), inner.x};
    double iy[4] = {inner.y, inner.y, box_bottom(inner), box_bottom(inner)};
    float *v = renderer->vertices;
    for (int k = 0; k < 4; k++) {
        int n = (k + 1) % 4;
        v = put_vertex(v, t, ox[k], oy[k], 0, 0);
        v = put_vertex(v, t, ox[n], oy[n], 0, 0);
        v = put_vertex(v, t, ix[k], iy[k], 0, 0);
        v = put_vertex(v, t, ix[k], iy[k], 0, 0);
        v = put_vertex(v, t, ox[n], oy[n], 0, 0);
        v = put_vertex(v, t, ix[n], iy[n], 0, 0);
    }
    glDrawArrays(GL_TRIANGLES, 0, 24);
}

/* A buffer point and where it lies on a plane, homogeneously. */
struct plane_point {
    double x, y;
    double local[3];
};

/*
 * Cover the whole buffer with the plane T places. In perspective, the buffer
 * may show the plane's horizon: the part beyond it, where the plane is behind
 * the viewer, is cut away, and each corner left is found on the plane, so its
 * local position interpolates correctly.
 */
static void draw_plane(struct renderer *renderer, struct mat3 t) {
    struct mat3 inverse;
    if (!mat3_invert(t, &inverse)) return;
    double width = renderer->viewport_width, height = renderer->viewport_height;
    const double corners[4][2] = {{0, 0}, {width, 0}, {width, height}, {0, height}};
    struct plane_point in[4], out[5];
    double largest = 0;
    for (int i = 0; i < 4; i++) {
        double x = corners[i][0], y = corners[i][1];
        in[i] = (struct plane_point){x,
                                     y,
                                     {inverse.a * x + inverse.c * y + inverse.e,
                                      inverse.b * x + inverse.d * y + inverse.f,
                                      inverse.g * x + inverse.h * y + inverse.i}};
        largest = fmax(largest, fabs(in[i].local[2]));
    }
    double least = 1e-6 * largest;
    int count = 0;
    for (int i = 0; i < 4; i++) {
        const struct plane_point *p = &in[i], *q = &in[(i + 1) % 4];
        bool p_in = p->local[2] > least, q_in = q->local[2] > least;
        if (p_in) out[count++] = *p;
        if (p_in != q_in) {
            double s = (least - p->local[2]) / (q->local[2] - p->local[2]);
            struct plane_point *cut = &out[count++];
            cut->x = p->x + s * (q->x - p->x);
            cut->y = p->y + s * (q->y - p->y);
            for (int k = 0; k < 3; k++)
                cut->local[k] = p->local[k] + s * (q->local[k] - p->local[k]);
        }
    }
    if (count < 3) return;
    float *v = renderer->vertices;
    for (int i = 1; i + 1 < count; i++) {
        const struct plane_point *fan[3] = {&out[0], &out[i], &out[i + 1]};
        for (int k = 0; k < 3; k++) {
            const double *local = fan[k]->local;
            v = put_vertex(v, t, local[0] / local[2], local[1] / local[2], 0, 0);
        }
    }
    glDrawArrays(GL_TRIANGLES, 0, 3 * (count - 2));
}

/* Textures. */

/*
 * UV offset spanning one output pixel along the edge from corner FROM to TO, and
 * the taps it needs.
 */
static void uv_filter(const double uv[8], int from, int to, double local_length,
                      double pixels_per_unit, int texel_width, int texel_height, double *du_out,
                      double *dv_out, int *taps) {
    double du = uv[2 * to] - uv[2 * from];
    double dv = uv[2 * to + 1] - uv[2 * from + 1];
    double pixels = fmax(1e-6, local_length * pixels_per_unit);
    double texels = fabs(du * texel_width) + fabs(dv * texel_height);
    double ratio = texels / pixels;
    *du_out = du / pixels;
    *dv_out = dv / pixels;
    *taps = ratio > 1.25 ? (int)fmin(6, ceil(ratio)) : 1;
}

/* FILTER's program over textures in EXTERNAL images or ordinary ones, once it can run. */
static struct shaded *filter_program(struct renderer *renderer, const struct render_shading *filter,
                                     bool external, struct render_report *report) {
    struct render_shader *shader = filter->shader;
    if (!shader->programs[external])
        shader->programs[external] = start_shaded(shader->shader, external);
    return ready(renderer, shader->shader, shader->programs[external], report);
}

/* render_draw_texture, sampling the mipmapped copy of SURFACE kept under SLOT when
 * drawn small; without SURFACE, as the texture comes. */
static bool draw_texture(struct renderer *renderer, const struct render_texture *texture,
                         const struct render_texture_draw *draw,
                         const struct render_shading *filter, const struct render_surface *surface,
                         uint64_t slot, struct render_report *report) {
    struct mat3 transform = draw->transform;
    struct box box = draw->box;
    const double *uv = draw->uv;
    double scale =
        fmax(1e-9, mat3_scale_factor(transform, box.x + box.width / 2, box.y + box.height / 2));
    double xu, xv, yu, yv;
    int x_taps, y_taps;
    uv_filter(uv, 0, 1, box.width, scale, texture->width, texture->height, &xu, &xv, &x_taps);
    uv_filter(uv, 0, 2, box.height, scale, texture->width, texture->height, &yu, &yv, &y_taps);
    GLenum target = texture->target;
    GLuint name = texture->name;
    bool mipmapped = false;
    /* The copy is half size, so it serves only a texture drawn at half size or less. A
     * surface a few pixels across, like a window's border, needs none. */
    if (surface && slot && MIN(texture->width, texture->height) >= MIPMAP_MINIMUM &&
        MAX(x_taps, y_taps) > 2) {
        GLuint copy = render_surface_mipmap(renderer, slot, surface);
        if (copy) {
            target = GL_TEXTURE_2D;
            name = copy;
            x_taps = y_taps = 1;
            mipmapped = true;
        }
    }
    bool external = target == GL_TEXTURE_EXTERNAL_OES;
    struct program *p = external ? &renderer->external : &renderer->texture;
    if (!p->handle) return false;
    struct shaded *filtered = filter ? filter_program(renderer, filter, external, report) : NULL;
    if (filtered) p = &filtered->program;
    use(renderer, p);
    set_2f(p, U_FILTER_X, xu, xv);
    set_2f(p, U_FILTER_Y, yu, yv);
    set_2f(p, U_TAPS, x_taps, y_taps);
    set_4f(p, U_UV_BOUNDS, fmin(fmin(uv[0], uv[2]), fmin(uv[4], uv[6])),
           fmin(fmin(uv[1], uv[3]), fmin(uv[5], uv[7])),
           fmax(fmax(uv[0], uv[2]), fmax(uv[4], uv[6])),
           fmax(fmax(uv[1], uv[3]), fmax(uv[5], uv[7])));
    set_1f(p, U_OPACITY, draw->opacity);
    set_1f(p, U_HAS_ALPHA, texture->has_alpha ? 1 : 0);
    set_4f(p, U_MASK, draw->mask.x, draw->mask.y, draw->mask.width, draw->mask.height);
    set_1f(p, U_MASK_RADIUS, draw->radius);
    set_1f(p, U_PIXEL, 1 / scale);
    if (filtered) set_shading(filtered, filter, 1 / scale);
    glBindTexture(target, name);
    /*
     * The taps rely on bilinear filtering, which the compositor's own textures have.
     * A client's is set as it is drawn, as wlroots sets its own, so nothing is restored.
     */
    if (surface && !mipmapped) {
        glTexParameteri(target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    }
    draw_quad(renderer, transform, box, uv);
    return true;
}

bool render_draw_texture(struct renderer *renderer, const struct render_texture *texture,
                         const struct render_texture_draw *draw,
                         const struct render_shading *filter, struct render_report *report) {
    return draw_texture(renderer, texture, draw, filter, NULL, 0, report);
}

/*
 * Mipmaps. A window drawn small, as a card or a thumbnail, needs dozens of
 * texels per pixel to stay smooth, which costs the GPU more than the rest of the
 * frame. Instead it gets a half-size copy with mip levels, made once per commit
 * and sampled once per pixel, as GNOME does for its overview.
 */

/* Draw SURFACE's whole texture into TARGET, then fill TARGET's smaller levels. */
static void copy_into_mipmap(struct renderer *renderer, const struct render_surface *surface,
                             const struct render_target *target) {
    int viewport_width = renderer->viewport_width;
    int viewport_height = renderer->viewport_height;
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_BLEND);
    struct gl_binding saved;
    render_target_bind(target, &saved);
    renderer->viewport_width = target->width;
    renderer->viewport_height = target->height;
    /* At half size the box filter averages each two by two texels; slot 0 asks for no copy. */
    struct box whole = {0, 0, target->width, target->height};
    draw_texture(renderer, &surface->texture,
                 &(struct render_texture_draw){MAT3_IDENTITY, whole, RENDER_FULL_UV, whole, 0, 1},
                 NULL, surface, 0, NULL);
    gl_restore_binding(&saved);
    renderer->viewport_width = viewport_width;
    renderer->viewport_height = viewport_height;
    glEnable(GL_BLEND);
    glEnable(GL_SCISSOR_TEST);
    render_target_generate_mipmaps(target);
}

GLuint render_surface_mipmap(struct renderer *renderer, uint64_t slot,
                             const struct render_surface *surface) {
    struct mipmap *mipmap = slot_find(&renderer->mipmaps, slot);
    int width = MAX(1, (surface->texture.width + 1) / 2);
    int height = MAX(1, (surface->texture.height + 1) / 2);
    if (!mipmap || mipmap->source != surface->source || mipmap->generation != surface->generation) {
        if (!render_spare_time(renderer)) return 0;
        double start = now_seconds();
        if (!mipmap || mipmap->target->width != width || mipmap->target->height != height) {
            if (mipmap) {
                slot_remove(&renderer->mipmaps, slot);
                destroy_mipmap(mipmap);
            }
            struct render_target *target = render_target_create(width, height, true);
            if (!target) {
                render_spend_spare_time(renderer, start);
                return 0;
            }
            mipmap = xcalloc(1, sizeof(*mipmap));
            mipmap->target = target;
            slot_insert(&renderer->mipmaps, slot, mipmap);
        }
        copy_into_mipmap(renderer, surface, mipmap->target);
        mipmap->source = surface->source;
        mipmap->generation = surface->generation;
        render_spend_spare_time(renderer, start);
    }
    mipmap->used = now_seconds();
    return mipmap->target->texture;
}

void render_touch_mipmap(struct renderer *renderer, uint64_t slot) {
    struct mipmap *mipmap = slot_find(&renderer->mipmaps, slot);
    if (mipmap) mipmap->used = now_seconds();
}

bool render_draw_surface(struct renderer *renderer, const struct render_surface *surface,
                         const struct render_texture_draw *draw,
                         const struct render_shading *filter, uint64_t slot,
                         struct render_report *report) {
    return draw_texture(renderer, &surface->texture, draw, filter, surface, slot, report);
}

/* Rasters: textures the compositor uploads itself. */

struct render_raster *render_slot_raster(struct renderer *renderer, uint64_t slot) {
    return slot_find(&renderer->rasters, slot);
}

struct render_raster *render_install_raster(struct renderer *renderer, uint64_t slot, uint64_t key,
                                            const void *pixels, int width, int height,
                                            GLenum format) {
    struct render_raster *raster = render_slot_raster(renderer, slot);
    if (!raster) {
        raster = xcalloc(1, sizeof(*raster));
        raster->lifetime = 2;
        slot_insert(&renderer->rasters, slot, raster);
    }
    if (raster->texture) {
        gl_upload_texture(raster->texture, width, height, pixels, format);
    } else {
        raster->texture = gl_create_texture(width, height, pixels, format);
    }
    raster->width = width;
    raster->height = height;
    raster->key = key;
    raster->used = now_seconds();
    raster->family = 0;
    raster->scale = 1;
    return raster;
}

struct render_raster *render_raster(struct renderer *renderer, uint64_t slot, uint64_t key,
                                    double lifetime, render_raster_producer producer, void *data) {
    struct render_raster *raster = render_slot_raster(renderer, slot);
    if ((!raster || raster->key != key) && producer) {
        producer(renderer, slot, key, data);
        raster = render_slot_raster(renderer, slot);
    }
    if (!raster || raster->key != key) return NULL;
    raster->used = now_seconds();
    raster->lifetime = lifetime;
    return raster;
}

void render_touch_raster(struct renderer *renderer, uint64_t slot) {
    struct render_raster *raster = render_slot_raster(renderer, slot);
    if (raster) raster->used = now_seconds();
}

void render_sweep(struct renderer *renderer, double now) {
    for (size_t i = 0; i < renderer->blur_chains.length;) {
        struct blur_chain *chain = vec_at(&renderer->blur_chains, i);
        if (now - chain->used > 2) {
            destroy_blur_chain(chain);
            vec_remove(&renderer->blur_chains, i);
        } else {
            i++;
        }
    }
    for (size_t i = 0; i < renderer->effect_targets.length;) {
        struct effect_target *target = vec_at(&renderer->effect_targets, i);
        if (now - target->used > 2) {
            render_target_destroy(target->target);
            vec_remove(&renderer->effect_targets, i);
        } else {
            i++;
        }
    }
    /* Sorted slot tables are compacted in place, keeping their order. */
    size_t kept = 0;
    VEC_FOR(&renderer->mipmaps, struct slot_entry, entry) {
        struct mipmap *mipmap = entry->value;
        if (now - mipmap->used > 2) {
            destroy_mipmap(mipmap);
        } else {
            ((struct slot_entry *)renderer->mipmaps.data)[kept++] = *entry;
        }
    }
    renderer->mipmaps.length = kept;
    kept = 0;
    VEC_FOR(&renderer->rasters, struct slot_entry, entry) {
        struct render_raster *raster = entry->value;
        if (now - raster->used > raster->lifetime) {
            destroy_raster(raster);
        } else {
            ((struct slot_entry *)renderer->rasters.data)[kept++] = *entry;
        }
    }
    renderer->rasters.length = kept;
}

void render_draw_raster(struct renderer *renderer, const struct render_raster *raster,
                        const struct render_texture_draw *draw, const struct render_shading *filter,
                        struct render_report *report) {
    struct render_texture texture = {GL_TEXTURE_2D, raster->texture, raster->width, raster->height,
                                     true};
    render_draw_texture(renderer, &texture, draw, filter, report);
}

/* Backdrops. */

/* How a backdrop blur of a radius runs, in output pixels. */
struct render_blur {
    int passes;
    double offset;
    /* How far beyond the blurred box it samples. */
    int margin;
};

static struct render_blur render_blur_parameters(double radius) {
    if (!(radius >= 1)) return (struct render_blur){0, 0, 0};
    /* Each pass doubles the reach: a blur of R takes about log2(R) - 1 of them. */
    int passes = (int)fmax(1, fmin(MAX_BLUR_PASSES, rint(log2(fmax(radius, 2))) - 1));
    double reach = ldexp(1, passes + 1);
    double offset = fmax(1, fmin(3, radius / reach));
    return (struct render_blur){passes, offset, 2 + (int)ceil(offset * reach)};
}

int render_blur_margin(double radius) {
    return render_blur_parameters(radius).margin;
}

/* Render targets for levels 0..PASSES of a WIDTH x HEIGHT buffer, created on demand. */
static struct blur_chain *blur_chain(struct renderer *renderer, int width, int height, int passes) {
    struct blur_chain *chain = NULL;
    VEC_FOR(&renderer->blur_chains, struct blur_chain, candidate) {
        if (candidate->width == width && candidate->height == height) chain = candidate;
    }
    if (!chain) {
        chain = vec_push(&renderer->blur_chains);
        chain->width = width;
        chain->height = height;
    }
    for (int level = chain->count; level <= passes; level++) {
        int factor = 1 << level;
        struct render_target *target = render_target_create(
            MAX(1, (width + factor - 1) / factor), MAX(1, (height + factor - 1) / factor), false);
        if (!target) break;
        chain->levels[chain->count++] = target;
    }
    chain->used = now_seconds();
    return chain->count > passes ? chain : NULL;
}

static int floor_div(int value, int divisor) {
    return value >= 0 ? value / divisor : -((-value + divisor - 1) / divisor);
}

/* A buffer-space area in LEVEL's pixels, rounded outwards. */
static struct pixel_box level_area(struct pixel_box area, int level) {
    int factor = 1 << level;
    int left = floor_div(area.x, factor), top = floor_div(area.y, factor);
    return (struct pixel_box){left, top, -floor_div(-(area.x + area.width), factor) - left,
                              -floor_div(-(area.y + area.height), factor) - top};
}

/*
 * Draw TARGET_AREA of TARGET from SOURCE, sampling only SOURCE_AREA. RATIO is the
 * scale from target to source pixels: 2 when downsampling, 1/2 when upsampling.
 */
static void blur_pass(struct renderer *renderer, struct program *p,
                      const struct render_target *source, const struct render_target *target,
                      struct pixel_box from, struct pixel_box to, double ratio, double offset) {
    double width = source->width, height = source->height;
    render_target_bind(target, NULL);
    renderer->viewport_width = target->width;
    renderer->viewport_height = target->height;
    use(renderer, p);
    set_2f(p, U_OFFSET, 0.5 * offset / width, 0.5 * offset / height);
    set_area(p, U_BOUNDS, from, 0, 0, width, height);
    glBindTexture(GL_TEXTURE_2D, source->texture);
    double u0 = to.x * ratio / width, v0 = to.y * ratio / height;
    double u1 = (to.x + to.width) * ratio / width, v1 = (to.y + to.height) * ratio / height;
    const double uv[8] = {u0, v0, u1, v0, u0, v1, u1, v1};
    draw_quad(renderer, MAT3_IDENTITY, (struct box){to.x, to.y, to.width, to.height}, uv);
}

/*
 * Copy the pixels already drawn in buffer AREA and blur them by BLUR output
 * pixels: the texture holding them where they lie in the buffer, or 0 when the
 * driver cannot make one.
 */
static GLuint read_backdrop(struct renderer *renderer, struct pixel_box area, double blur) {
    if (area.width <= 0 || area.height <= 0) return 0;
    int buffer_width = renderer->viewport_width;
    int buffer_height = renderer->viewport_height;
    struct render_blur parameters = render_blur_parameters(blur);
    struct blur_chain *chain = blur_chain(renderer, buffer_width, buffer_height, parameters.passes);
    if (!chain) return 0;
    gl_copy_framebuffer(chain->levels[0], area.x, area.y, area.width, area.height,
                        area.x - renderer->origin_x, area.y - renderer->origin_y);
    if (!parameters.passes) return chain->levels[0]->texture;
    struct pixel_box areas[MAX_BLUR_PASSES + 1];
    for (int level = 0; level <= parameters.passes; level++) areas[level] = level_area(area, level);
    struct gl_binding saved;
    gl_save_binding(&saved);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_BLEND);
    for (int level = 1; level <= parameters.passes; level++) {
        blur_pass(renderer, &renderer->blur_down, chain->levels[level - 1], chain->levels[level],
                  areas[level - 1], areas[level], 2, parameters.offset);
    }
    for (int level = parameters.passes - 1; level >= 0; level--) {
        blur_pass(renderer, &renderer->blur_up, chain->levels[level + 1], chain->levels[level],
                  areas[level + 1], areas[level], 0.5, parameters.offset);
    }
    gl_restore_binding(&saved);
    renderer->viewport_width = buffer_width;
    renderer->viewport_height = buffer_height;
    glEnable(GL_BLEND);
    glEnable(GL_SCISSOR_TEST);
    return chain->levels[0]->texture;
}

/* Paints. */

bool render_draw_paint(struct renderer *renderer, const struct render_shading *shading,
                       const struct render_paint_draw *draw, struct render_report *report) {
    const struct shader *shader = shading->shader->shader;
    struct shaded *shaded = ready(renderer, shader, shading->shader->programs[0], report);
    if (!shaded) return false;
    /* What is behind is read, and blurred, before the paint's program is in use. */
    GLuint backdrop = shader->backdrop ? read_backdrop(renderer, draw->area, draw->blur) : 0;
    if (shader->backdrop && !backdrop) return true;
    struct program *p = &shaded->program;
    use(renderer, p);
    struct mat3 t = draw->transform;
    set_1f(p, U_OPACITY, draw->opacity);
    set_shading(shaded, shading,
                draw->plane
                    ? mat3_plane_pixel(t, renderer->viewport_width, renderer->viewport_height)
                    : mat3_pixel_size(t, shading->size[0] / 2, shading->size[1] / 2));
    if (backdrop) {
        int width = renderer->viewport_width, height = renderer->viewport_height;
        set_rows(p, t);
        set_2f(p, U_READ_OFFSET, 0, 0);
        set_2f(p, U_READ_SIZE, width, height);
        set_area(p, U_READ_AREA, draw->area, 0, 0, width, height);
        glBindTexture(GL_TEXTURE_2D, backdrop);
    }
    if (draw->plane) {
        draw_plane(renderer, t);
    } else if (draw->holed) {
        draw_ring(renderer, t, draw->quad, draw->hole);
    } else {
        draw_quad(renderer, t, draw->quad, NULL);
    }
    return true;
}

/* Effects. */

struct render_target *render_effect_target(struct renderer *renderer, int width, int height,
                                           enum render_effect_role role) {
    int stepped_width =
        EFFECT_TARGET_STEP * MAX(1, (width + EFFECT_TARGET_STEP - 1) / EFFECT_TARGET_STEP);
    int stepped_height =
        EFFECT_TARGET_STEP * MAX(1, (height + EFFECT_TARGET_STEP - 1) / EFFECT_TARGET_STEP);
    double now = now_seconds();
    VEC_FOR(&renderer->effect_targets, struct effect_target, entry) {
        if (entry->width == stepped_width && entry->height == stepped_height &&
            entry->depth == renderer->effect_depth && entry->role == role) {
            entry->used = now;
            return entry->target;
        }
    }
    struct render_target *target = render_target_create(stepped_width, stepped_height, false);
    if (!target) return NULL;
    struct effect_target *entry = vec_push(&renderer->effect_targets);
    *entry = (struct effect_target){stepped_width, stepped_height, renderer->effect_depth,
                                    role,          target,         now};
    return target;
}

void render_begin_effect(struct renderer *renderer, const struct render_target *content,
                         const struct render_target *backdrop, struct pixel_box area, int origin_x,
                         int origin_y, struct render_effect_scope *scope) {
    /* What is drawn so far, behind the effect, before the content replaces it. */
    if (backdrop) {
        gl_copy_framebuffer(backdrop, area.x - origin_x, area.y - origin_y, area.width, area.height,
                            area.x - renderer->origin_x, area.y - renderer->origin_y);
    }
    scope->depth = renderer->effect_depth;
    scope->origin_x = renderer->origin_x;
    scope->origin_y = renderer->origin_y;
    memcpy(scope->scissor, renderer->scissor, sizeof(scope->scissor));
    renderer->effect_depth++;
    renderer->origin_x = origin_x;
    renderer->origin_y = origin_y;
    render_target_bind_offset(content, origin_x, origin_y, renderer->viewport_width,
                              renderer->viewport_height, &scope->binding);
    render_set_scissor(renderer, area.x, area.y, area.width, area.height);
    render_clear(renderer, 0, 0, 0, 0);
}

void render_end_effect(struct renderer *renderer, const struct render_effect_scope *scope) {
    gl_restore_binding(&scope->binding);
    renderer->effect_depth = scope->depth;
    renderer->origin_x = scope->origin_x;
    renderer->origin_y = scope->origin_y;
    const int *s = scope->scissor;
    render_set_scissor(renderer, s[0], s[1], s[2], s[3]);
}

void render_draw_effect(struct renderer *renderer, const struct render_shading *shading,
                        const struct render_effect_draw *draw, const struct render_target *content,
                        const struct render_target *backdrop, struct pixel_box area, int origin_x,
                        int origin_y, struct render_report *report) {
    struct shaded *shaded =
        shading ? ready(renderer, shading->shader->shader, shading->shader->programs[0], report)
                : NULL;
    struct program *p = shaded ? &shaded->program : &renderer->passthrough->program;
    use(renderer, p);
    struct box quad = draw->quad;
    set_rows(p, draw->transform);
    set_2f(p, U_READ_OFFSET, origin_x, origin_y);
    set_2f(p, U_READ_SIZE, content->width, content->height);
    /* Samples stay inside the pixels this draw rendered. */
    set_area(p, U_READ_AREA, area, origin_x, origin_y, content->width, content->height);
    set_1f(p, U_OPACITY, draw->opacity);
    if (shaded)
        set_shading(
            shaded, shading,
            mat3_pixel_size(draw->transform, quad.x + quad.width / 2, quad.y + quad.height / 2));
    if (backdrop) {
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, backdrop->texture);
        glActiveTexture(GL_TEXTURE0);
    }
    glBindTexture(GL_TEXTURE_2D, content->texture);
    draw_quad(renderer, draw->transform, quad, NULL);
    if (backdrop) {
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, 0);
        glActiveTexture(GL_TEXTURE0);
    }
}
