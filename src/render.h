/*
 * Direct GLES renderer for display items.
 *
 * Every primitive draws through a struct mat3 mapping the item's local units to
 * buffer pixels, so rotation, zoom and perspective keep corners, borders and
 * texture filtering exact. Everything but textures is drawn by the director's
 * shaders (shader.h), evaluated in local units. Colors are premultiplied RGBA
 * in 0..1.
 *
 * GL state: the caller makes the EGL context current and binds the frame's
 * framebuffer; render_begin_frame sets the viewport, premultiplied blending and
 * the scissor test, and render_finish_frame disables the scissor test and the
 * vertex arrays again. Blending stays enabled, as wlroots sets its own per draw.
 * Buffer pixel (0, 0) is GL window pixel (0, 0): rows run in buffer order, as
 * they lie in memory.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "geometry.h"
#include "gl.h"

struct renderer;

/* A texture to sample: GL_TEXTURE_2D or GL_TEXTURE_EXTERNAL_OES, WIDTH x HEIGHT texels. */
struct render_texture {
    GLenum target;
    GLuint name;
    int width, height;
    /* False for formats without alpha, whose alpha channel is ignored. */
    bool has_alpha;
};

/*
 * A client buffer's texture. SOURCE and GENERATION identify its content: a
 * mipmapped copy is remade when either changes.
 */
struct render_surface {
    struct render_texture texture;
    const void *source;
    uint64_t generation;
};

/* Texture coordinates of the top-left, top-right, bottom-left and bottom-right corners. */
extern const double RENDER_FULL_UV[8];

/* Compile the programs; NULL when the context cannot run them. */
struct renderer *render_create(void);
/* Free every program, texture and target; the context must be current. */
void render_destroy(struct renderer *renderer);

/*
 * Start drawing a WIDTH x HEIGHT buffer into the bound framebuffer: reset the
 * viewport, blending, scissor (to the whole buffer) and the frame's spare time.
 */
void render_begin_frame(struct renderer *renderer, int width, int height);
/* Limit drawing to buffer pixels (X, Y, WIDTH, HEIGHT) of the bound target. */
void render_set_scissor(struct renderer *renderer, int x, int y, int width, int height);
/* Fill the scissor rectangle with a premultiplied color. */
void render_clear(struct renderer *renderer, double red, double green, double blue, double alpha);
/*
 * Hand the GPU the commands recorded so far, at most every millisecond, so it
 * draws while the frame is still being recorded. Call between items.
 */
void render_submit(struct renderer *renderer);
/* End the frame: scissor and vertex arrays off, commands flushed, GL errors logged. */
void render_finish_frame(struct renderer *renderer);

/*
 * Whether this frame has time left (of 3 ms) for work that could wait, such as
 * rasterizing text or making mipmaps: a burst of it spreads over frames.
 */
bool render_spare_time(const struct renderer *renderer);
/* Charge the time since SINCE (now_seconds()) to this frame's spare time. */
void render_spend_spare_time(struct renderer *renderer, double since);

/* A shader of the registry (shader.h), as the renderer builds it. */
struct shader;
struct render_shader;

/*
 * Start building SHADER's program on the driver's threads, where it has them:
 * a paint's or an effect's, or a filter's over ordinary textures (external
 * images get theirs when first drawn).
 */
struct render_shader *render_shader_create(const struct shader *shader);
void render_shader_destroy(struct render_shader *shader);

/* What a shader draws with: its uniforms and what it sees of its node. */
struct render_shading {
    struct render_shader *shader;
    /* Its uniforms, flattened in declaration order. */
    const float *values;
    /* The node's box and corner radius, the shading's clock, and the pointer, in local units. */
    double size[2], radius, time, pointer[2];
};

/* Whether SHADER's program is built and ran, so what it draws can be relied on. */
bool render_shader_ready(const struct render_shader *shader);

/* What became of the shader a draw asked for. */
struct render_report {
    /* Its program finished building just now. */
    bool built;
    /* Its program is still building. */
    bool building;
    /* It failed to build, compile log lines counted from the source's first. */
    const char *error;
};

/*
 * Drawn small, a texture is box filtered over one output pixel's footprint: a
 * minified window keeps its text legible instead of shimmering under a single
 * bilinear tap.
 */
struct render_texture_draw {
    /* Local units to buffer pixels, and the local box drawn. */
    struct mat3 transform;
    struct box box;
    /* Texture coordinates of the box's top-left, top-right, bottom-left and bottom-right. */
    const double *uv;
    /* Only MASK's corners are rounded, by RADIUS (0 for none): popups outside it are untouched. */
    struct box mask;
    double radius, opacity;
};

/*
 * Draw TEXTURE, through FILTER's shader unless it is NULL. False when the
 * texture's target has no program (external images on a context without
 * them). A filter that cannot run yet is left out, and REPORT says why.
 */
bool render_draw_texture(struct renderer *renderer, const struct render_texture *texture,
                         const struct render_texture_draw *draw,
                         const struct render_shading *filter, struct render_report *report);

/*
 * The texture of SLOT's half-size mipmapped copy of SURFACE, remade when its
 * source or generation changed while the frame has spare time; 0 while there is
 * none. Copies unused for two seconds go at render_sweep.
 */
GLuint render_surface_mipmap(struct renderer *renderer, uint64_t slot,
                             const struct render_surface *surface);
/* Keep SLOT's mipmap, if it has one, while a display showing its surface is built. */
void render_touch_mipmap(struct renderer *renderer, uint64_t slot);
/*
 * Draw a client surface as render_draw_texture does. Drawn at half size or less,
 * it is sampled once from a mipmapped copy kept under SLOT, unless SLOT is 0 or
 * the surface is under 64 pixels on a side.
 */
