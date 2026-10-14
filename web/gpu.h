// The helper's GPU side: copies of CEF's shared textures into a small pool of
// GBM buffers per page, which the compositor imports and hands back with fences.
#pragma once
#include "dmabuf.h"
#include <gbm.h>
#include <vector>
#include <string>
struct WebGpuSlot {
    gbm_bo *bo = nullptr;
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    GLuint texture = 0, fbo = 0;
    web_buffer buffer = {};
    bool leased = false;
    int fence = -1;
    /* The frame it holds, as its view counts them; 0 for none known. */
    uint64_t frame = 0;
};
class WebGpu {
    int device = -1, next_token = 0;
    gbm_device *gbm = nullptr;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    GLuint source = 0, read_fbo = 0;
    /* The layouts this display draws into and samples page frames in, for the driver to
     * pick from: compressed ones cost far less to copy and draw a mostly clear page with. */
    std::vector<uint64_t> modifiers;

  public:
    std::string error;
    bool initialize();
    bool current();
    ~WebGpu();
    WebGpuSlot *take(std::vector<WebGpuSlot> &, int, int, int, int);
    bool blit(const web_buffer &, const int *, WebGpuSlot &, const int[4], double = 1, double = 0,
              int * = nullptr);
    bool send(WebGpuSlot &, int);
    void release(std::vector<WebGpuSlot> &, int, int);
    void clear(std::vector<WebGpuSlot> &);
};
