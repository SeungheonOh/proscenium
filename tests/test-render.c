/*
 * Headless sanity check of the renderer: draws into a render target on a
 * windowless EGL context and reads the pixels back.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <fcntl.h>
#include <gbm.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "geometry.h"
#include "gl.h"
#include "render.h"
#include "shader.h"
#include "util.h"

#define SIZE 256

static int failures;

#define CHECK(condition, ...)                                                                      \
    do {                                                                                           \
        if (!(condition)) {                                                                        \
            failures++;                                                                            \
            fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__);                                   \
            fprintf(stderr, __VA_ARGS__);                                                          \
            fputc('\n', stderr);                                                                   \
        }                                                                                          \
    } while (0)

static bool make_context(void) {
    PFNEGLGETPLATFORMDISPLAYEXTPROC get_display =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    if (!get_display) return false;
    EGLDisplay display = EGL_NO_DISPLAY;
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    struct gbm_device *gbm = fd >= 0 ? gbm_create_device(fd) : NULL;
    if (gbm) display = get_display(EGL_PLATFORM_GBM_KHR, gbm, NULL);
    if (display == EGL_NO_DISPLAY || !eglInitialize(display, NULL, NULL)) {
        display = get_display(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
        if (display == EGL_NO_DISPLAY || !eglInitialize(display, NULL, NULL)) return false;
    }
    eglBindAPI(EGL_OPENGL_ES_API);
    /* A GLES2 context, as wlroots makes. */
    const EGLint attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLContext context = eglCreateContext(display, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attributes);
    return context != EGL_NO_CONTEXT &&
           eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context);
}

static unsigned char pixels[SIZE * SIZE * 4];

static void read_back(void) {
    gl_read_pixels(0, 0, SIZE, SIZE, pixels);
}

static const unsigned char *at(int x, int y) {
    return pixels + (y * SIZE + x) * 4;
}

static bool near(const unsigned char *p, int r, int g, int b, int a, int tolerance) {
    return abs(p[0] - r) <= tolerance && abs(p[1] - g) <= tolerance && abs(p[2] - b) <= tolerance &&
           abs(p[3] - a) <= tolerance;
}

static void begin(struct renderer *renderer) {
    render_begin_frame(renderer, SIZE, SIZE);
    render_clear(renderer, 0, 0, 0, 0);
}

static void finish(struct renderer *renderer) {
    render_finish_frame(renderer);
    read_back();
}

/* A shader as the registry would hold it, with NAMES and COUNTS of its uniforms. */
static struct shader define(enum shader_stage stage, const char *source, int count,
                            const char *const *names, const int *counts) {
    struct shader shader = {.stage = stage, .source = (char *)source, .backdrop_blur = -1};
    for (int i = 0; i < count; i++) {
        snprintf(shader.names[i], sizeof shader.names[i], "%s", names[i]);
        shader.counts[i] = counts[i];
        shader.offsets[i] = shader.component_count;
        shader.component_count += counts[i];
    }
    shader.uniform_count = count;
    return shader;
}

/* Paint DRAW through SHADING once its program is built; false with REPORT's error when it
 * failed. */
static bool painted(struct renderer *renderer, const struct render_shading *shading,
                    const struct render_paint_draw *draw, struct render_report *report) {
    for (int i = 0; i < 2000; i++) {
        *report = (struct render_report){0};
        if (render_draw_paint(renderer, shading, draw, report)) return true;
        if (report->error) return false;
        usleep(1000);
    }
    return false;
}

/* A box at (X, Y) of WIDTH x HEIGHT, drawn by SHADER with VALUES at OPACITY. */
static bool paint_box(struct renderer *renderer, struct render_shader *shader, double x, double y,
                      double width, double height, const float *values, double opacity) {
    struct render_shading shading = {shader, values, {width, height}, 0, 0, {0, 0}};
    struct render_paint_draw draw = {
        .transform = mat3_translation(x, y), .quad = {0, 0, width, height}, .opacity = opacity};
    struct render_report report;
    return painted(renderer, &shading, &draw, &report);
}

static const char *const solid_names[] = {"color"};
static const int solid_counts[] = {4};
static const char solid_source[] = "vec4 paint(vec2 p) { return color; }";

/* A paint showing its inputs: red the position across the box, green a uniform's
 * second value, blue the corner radius in hundredths. */
static const char probe[] =
    "vec4 paint(vec2 p) { return vec4(p.x / size.x, level.y, radius / 100.0, 1.0); }";