bool render_draw_surface(struct renderer *renderer, const struct render_surface *surface,
                         const struct render_texture_draw *draw,
                         const struct render_shading *filter, uint64_t slot,
                         struct render_report *report);

/* A texture the compositor uploads itself, such as rendered text or a decoded image. */
struct render_raster {
    GLuint texture;
    int width, height;
    uint64_t key;
    /* When last drawn or touched, and seconds it survives without that. */
    double used, lifetime;
    /*
     * The caller's, set to 0 and 1 by render_install_raster: text keeps here what
     * the key holds less the scale, and the scale it was rasterized at, so it can
     * show a raster at another scale until its own arrives.
     */
    uint64_t family;
    double scale;
};

/* The raster SLOT holds, whatever its key; valid until render_sweep. */
struct render_raster *render_slot_raster(struct renderer *renderer, uint64_t slot);
/*
 * Upload PIXELS, WIDTH x HEIGHT tightly packed in FORMAT (GL_RGBA or
 * GL_BGRA_EXT, premultiplied), as SLOT's raster, now holding KEY.
 */
struct render_raster *render_install_raster(struct renderer *renderer, uint64_t slot, uint64_t key,
                                            const void *pixels, int width, int height,
                                            GLenum format);
/* Makes SLOT's raster for KEY with render_install_raster, or declines. */
typedef void (*render_raster_producer)(struct renderer *renderer, uint64_t slot, uint64_t key,
                                       void *data);
/*
 * The raster in SLOT holding KEY, kept LIFETIME seconds past its last use. When
 * SLOT holds anything else, PRODUCER (if any) is called first; NULL while none
 * holds KEY.
 */
struct render_raster *render_raster(struct renderer *renderer, uint64_t slot, uint64_t key,
                                    double lifetime, render_raster_producer producer, void *data);
/* Mark SLOT's raster, if any, used now. */
void render_touch_raster(struct renderer *renderer, uint64_t slot);
/*
 * Delete rasters unused for their lifetime before NOW; blur chains, effect
 * targets and mipmaps unused for two seconds.
 */
void render_sweep(struct renderer *renderer, double now);
/* Draw RASTER as render_draw_texture does. */
void render_draw_raster(struct renderer *renderer, const struct render_raster *raster,
                        const struct render_texture_draw *draw, const struct render_shading *filter,
                        struct render_report *report);

/* How far beyond what it blurs a backdrop blur of RADIUS output pixels samples; a blur of
 * under a pixel reads the backdrop as it is. */
int render_blur_margin(double radius);

/* What a paint covers. */
struct render_paint_draw {
    /* Local units to buffer pixels. */
    struct mat3 transform;
    /* The local area it draws: its node's box grown by its extent. */
    struct box quad;
    /* Inside HOLE, when HOLED, it draws nothing, as a border alone or a shadow under an
     * opaque fill: it is drawn as a ring. */
    bool holed;
    struct box hole;
    /* It covers the whole target, its plane placed by TRANSFORM, instead of QUAD. */
    bool plane;
    double opacity;
    /* For a paint reading its backdrop: the buffer area it reads, and the blur, in
     * output pixels, of what it reads there. */
    struct pixel_box area;
    double blur;
};

/*
 * Paint through SHADING's paint shader. False, with REPORT saying why, while
 * its program builds or once it failed.
 */
bool render_draw_paint(struct renderer *renderer, const struct render_shading *shading,
                       const struct render_paint_draw *draw, struct render_report *report);

enum render_effect_role {
    RENDER_EFFECT_CONTENT,
    RENDER_EFFECT_BACKDROP,
};

/*
 * A target of at least WIDTH x HEIGHT pixels, sizes stepped by 256, for an
 * effect's content or backdrop at the current nesting depth; NULL when the
 * driver cannot make one. Unused for two seconds, it goes at render_sweep.
 */
struct render_target *render_effect_target(struct renderer *renderer, int width, int height,
                                           enum render_effect_role role);

/* What render_end_effect restores. */
struct render_effect_scope {
    struct gl_binding binding;
    int depth, origin_x, origin_y;
    int scissor[4];
};

/*
 * Start drawing an effect's content into CONTENT, whose first pixel is buffer
 * pixel (ORIGIN_X, ORIGIN_Y): copy what is drawn so far in buffer AREA into
 * BACKDROP when given, bind CONTENT as if it were the whole buffer, nest one
 * level deeper, and clear AREA, which becomes the scissor, to transparent.
 */
void render_begin_effect(struct renderer *renderer, const struct render_target *content,
                         const struct render_target *backdrop, struct pixel_box area, int origin_x,
                         int origin_y, struct render_effect_scope *scope);
/* Return to the target, nesting and scissor render_begin_effect left. */
void render_end_effect(struct renderer *renderer, const struct render_effect_scope *scope);

/* What an effect covers: the local QUAD through TRANSFORM. */
struct render_effect_draw {
    struct mat3 transform;
    struct box quad;
    double opacity;
};

/*
 * Draw an effect's content through SHADING's effect shader within buffer AREA,
 * sampling CONTENT and BACKDROP (may be NULL), whose first pixel is buffer pixel
 * (ORIGIN_X, ORIGIN_Y). While the shader cannot run, as REPORT says, or with
 * SHADING NULL, the content is drawn as it is.
 */
void render_draw_effect(struct renderer *renderer, const struct render_shading *shading,
                        const struct render_effect_draw *draw, const struct render_target *content,
                        const struct render_target *backdrop, struct pixel_box area, int origin_x,
                        int origin_y, struct render_report *report);
