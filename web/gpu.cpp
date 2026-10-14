#include "gpu.h"
#include "protocol.h"
#include <fcntl.h>
#include <filesystem>
#include <cstdlib>
#include <cstdio>
#include <cmath>
#include <drm_fourcc.h>
bool WebGpu::current() {
    return display != EGL_NO_DISPLAY &&
           eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context);
}
bool WebGpu::initialize() {
    std::string path;
    if (auto p = getenv("PROSCENIUM_WEB_RENDER_NODE")) path = p;
    else {
        std::error_code ec;
        for (auto &p : std::filesystem::directory_iterator("/dev/dri", ec))
            if (p.path().filename().string().starts_with("renderD")) {
                path = p.path();
                break;
            }
    }
    device = open(path.c_str(), O_RDWR | O_CLOEXEC);
    if (device < 0) {
        error = "No accessible DRM render node";
        return false;
    }
    gbm = gbm_create_device(device);
    if (!gbm) {
        error = "Cannot create GBM device";
        return false;
    }
    auto platform = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    display = platform(EGL_PLATFORM_GBM_KHR, gbm, nullptr);
    if (!eglInitialize(display, nullptr, nullptr)) {
        error = "Cannot initialize GBM EGL";
        return false;
    }
    auto extensions = eglQueryString(display, EGL_EXTENSIONS);
    if (!extensions || !strstr(extensions, "EGL_EXT_image_dma_buf_import_modifiers") ||
        !strstr(extensions, "EGL_ANDROID_native_fence_sync") ||
        !strstr(extensions, "EGL_KHR_wait_sync")) {
        error = "DMA-BUF modifiers/native fence support unavailable";
        return false;
    }
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    context = eglCreateContext(display, nullptr, EGL_NO_CONTEXT, attrs);
    if (!current()) {
        error = "Cannot create surfaceless GLES3 context";
        return false;
    }
    glGenTextures(1, &source);
    glGenFramebuffers(1, &read_fbo);
    return true;
}
void WebGpu::clear(std::vector<WebGpuSlot> &pool) {
    if (!current()) return;
    for (auto &s : pool) {
        if (s.fence >= 0) close(s.fence);
        if (s.fbo) glDeleteFramebuffers(1, &s.fbo);
        if (s.texture) glDeleteTextures(1, &s.texture);
        web_destroy_image(display, s.image);
        if (s.bo) gbm_bo_destroy(s.bo);
    }
    pool.clear();
}
WebGpu::~WebGpu() {
    if (current()) {
        glDeleteTextures(1, &source);
        glDeleteFramebuffers(1, &read_fbo);
        eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }
    if (context) eglDestroyContext(display, context);
    if (display) eglTerminate(display);
    if (gbm) gbm_device_destroy(gbm);
    if (device >= 0) close(device);
}
WebGpuSlot *WebGpu::take(std::vector<WebGpuSlot> &pool, int width, int height, int id, int layer) {
    if (width < 1 || height < 1 || width > WEB_MAX_SIDE || height > WEB_MAX_SIDE) {
        error = "Scaled popup exceeds DMA-BUF limits";
        return nullptr;
    }
    if (!current()) {
        error = "Lost browser EGL context";
        return nullptr;
    }
    WebGpuSlot *out = nullptr;
    for (auto &s : pool)
        if (!s.leased) {
            out = &s;
            break;
        }
    if (!out) {
        if (pool.size() >= 3) return nullptr;
        pool.emplace_back();
        out = &pool.back();
    }
    auto &s = *out;
    if (s.fence >= 0) {
        int fd = s.fence;
        s.fence = -1;
        if (!web_wait_fence(fd)) {
            error = "Cannot import consumer release fence";
            return nullptr;
        }
    }
    if (!s.bo || s.buffer.width != width || s.buffer.height != height) {
        if (s.fbo) glDeleteFramebuffers(1, &s.fbo);
        if (s.texture) glDeleteTextures(1, &s.texture);
        web_destroy_image(display, s.image);
        if (s.bo) gbm_bo_destroy(s.bo);
        s = {};
        s.bo = gbm_bo_create(gbm, width, height, DRM_FORMAT_ABGR8888, GBM_BO_USE_RENDERING);
        if (!s.bo) {
            error = "Cannot allocate browser DMA-BUF";
            return nullptr;
        }
        s.buffer.id = id;
        s.buffer.layer = layer;
        s.buffer.token = ++next_token;
        s.buffer.width = width;
        s.buffer.height = height;
        s.buffer.planes = gbm_bo_get_plane_count(s.bo);
        s.buffer.format = gbm_bo_get_format(s.bo);
        s.buffer.modifier = gbm_bo_get_modifier(s.bo);
        int planes[WEB_PLANES];
        for (int p = 0; p < s.buffer.planes; p++) {
            planes[p] = gbm_bo_get_fd_for_plane(s.bo, p);
            s.buffer.stride[p] = gbm_bo_get_stride_for_plane(s.bo, p);
            s.buffer.offset[p] = gbm_bo_get_offset(s.bo, p);
        }
        s.image = web_import(display, &s.buffer, planes);
        for (int p = 0; p < s.buffer.planes; p++) close(planes[p]);
        if (!s.image) {
            error = "Cannot import owned browser DMA-BUF";
            return nullptr;
        }
        glGenTextures(1, &s.texture);
        glBindTexture(GL_TEXTURE_2D, s.texture);
        web_bind_image(s.image);
        glGenFramebuffers(1, &s.fbo);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, s.fbo);
        glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s.texture,
                               0);
        if (glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            error = "Owned DMA-BUF is not renderable";
            return nullptr;
        }
    }
    return &s;
}
/*
 * The number a page marks its frames with: two cells of 2 x 2 CSS pixels at its top left,
 * the first coloring the number's three hex digits n as n * 16 + 8 in red, green and blue,
 * the second their complements, so a page's own pixels there read as no number. -1 when
 * they do not.
 */