static void test_paint(struct renderer *renderer) {
    /* A uniform the shader never reads still takes its place among the values. */
    const char *const names[] = {"unused", "level"};
    const int counts[] = {1, 2};
    const float values[] = {9, 0.25f, 0.75f};
    struct shader definition = define(STAGE_PAINT, probe, 2, names, counts);
    struct render_shader *shader = render_shader_create(&definition);
    struct render_shading shading = {shader, values, {100, 100}, 20, 0, {0, 0}};
    struct render_paint_draw draw = {
        .transform = mat3_translation(50, 50), .quad = {0, 0, 100, 100}, .opacity = 0.5};
    struct render_report report;
    begin(renderer);
    bool drawn = painted(renderer, &shading, &draw, &report);
    finish(renderer);
    CHECK(drawn, "paint failed: %s", report.error ? report.error : "?");
    const unsigned char *p = at(100, 100);
    CHECK(near(p, 64, 96, 26, 128, 2), "paint %d %d %d %d", p[0], p[1], p[2], p[3]);
    CHECK(at(40, 100)[3] == 0 && at(160, 100)[3] == 0, "paint outside its quad");

    struct shader wrong =
        define(STAGE_PAINT, "vec4 paint(vec2 p) {\n  return nope;\n}", 0, NULL, NULL);
    struct render_shader *broken = render_shader_create(&wrong);
    shading.shader = broken;
    begin(renderer);
    CHECK(!painted(renderer, &shading, &draw, &report), "broken painted");
    finish(renderer);
    const char *error = report.error;
    CHECK(error && (strstr(error, "0:2(") || strstr(error, "0:2:")), "error not on line 2: %s",
          error ? error : "(none)");
    CHECK(at(100, 100)[3] == 0, "a broken paint drew");
    render_shader_destroy(shader);
    render_shader_destroy(broken);
}

/* A hole leaves a ring, every pixel of which is drawn once. */
static void test_ring(struct renderer *renderer) {
    struct shader definition = define(STAGE_PAINT, solid_source, 1, solid_names, solid_counts);
    struct render_shader *shader = render_shader_create(&definition);
    const float half[] = {0.5f, 0.5f, 0.5f, 0.5f};
    struct render_shading shading = {shader, half, {100, 100}, 0, 0, {0, 0}};
    struct render_paint_draw draw = {
        .transform = mat3_translation(50, 50),
        .quad = {0, 0, 100, 100},
        .holed = true,
        .hole = {10, 10, 80, 80},
        .opacity = 1,
    };
    struct render_report report;
    begin(renderer);
    CHECK(painted(renderer, &shading, &draw, &report), "ring failed");
    finish(renderer);
    CHECK(at(100, 100)[3] == 0 && at(61, 61)[3] == 0, "the hole was drawn");
    const int ring[][2] = {{50, 50}, {55, 100}, {100, 55}, {144, 144}, {59, 59}, {140, 59}};
    for (size_t i = 0; i < ARRAY_LENGTH(ring); i++) {
        const unsigned char *p = at(ring[i][0], ring[i][1]);
        CHECK(near(p, 128, 128, 128, 128, 1), "ring at %d,%d: %d %d %d %d", ring[i][0], ring[i][1],
              p[0], p[1], p[2], p[3]);
    }
    render_shader_destroy(shader);
}

/* A plane covers the buffer, and in perspective stops at its horizon. */
static void test_plane(struct renderer *renderer) {
    struct shader definition =
        define(STAGE_PAINT, "vec4 paint(vec2 p) { return vec4(fract(p.x / 64.0), 0.0, 0.0, 1.0); }",
               0, NULL, NULL);
    struct render_shader *shader = render_shader_create(&definition);
    struct render_shading shading = {shader, NULL, {0, 0}, 0, 0, {0, 0}};
    struct render_paint_draw draw = {
        .transform = mat3_translation(10, 0), .plane = true, .opacity = 1};
    struct render_report report;
    begin(renderer);
    CHECK(painted(renderer, &shading, &draw, &report), "plane failed");
    finish(renderer);
    /* Buffer pixel 42's centre lies at local 32.5. */
    CHECK(near(at(42, 7), 129, 0, 0, 255, 2) && at(250, 250)[3] == 255, "plane %d %d", at(42, 7)[0],
          at(250, 250)[3]);
    /* Local y runs to infinity as buffer y nears 100: below it lies the sky. */
    draw.transform = (struct mat3){1, 0, 0, 1, 0, 0, 0, 0.01, 1};
    begin(renderer);
    CHECK(painted(renderer, &shading, &draw, &report), "perspective plane failed");
    finish(renderer);
    CHECK(at(50, 60)[3] == 255 && at(50, 120)[3] == 0, "horizon: %d above, %d below", at(50, 60)[3],
          at(50, 120)[3]);
    render_shader_destroy(shader);
}
static GLuint pattern_texture(int width, int height, unsigned char *texels, bool checker) {
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            unsigned char *t = texels + (y * width + x) * 4;
            if (checker) {
                unsigned char v = (x + y) % 2 ? 255 : 0;
                t[0] = t[1] = t[2] = v;
            } else {
                t[0] = (unsigned char)(x * 16);
                t[1] = (unsigned char)(y * 16);
                t[2] = (unsigned char)((x ^ y) * 16);
            }
            t[3] = 255;
        }
    }
    return gl_create_texture(width, height, texels, GL_RGBA);
}

