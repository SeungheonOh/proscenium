/*
 * Frames as dma-bufs: the descriptor that travels with each frame, importing one
 * as an EGLImage, and the native fences each side hands the other. Shared by the
 * compositor (C) and the helper (C++); both call these with an EGL context current.
 */
#pragma once

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <stdint.h>
#include <unistd.h>

#define WEB_PLANES 4

/*
 * A frame of page ID's LAYER (0 the page, 1 its popup). TOKEN names the helper's
 * buffer, so the compositor can keep its import while the helper reuses it.
 * DAMAGE is where the frame differs from the one the helper sent before it: x,
 * y, width and height in buffer pixels from the top left, empty for none. TAG is
 * the number the page marked the frame with (tagFrames in proscenium/page), for a
 * page whose node waits for it; 0 for none.
 */
struct web_buffer {
    int id, layer, token, width, height, planes;
    int damage[4];
    int tag;
    uint32_t format, stride[WEB_PLANES], offset[WEB_PLANES];
    uint64_t modifier;
};

/*
 * Frame descriptors are SCM_RIGHTS-owned by the receiver. Never send CEF's
 * ephemeral descriptors across the callback boundary.
 */
static inline EGLImageKHR web_import(EGLDisplay display, const struct web_buffer *b,
                                     const int *fds) {
    if (b->planes < 1 || b->planes > WEB_PLANES || b->width < 1 || b->height < 1)
        return EGL_NO_IMAGE_KHR;
    EGLint attrs[64];
    int n = 0;
    attrs[n++] = EGL_WIDTH;
    attrs[n++] = b->width;
    attrs[n++] = EGL_HEIGHT;
    attrs[n++] = b->height;
    attrs[n++] = EGL_LINUX_DRM_FOURCC_EXT;
    attrs[n++] = (EGLint)b->format;
    static const EGLint fd_key[] = {EGL_DMA_BUF_PLANE0_FD_EXT, EGL_DMA_BUF_PLANE1_FD_EXT,
                                    EGL_DMA_BUF_PLANE2_FD_EXT, EGL_DMA_BUF_PLANE3_FD_EXT};
    static const EGLint offset_key[] = {
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, EGL_DMA_BUF_PLANE1_OFFSET_EXT, EGL_DMA_BUF_PLANE2_OFFSET_EXT,
        EGL_DMA_BUF_PLANE3_OFFSET_EXT};
    static const EGLint pitch_key[] = {EGL_DMA_BUF_PLANE0_PITCH_EXT, EGL_DMA_BUF_PLANE1_PITCH_EXT,
                                       EGL_DMA_BUF_PLANE2_PITCH_EXT, EGL_DMA_BUF_PLANE3_PITCH_EXT};
    for (int p = 0; p < b->planes; p++) {
        attrs[n++] = fd_key[p];
        attrs[n++] = fds[p];
        attrs[n++] = offset_key[p];
        attrs[n++] = b->offset[p];
        attrs[n++] = pitch_key[p];
        attrs[n++] = b->stride[p];
        /* DRM_FORMAT_MOD_INVALID means the producer supplied no modifier. */
        if (b->modifier != UINT64_C(0x00ffffffffffffff)) {
            attrs[n++] = EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT + p * 2;
            attrs[n++] = (EGLint)b->modifier;
            attrs[n++] = EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT + p * 2;
            attrs[n++] = (EGLint)(b->modifier >> 32);
        }
    }
    attrs[n++] = EGL_NONE;
    PFNEGLCREATEIMAGEKHRPROC create =
        (PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
    return create ? create(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, NULL, attrs)
                  : EGL_NO_IMAGE_KHR;
}

static inline void web_destroy_image(EGLDisplay display, EGLImageKHR image) {
    if (image) ((PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR"))(display, image);
}

/* Back the bound GL_TEXTURE_2D with IMAGE. */
static inline void web_bind_image(EGLImageKHR image) {
    ((PFNGLEGLIMAGETARGETTEXTURE2DOESPROC)eglGetProcAddress("glEGLImageTargetTexture2DOES"))(
        GL_TEXTURE_2D, image);
}

/* A fence descriptor signalled once the GL commands issued so far complete; -1 on failure. */
static inline int web_export_fence(void) {
    PFNEGLCREATESYNCKHRPROC create = (PFNEGLCREATESYNCKHRPROC)eglGetProcAddress("eglCreateSyncKHR");
    PFNEGLDUPNATIVEFENCEFDANDROIDPROC dup =
        (PFNEGLDUPNATIVEFENCEFDANDROIDPROC)eglGetProcAddress("eglDupNativeFenceFDANDROID");
    PFNEGLDESTROYSYNCKHRPROC destroy =
        (PFNEGLDESTROYSYNCKHRPROC)eglGetProcAddress("eglDestroySyncKHR");
    if (!create || !dup || !destroy) return -1;
    EGLDisplay d = eglGetCurrentDisplay();
    EGLSyncKHR sync = create(d, EGL_SYNC_NATIVE_FENCE_ANDROID, NULL);
    if (!sync) return -1;
    glFlush();
    int fd = dup(d, sync);
    destroy(d, sync);
    return fd;
}

/* Make the GPU wait for fence FD, which this takes; nonzero on success. */
static inline int web_wait_fence(int fd) {
    if (fd < 0) return 1;
    EGLDisplay d = eglGetCurrentDisplay();
    EGLint attrs[] = {EGL_SYNC_NATIVE_FENCE_FD_ANDROID, fd, EGL_NONE};
    EGLSyncKHR sync = ((PFNEGLCREATESYNCKHRPROC)eglGetProcAddress("eglCreateSyncKHR"))(
        d, EGL_SYNC_NATIVE_FENCE_ANDROID, attrs);
    if (!sync) {
        close(fd);
        return 0;
    }
    /* EGL owns FD after a successful import. */
    EGLBoolean ok = ((PFNEGLWAITSYNCKHRPROC)eglGetProcAddress("eglWaitSyncKHR"))(d, sync, 0);
    ((PFNEGLDESTROYSYNCKHRPROC)eglGetProcAddress("eglDestroySyncKHR"))(d, sync);
    return ok;
}
