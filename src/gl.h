/*
 * Offscreen GLES objects owned by the renderer: uploaded textures, render
 * targets for backdrop blur, effects and mipmaps, framebuffer copies and
 * readback.
 *
 * Call only with the compositor's EGL context current. Every function that
 * rebinds the framebuffer or viewport saves the previous binding for
 * gl_restore_binding.
 */
#pragma once

#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <stdbool.h>

/* A texture with linear filtering and clamped edges; PIXELS may be NULL. 0 on failure. */
GLuint gl_create_texture(int width, int height, const void *pixels, GLenum format);
/*
 * Replace TEXTURE's contents with tightly packed 8-bit PIXELS in FORMAT, GL_RGBA
 * or GL_BGRA_EXT (which wlroots' GLES2 renderer requires anyway).
 */
void gl_upload_texture(GLuint texture, int width, int height, const void *pixels, GLenum format);
void gl_delete_texture(GLuint texture);

/* A texture with a framebuffer drawing into it. */
struct render_target {
    GLuint texture, framebuffer;
    int width, height;
};

/*
 * A WIDTH x HEIGHT RGBA target, or NULL when the driver cannot make one. A
 * MIPMAPPED target samples trilinearly once render_target_generate_mipmaps has
 * filled its levels.
 */
struct render_target *render_target_create(int width, int height, bool mipmapped);
void render_target_destroy(struct render_target *target);
/* Fill the smaller levels of TARGET's texture from what is drawn in it. */
void render_target_generate_mipmaps(const struct render_target *target);

/* The framebuffer and viewport to return to after drawing into a target. */
struct gl_binding {
    GLint framebuffer;
    GLint viewport[4];
};

void gl_save_binding(struct gl_binding *saved);
void gl_restore_binding(const struct gl_binding *saved);
/* Draw into TARGET with a viewport covering it, saving the previous binding unless SAVED is
 * NULL. */
void render_target_bind(const struct render_target *target, struct gl_binding *saved);
/*
 * Draw into TARGET as into a BUFFER_WIDTH x BUFFER_HEIGHT buffer whose pixel
 * (X, Y) is TARGET's first, saving the previous binding.
 */
void render_target_bind_offset(const struct render_target *target, int x, int y, int buffer_width,
                               int buffer_height, struct gl_binding *saved);

/*
 * Copy WIDTH x HEIGHT pixels at (SOURCE_X, SOURCE_Y) of the bound framebuffer
 * to (X, Y) of TARGET's texture.
 */
void gl_copy_framebuffer(const struct render_target *target, int x, int y, int width, int height,
                         int source_x, int source_y);
/*
 * Read the bound framebuffer's WIDTH x HEIGHT RGBA pixels at (X, Y) into PIXELS,
 * rows tightly packed, first row first.
 */
void gl_read_pixels(int x, int y, int width, int height, void *pixels);