static void test_texture(struct renderer *renderer) {
    unsigned char texels[16 * 16 * 4];
    struct render_texture texture = {GL_TEXTURE_2D, pattern_texture(16, 16, texels, false), 16, 16,
                                     true};
    begin(renderer);
    struct box box = {0, 0, 16, 16};
    render_draw_texture(
        renderer, &texture,
        &(struct render_texture_draw){mat3_translation(30, 40), box, RENDER_FULL_UV, box, 0, 1},
        NULL, NULL);
    finish(renderer);
    int mismatches = 0;
    for (int y = 0; y < 16; y++) {
        for (int x = 0; x < 16; x++) {
            if (memcmp(at(30 + x, 40 + y), texels + (y * 16 + x) * 4, 4) != 0) mismatches++;
        }
    }
    CHECK(mismatches == 0, "1:1 texture differs in %d texels", mismatches);
    gl_delete_texture(texture.name);
}

/* Fraction of a 1-texel checkerboard drawn small that strays from mid grey. */
static void check_smooth(const char *what, int x0, int y0, int size) {
    double sum = 0, worst = 0;
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            double v = at(x0 + x, y0 + y)[0] / 255.0;
            sum += v;
            worst = fmax(worst, fabs(v - 0.5));
        }
    }
    CHECK(fabs(sum / (size * size) - 0.5) < 0.03, "%s mean %.3f", what, sum / (size * size));
    CHECK(worst < 0.15, "%s strays %.3f from grey", what, worst);
}

static void test_downscale(struct renderer *renderer) {
    static unsigned char texels[192 * 192 * 4];
    struct render_texture texture = {GL_TEXTURE_2D, pattern_texture(64, 64, texels, true), 64, 64,
                                     true};
    begin(renderer);
    /* 3.2 texels a pixel: a single bilinear tap would alias between black and white. */
    struct box box = {0, 0, 20, 20};
    render_draw_texture(
        renderer, &texture,
        &(struct render_texture_draw){mat3_translation(10, 10), box, RENDER_FULL_UV, box, 0, 1},
        NULL, NULL);
    finish(renderer);
    check_smooth("box filtered texture", 10, 10, 20);
    gl_delete_texture(texture.name);
}

static void test_mipmap(struct renderer *renderer) {
    static unsigned char texels[192 * 192 * 4];
    struct render_surface surface = {
        {GL_TEXTURE_2D, pattern_texture(192, 192, texels, true), 192, 192, true},
        &surface,
        1,
    };
    begin(renderer);
    struct box box = {0, 0, 30, 30};
    render_draw_surface(
        renderer, &surface,
        &(struct render_texture_draw){mat3_translation(10, 10), box, RENDER_FULL_UV, box, 0, 1},
        NULL, 42, NULL);
    GLuint copy = render_surface_mipmap(renderer, 42, &surface);
    finish(renderer);
    CHECK(copy != 0, "no mipmap copy");
    check_smooth("mipmapped surface", 10, 10, 30);
    begin(renderer);
    CHECK(render_surface_mipmap(renderer, 42, &surface) == copy, "mipmap remade unchanged");
    render_finish_frame(renderer);
    render_sweep(renderer, now_seconds() + 3);
    begin(renderer);
    surface.generation = 2;
    GLuint again = render_surface_mipmap(renderer, 42, &surface);
    render_finish_frame(renderer);
    CHECK(again != 0, "mipmap not remade after a sweep");
    gl_delete_texture(surface.texture.name);
}

