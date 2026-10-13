#include "gl.h"

#include <wlr/util/log.h>

#include "util.h"

GLuint gl_create_texture(int width, int height, const void *pixels, GLenum format) {
    GLuint texture = 0;
    glGenTextures(1, &texture);
    if (!texture) return 0;
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    gl_upload_texture(texture, width, height, pixels, format);
    return texture;
}

void gl_upload_texture(GLuint texture, int width, int height, const void *pixels, GLenum format) {
    glBindTexture(GL_TEXTURE_2D, texture);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
    /* GLES requires the internal format to match the pixel format. */
    glTexImage2D(GL_TEXTURE_2D, 0, (GLint)format, width, height, 0, format, GL_UNSIGNED_BYTE,
                 pixels);
    glBindTexture(GL_TEXTURE_2D, 0);
}

void gl_delete_texture(GLuint texture) {
    if (texture) glDeleteTextures(1, &texture);
}

struct render_target *render_target_create(int width, int height, bool mipmapped) {
    struct render_target *target = xcalloc(1, sizeof(*target));
    *target = (struct render_target){.width = width, .height = height};
    target->texture = gl_create_texture(width, height, NULL, GL_RGBA);
    if (!target->texture) {
        wlr_log(WLR_ERROR, "Cannot create a %dx%d render target texture", width, height);
        free(target);
        return NULL;
    }
    if (mipmapped) {
        glBindTexture(GL_TEXTURE_2D, target->texture);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
        glBindTexture(GL_TEXTURE_2D, 0);
    }
    GLint previous = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &previous);
    glGenFramebuffers(1, &target->framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, target->framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target->texture, 0);
    GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)previous);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
        wlr_log(WLR_ERROR, "Render target %dx%d is incomplete (0x%x)", width, height, status);
        render_target_destroy(target);
        return NULL;
    }
    return target;
}

void render_target_destroy(struct render_target *target) {
    if (!target) return;
    if (target->framebuffer) glDeleteFramebuffers(1, &target->framebuffer);
    gl_delete_texture(target->texture);
    free(target);
}

void render_target_generate_mipmaps(const struct render_target *target) {
    glBindTexture(GL_TEXTURE_2D, target->texture);
    glGenerateMipmap(GL_TEXTURE_2D);
    glBindTexture(GL_TEXTURE_2D, 0);
}

void gl_save_binding(struct gl_binding *saved) {
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &saved->framebuffer);
    glGetIntegerv(GL_VIEWPORT, saved->viewport);
}

void gl_restore_binding(const struct gl_binding *saved) {
    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)saved->framebuffer);
    glViewport(saved->viewport[0], saved->viewport[1], saved->viewport[2], saved->viewport[3]);
}

void render_target_bind(const struct render_target *target, struct gl_binding *saved) {
    if (saved) gl_save_binding(saved);
    glBindFramebuffer(GL_FRAMEBUFFER, target->framebuffer);
    glViewport(0, 0, target->width, target->height);
}

void render_target_bind_offset(const struct render_target *target, int x, int y, int buffer_width,
                               int buffer_height, struct gl_binding *saved) {
    gl_save_binding(saved);
    glBindFramebuffer(GL_FRAMEBUFFER, target->framebuffer);
    glViewport(-x, -y, buffer_width, buffer_height);
}

void gl_copy_framebuffer(const struct render_target *target, int x, int y, int width, int height,
                         int source_x, int source_y) {
    glBindTexture(GL_TEXTURE_2D, target->texture);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, x, y, source_x, source_y, width, height);
    glBindTexture(GL_TEXTURE_2D, 0);
}

void gl_read_pixels(int x, int y, int width, int height, void *pixels) {
    GLint alignment = 4;
    glGetIntegerv(GL_PACK_ALIGNMENT, &alignment);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(x, y, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    glPixelStorei(GL_PACK_ALIGNMENT, alignment);
}