static int decode_tag(const unsigned char first[4], const unsigned char second[4]) {
    int tag = 0;
    for (int channel = 0; channel < 3; channel++) {
        int digit = first[channel] / 16;
        if (digit + second[channel] / 16 != 15) return -1;
        tag = tag * 16 + digit;
    }
    return tag;
}

bool WebGpu::blit(const web_buffer &input, const int *fds, WebGpuSlot &s, const int area[4],
                  double scale, double tag_scale, int *tag) {
    // Nothing changed since the frame the slot holds: it is that frame already.
    if (area[2] < 1 || area[3] < 1) return true;
    auto image = web_import(display, &input, fds);
    if (!image) {
        error = "Cannot import CEF DMA-BUF";
        return false;
    }
    glBindTexture(GL_TEXTURE_2D, source);
    web_bind_image(image);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, read_fbo);
    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, source, 0);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, s.fbo);
    bool valid = glCheckFramebufferStatus(GL_READ_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    if (valid) {
        // Both buffers keep rows top first, so frame rectangles need no flip.
        int left = area[0], top = area[1], right = area[0] + area[2], bottom = area[1] + area[3];
        glBlitFramebuffer(left, top, right, bottom, (int)std::lround(left * scale),
                          (int)std::lround(top * scale), (int)std::lround(right * scale),
                          (int)std::lround(bottom * scale), GL_COLOR_BUFFER_BIT,
                          scale == 1 ? GL_NEAREST : GL_LINEAR);
        valid = glGetError() == GL_NO_ERROR;
    }
    if (valid && tag) {
        // The cells' middles, in the frame's pixels at TAG_SCALE pixels per CSS pixel.
        unsigned char cells[2][4] = {};
        int middle = (int)tag_scale;
        glReadPixels(middle, middle, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, cells[0]);
        glReadPixels((int)(3 * tag_scale), middle, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, cells[1]);
        *tag = decode_tag(cells[0], cells[1]);
        // The cells are the helper's to read, not the page's to show.
        glEnable(GL_SCISSOR_TEST);
        glScissor(0, 0, (int)std::ceil(4 * tag_scale * scale),
                  (int)std::ceil(2 * tag_scale * scale));
        glClearColor(0, 0, 0, 0);
        glClear(GL_COLOR_BUFFER_BIT);
        glDisable(GL_SCISSOR_TEST);
        valid = glGetError() == GL_NO_ERROR;
    }
    // CEF reuses its source as soon as OnAcceleratedPaint returns. Complete the
    // copy in the isolated helper; the compositor never waits for this work.
    glFinish();
    web_destroy_image(display, image);
    if (!valid) error = "CEF DMA-BUF copy failed";
    return valid;
}
bool WebGpu::send(WebGpuSlot &s, int socket) {
    int fds[WEB_PLANES];
    for (int p = 0; p < s.buffer.planes; p++) fds[p] = gbm_bo_get_fd_for_plane(s.bo, p);
    iovec io{&s.buffer, sizeof s.buffer};
    char control[CMSG_SPACE(sizeof fds)] = {};
    msghdr msg = {};
    msg.msg_iov = &io;
    msg.msg_iovlen = 1;
    msg.msg_control = control;
    msg.msg_controllen = CMSG_SPACE(sizeof(int) * s.buffer.planes);
    auto c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int) * s.buffer.planes);
    memcpy(CMSG_DATA(c), fds, sizeof(int) * s.buffer.planes);
    bool ok = sendmsg(socket, &msg, MSG_NOSIGNAL | MSG_DONTWAIT) == sizeof s.buffer;
    for (int p = 0; p < s.buffer.planes; p++) close(fds[p]);
    if (ok) s.leased = true;
    return ok;
}
void WebGpu::release(std::vector<WebGpuSlot> &pool, int token, int fence) {
    for (auto &s : pool)
        if (s.buffer.token == token) {
            if (s.fence >= 0) close(s.fence);
            s.fence = fence;
            s.leased = false;
            return;
        }
    if (fence >= 0) close(fence);
}