/* A paint reading what is behind it, blurred by its uniform's local units. */
static void test_backdrop(struct renderer *renderer) {
    static unsigned char texels[192 * 192 * 4];
    struct render_texture texture = {GL_TEXTURE_2D, pattern_texture(192, 192, texels, true), 192,
                                     192, true};
    const char *const names[] = {"blur"};
    const int counts[] = {1};
    struct shader definition =
        define(STAGE_PAINT, "vec4 paint(vec2 p) { return backdrop(p); }", 1, names, counts);
    definition.backdrop = true;
    definition.backdrop_blur = 0;
    struct render_shader *shader = render_shader_create(&definition);
    for (int blurred = 0; blurred < 2; blurred++) {
        begin(renderer);
        struct box whole = {0, 0, 192, 192};
        render_draw_texture(renderer, &texture,
                            &(struct render_texture_draw){mat3_translation(32, 32), whole,
                                                          RENDER_FULL_UV, whole, 0, 1},
                            NULL, NULL);
        const float values[] = {blurred ? 8 : 0};
        struct render_shading shading = {shader, values, {48, 48}, 0, 0, {0, 0}};
        /* Twice the size: 8 local units blur by 16 pixels. */
        struct mat3 transform =
            mat3_multiply(mat3_translation(80, 80), mat3_affine(2, 0, 0, 2, 0, 0));
        struct render_paint_draw draw = {
            .transform = transform, .quad = {0, 0, 48, 48}, .opacity = 1, .blur = values[0] * 2};
        struct box bounds =
            box_inflate(mat3_box_bounds(transform, draw.quad, 1), render_blur_margin(draw.blur));
        draw.area = box_pixels(bounds, SIZE, SIZE);
        struct render_report report;
        CHECK(painted(renderer, &shading, &draw, &report), "backdrop failed: %s",
              report.error ? report.error : "?");
        finish(renderer);
        if (blurred) {
            check_smooth("blurred backdrop", 90, 90, 76);
        } else {
            int mismatches = 0;
            for (int y = 80; y < 176; y++) {
                for (int x = 80; x < 176; x++)
                    mismatches += at(x, y)[0] != texels[((y - 32) * 192 + x - 32) * 4];
            }
            CHECK(mismatches == 0, "the unblurred backdrop differs in %d pixels", mismatches);
        }
        /* Outside the paint the checkerboard is untouched. */
        CHECK(at(41, 40)[0] == texels[(8 * 192 + 9) * 4], "the backdrop spilled outside its box");
    }
    render_shader_destroy(shader);
    gl_delete_texture(texture.name);
}

/* A filter recolors a texture as it is drawn. */
static void test_filter(struct renderer *renderer) {
    unsigned char texels[16 * 16 * 4];
    struct render_texture texture = {GL_TEXTURE_2D, pattern_texture(16, 16, texels, false), 16, 16,
                                     true};
    const char *const names[] = {"gain"};
    const int counts[] = {1};
    struct shader definition =
        define(STAGE_FILTER,
               "vec4 filter(vec4 color, vec2 position) {\n"
               "  return vec4(color.rgb * gain, color.a) * step(8.0, position.x);\n"
               "}\n",
               1, names, counts);
    struct render_shader *shader = render_shader_create(&definition);
    const float values[] = {0.5f};
    struct render_shading filter = {shader, values, {16, 16}, 0, 0, {0, 0}};
    struct box box = {0, 0, 16, 16};
    struct render_report report = {0};
    for (int i = 0; i < 2000; i++) {
        report = (struct render_report){0};
        begin(renderer);
        render_draw_texture(
            renderer, &texture,
            &(struct render_texture_draw){mat3_translation(30, 40), box, RENDER_FULL_UV, box, 0, 1},
            &filter, &report);
        finish(renderer);
        if (!report.building) break;
        usleep(1000);
    }
    CHECK(!report.building && !report.error, "filter did not run: %s",
          report.error ? report.error : "building");
    const unsigned char *p = at(30 + 12, 40 + 3), *texel = texels + (3 * 16 + 12) * 4;
    CHECK(near(p, texel[0] / 2, texel[1] / 2, texel[2] / 2, 255, 1), "filtered %d %d %d %d", p[0],
          p[1], p[2], p[3]);
    CHECK(at(30 + 3, 40 + 3)[3] == 0, "the filter's position is wrong");
    render_shader_destroy(shader);
    gl_delete_texture(texture.name);
}

static const char desaturate[] =
    "vec4 effect(vec2 position) {\n"
    "  vec4 color = content(position);\n"
    "  float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));\n"
    "  return vec4(mix(color.rgb, vec3(luma), amount) * gain, color.a);\n"
    "}\n";

static const char broken[] = "vec4 effect(vec2 position) {\n"
                             "  vec4 color = content(position);\n"
                             "  return color * undeclared_thing;\n"
                             "}\n";

static void test_effect(struct renderer *renderer) {
    const char *const names[] = {"amount", "gain"};
    const int counts[] = {1, 1};
    struct shader definition = define(STAGE_EFFECT, desaturate, 2, names, counts);
    struct render_shader *shader = render_shader_create(&definition);
    struct shader solid = define(STAGE_PAINT, solid_source, 1, solid_names, solid_counts);
    struct render_shader *red = render_shader_create(&solid);
    const float values[] = {1, 0.5f}, color[] = {1, 0, 0, 1};
    struct render_shading shading = {shader, values, {100, 100}, 0, 0, {-1e6, -1e6}};
    struct render_target *content = render_effect_target(renderer, 100, 100, RENDER_EFFECT_CONTENT);
    CHECK(content && content->width == 256, "effect target not stepped");
    if (!content) return;
    struct pixel_box area = {50, 50, 100, 100};
    struct render_effect_draw draw = {mat3_translation(50, 50), {0, 0, 100, 100}, 1};
    struct render_report report = {0};
    for (int i = 0; i < 2000; i++) {
        report = (struct render_report){0};
        begin(renderer);
        struct render_effect_scope scope;
        render_begin_effect(renderer, content, NULL, area, 50, 50, &scope);
        paint_box(renderer, red, 50, 50, 100, 100, color, 1);
        render_end_effect(renderer, &scope);
        render_draw_effect(renderer, &shading, &draw, content, NULL, area, 50, 50, &report);
        finish(renderer);
        if (!report.building) break;
        usleep(1000);
    }
    CHECK(!report.building && !report.error, "effect did not run: %s",
          report.error ? report.error : "building");
    int grey = (int)lround(0.2126 * 0.5 * 255);
    const unsigned char *p = at(100, 100);
    CHECK(near(p, grey, grey, grey, 255, 2), "desaturated %d %d %d %d (want %d)", p[0], p[1], p[2],
          p[3], grey);
    CHECK(at(40, 40)[3] == 0, "effect drew outside its area");

    /* Without its shader, an effect draws its content as it is. */
    begin(renderer);
    struct render_effect_scope scope;
    render_begin_effect(renderer, content, NULL, area, 50, 50, &scope);
    paint_box(renderer, red, 50, 50, 100, 100, color, 1);
    render_end_effect(renderer, &scope);
    render_draw_effect(renderer, NULL, &draw, content, NULL, area, 50, 50, NULL);
    finish(renderer);
    CHECK(near(at(100, 100), 255, 0, 0, 255, 1), "passthrough %d", at(100, 100)[0]);

    struct shader wrong = define(STAGE_EFFECT, broken, 0, NULL, NULL);
    struct render_shader *failing = render_shader_create(&wrong);
    shading.shader = failing;
    for (int i = 0; i < 2000; i++) {
        report = (struct render_report){0};
        begin(renderer);
        render_begin_effect(renderer, content, NULL, area, 50, 50, &scope);
        render_end_effect(renderer, &scope);
        render_draw_effect(renderer, &shading, &draw, content, NULL, area, 50, 50, &report);
        finish(renderer);
        if (!report.building) break;
        usleep(1000);
    }
    const char *error = report.error;
    CHECK(error && (strstr(error, "0:3(") || strstr(error, "0:3:")), "error not on line 3: %s",
          error ? error : "(none)");
    if (error) printf("broken effect: %s\n", error);
    render_shader_destroy(shader);
    render_shader_destroy(red);
    render_shader_destroy(failing);
}

int main(void) {
    if (!make_context()) {
        fprintf(stderr, "No headless EGL context\n");
        return 77;
    }
    struct renderer *renderer = render_create();
    struct render_target *target = render_target_create(SIZE, SIZE, false);
    if (!renderer || !target) {
        fprintf(stderr, "Renderer setup failed\n");
        return 1;
    }
    struct gl_binding binding;
    render_target_bind(target, &binding);
    test_paint(renderer);
    test_ring(renderer);
    test_plane(renderer);
    test_texture(renderer);
    test_downscale(renderer);
    test_mipmap(renderer);
    test_backdrop(renderer);
    test_filter(renderer);
    test_effect(renderer);
    CHECK(glGetError() == GL_NO_ERROR, "GL error");
    gl_restore_binding(&binding);
    render_target_destroy(target);
    render_destroy(renderer);
    if (failures) {
        fprintf(stderr, "%d checks failed\n", failures);
        return 1;
    }
    printf("render tests passed\n");
    return 0;
}
