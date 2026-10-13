// Proscenium's web helper: Chromium (CEF) rendering pages offscreen for the
// compositor (src/web.c). Commands arrive over --proscenium-command-fd; frames go
// back over it as dma-bufs (with a Wayland display) or into each page's shared
// memory as bitmaps, and --proscenium-wake-fd wakes the compositor for them.
#include "protocol.h"
#include "gpu.h"
#include <drm_fourcc.h>
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_parser.h"
#include "include/cef_scheme.h"
#include "include/cef_task.h"
#include "include/cef_v8.h"
#include "include/wrapper/cef_stream_resource_handler.h"
#include <sys/mman.h>
#include <sys/prctl.h>
#include <fcntl.h>
#include <signal.h>
#include <algorithm>
#include <filesystem>
#include <functional>
#include <map>
#include <thread>
#include <vector>
#include <cstdio>
#include <cmath>
#include <chrono>
#include <cstddef>
#include <string>
namespace fs = std::filesystem;
static int wake_fd = -1, command_fd = -1;
static bool stopping = false;
static WebGpu gpu;
static bool accelerated = false;
static bool want_acceleration() {
    auto p = getenv("PROSCENIUM_WEB_TRANSPORT");
    return (!p || strcmp(p, "bitmap")) && getenv("WAYLAND_DISPLAY");
}
class View;
static std::map<int, CefRefPtr<View>> views;
// A command as the UI thread acts on it: the wire form, keeping only the text it carries.
struct Command {
    int op, id, a, b, c, d;
    double scale;
    std::string text;
};
class Task final : public CefTask {
    std::function<void()> f;

  public:
    explicit Task(std::function<void()> fn) : f(std::move(fn)) {}
    void Execute() override {
        f();
    }
    IMPLEMENT_REFCOUNTING(Task);
};
static void post(std::function<void()> f) {
    CefPostTask(TID_UI, new Task(std::move(f)));
}
class Message final : public CefV8Handler {
  public:
    bool Execute(const CefString &, CefRefPtr<CefV8Value>, const CefV8ValueList &args,
                 CefRefPtr<CefV8Value> &, CefString &error) override {
        if (args.size() != 2 || !args[0]->IsString() || !args[1]->IsString()) {
            error = "Expected name and JSON string";
            return true;
        }
        auto name = args[0]->GetStringValue().ToString(),
             value = args[1]->GetStringValue().ToString();
        if (name.size() > 79 || value.size() > 8191) {
            error = "Proscenium message exceeds its bounded queue limits";
            return true;
        }
        auto message = CefProcessMessage::Create("proscenium-event");
        auto list = message->GetArgumentList();
        list->SetString(0, name);
        list->SetString(1, value);
        CefV8Context::GetCurrentContext()->GetFrame()->SendProcessMessage(PID_BROWSER, message);
        return true;
    }
    IMPLEMENT_REFCOUNTING(Message);
};
class App final : public CefApp, public CefRenderProcessHandler {
  public:
    CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
        return this;
    }
    void OnBeforeCommandLineProcessing(const CefString &, CefRefPtr<CefCommandLine> line) override {
        line->AppendSwitchWithValue("ozone-platform", want_acceleration() ? "wayland" : "headless");
        // CEF's GTK4 fallback still calls gdk_screen_get_default when a desktop
        // portal does not provide font settings. GTK3 supplies that API, including
        // in a compositor's first session and isolated portal tests.
        line->AppendSwitchWithValue("gtk-version", "3");
        line->AppendSwitch("disable-background-networking");
        line->AppendSwitch("disable-component-update");
        line->AppendSwitch("disable-sync");
        line->AppendSwitch("no-first-run");
        // Pages keep no secrets, and asking the desktop keyring would prompt to unlock it.
        line->AppendSwitchWithValue("password-store", "basic");
    }
    void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> r) override {
        r->AddCustomScheme("proscenium", CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                                             CEF_SCHEME_OPTION_CORS_ENABLED |
                                             CEF_SCHEME_OPTION_FETCH_ENABLED);
    }
    void OnContextCreated(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                          CefRefPtr<CefV8Context> context) override {
        if (!frame->IsMain()) return;
        context->GetGlobal()->SetValue("__prosceniumSend",
                                       CefV8Value::CreateFunction("__prosceniumSend", new Message),
                                       V8_PROPERTY_ATTRIBUTE_READONLY);
        CefRefPtr<CefV8Value> result;
        CefRefPtr<CefV8Exception> exception;
        // globalThis.proscenium and the "proscenium-message" event are the page API the
        // SDK's page runtime (sdk/src/page.ts) speaks.
        context->Eval(
            "Object.defineProperty(globalThis,'proscenium',{value:Object.freeze({postMessage(name,"
            "value){__prosceniumSend(String(name),(JSON.stringify(value)||'null'))}})})",
            frame->GetURL(), 0, result, exception);
    }
    IMPLEMENT_REFCOUNTING(App);
};
class Files final : public CefSchemeHandlerFactory {
    fs::path root;

  public:
    explicit Files(const fs::path &path) : root(fs::canonical(path)) {}
    CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>,
                                         const CefString &,
                                         CefRefPtr<CefRequest> request) override {
        CefURLParts parts;
        if (!CefParseURL(request->GetURL(), parts)) return nullptr;
        auto path = CefURIDecode(CefString(&parts.path), false,
                                 static_cast<cef_uri_unescape_rule_t>(
                                     UU_SPACES | UU_URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS |
                                     UU_PATH_SEPARATORS))
                        .ToString();
        if (path.empty() || path.back() == '/') path += "index.html";
        std::error_code ec;
        auto file = fs::weakly_canonical(root / fs::path(path).relative_path(), ec);
        auto relative = file.lexically_relative(root);
        if (ec || relative.empty() || *relative.begin() == ".." || !fs::is_regular_file(file, ec))
            return nullptr;
        auto stream = CefStreamReader::CreateForFile(file.string());
        if (!stream) return nullptr;
        auto ext = file.extension().string();
        if (!ext.empty()) ext.erase(0, 1);
        auto mime = CefGetMimeType(ext);
        if (mime.empty()) mime = "application/octet-stream";
        return new CefStreamResourceHandler(mime, stream);
    }
    IMPLEMENT_REFCOUNTING(Files);
};
class View final : public CefClient,
                   public CefRenderHandler,
                   public CefLifeSpanHandler,
                   public CefLoadHandler,
                   public CefRequestHandler,
                   public CefContextMenuHandler {
  public:
    int id, width, height;
    double scale;
    web_shared *shared;
    CefRefPtr<CefBrowser> browser;
    unsigned buttons = 0, modifiers = 0;
    int clicks = 0, last_button = 0, last_x = 0, last_y = 0;
    std::chrono::steady_clock::time_point last_click;
    bool visible = true, closing = false, loaded = false;
    std::vector<std::string> scripts;
    CefRect popup;
    std::vector<unsigned char> base, popup_pixels;
    int pixel_width = 0, pixel_height = 0, popup_width = 0, popup_height = 0;
    std::vector<Command> pending;
    std::vector<WebGpuSlot> pools[2];
    bool refresh[2] = {false, false};
    void release(int layer, int token, int fence) {
        if (layer < 0 || layer > 1) {
            if (fence >= 0) close(fence);
            return;
        }
        gpu.release(pools[layer], token, fence);
        if (refresh[layer] && browser && visible) {
            refresh[layer] = false;
            browser->GetHost()->Invalidate(layer ? PET_POPUP : PET_VIEW);
        }
    }
    void OnAcceleratedPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList &,
                            const CefAcceleratedPaintInfo &info) override {
        if (!visible || !accelerated) return;
        int layer = type == PET_POPUP;
        web_buffer input = {};
        input.width = info.extra.coded_size.width;
        input.height = info.extra.coded_size.height;
        input.planes = info.plane_count;
        input.modifier = info.modifier;
        input.format =
            info.format == CEF_COLOR_TYPE_RGBA_8888 ? DRM_FORMAT_ABGR8888 : DRM_FORMAT_ARGB8888;
        if (input.width < 1 || input.height < 1 || input.width > WEB_MAX_SIDE ||
            input.height > WEB_MAX_SIDE || input.planes < 1 || input.planes > WEB_PLANES) {
            emit("error", "\"Unsupported accelerated browser frame\"");
            return;
        }
        int fds[WEB_PLANES];
        for (int p = 0; p < input.planes; p++) {
            fds[p] = info.planes[p].fd;
            input.stride[p] = info.planes[p].stride;
            input.offset[p] = info.planes[p].offset;
        }
        auto slot = gpu.copy(input, fds, pools[layer], id, layer, layer ? scale : 1);
        if (!slot) {
            if (!gpu.error.empty()) {
                auto v = CefValue::Create();
                v->SetString(gpu.error);
                emit("error", CefWriteJSON(v, JSON_WRITER_DEFAULT));
            } else refresh[layer] = true;
            return;
        }
        // The frame wakes the compositor through the socket it travels on.
        if (!gpu.send(*slot, command_fd)) refresh[layer] = true;
    }
    View(int number, web_shared *memory, int w, int h, double ratio)
        : id(number), width(w), height(h), scale(ratio), shared(memory) {}
    ~View() override {
        gpu.clear(pools[0]);
        gpu.clear(pools[1]);
        munmap(shared, WEB_MAP_SIZE);
    }
    CefRefPtr<CefRenderHandler> GetRenderHandler() override {
        return this;
    }
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override {
        return this;
    }
    CefRefPtr<CefLoadHandler> GetLoadHandler() override {
        return this;
    }
    CefRefPtr<CefRequestHandler> GetRequestHandler() override {
        return this;
    }
    CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
        return this;
    }
    void OnBeforeContextMenu(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>,
                             CefRefPtr<CefContextMenuParams>,
                             CefRefPtr<CefMenuModel> model) override {
        model->Clear();
    }
    void GetViewRect(CefRefPtr<CefBrowser>, CefRect &rect) override {
        rect = CefRect(0, 0, accelerated ? (int)std::ceil(width * scale) : width,
                       accelerated ? (int)std::ceil(height * scale) : height);
    }
    bool GetScreenInfo(CefRefPtr<CefBrowser>, CefScreenInfo &info) override {
        info.device_scale_factor = accelerated ? 1 : scale;
        info.depth = 32;
        info.depth_per_component = 8;
        info.rect = info.available_rect =
            CefRect(0, 0, accelerated ? (int)std::ceil(width * scale) : width,
                    accelerated ? (int)std::ceil(height * scale) : height);
        return true;
    }
    void emit(const std::string &name, const std::string &value) {
        if (web_lock(shared, 0)) return;
        if (shared->event_write - shared->event_read < WEB_EVENTS && name.size() < 80 &&
            value.size() < 8192) {
            auto &event = shared->events[shared->event_write++ % WEB_EVENTS];
            strcpy(event.name, name.c_str());
            strcpy(event.value, value.c_str());
        }
        pthread_mutex_unlock(&shared->mutex);
        web_signal(wake_fd);
    }
    void publish(CefRect rect) {
        if (base.empty() || !visible) return;
        int x = std::clamp(rect.x, 0, pixel_width), y = std::clamp(rect.y, 0, pixel_height);
        int r = std::clamp(rect.x + rect.width, 0, pixel_width),
            b = std::clamp(rect.y + rect.height, 0, pixel_height);
        if (web_lock(shared, 0)) return;
        bool resize = shared->width != pixel_width || shared->height != pixel_height;
        if (resize) {
            x = y = 0;
            r = pixel_width;
            b = pixel_height;
        }
        for (int row = y; row < b; row++)
            for (int col = x; col < r; col++) {
                size_t offset = ((size_t)row * pixel_width + col) * 4;
                const unsigned char *p = &base[offset];
                unsigned char blend[4];
                int px = col - (int)std::round(popup.x * scale),
                    py = row - (int)std::round(popup.y * scale);
                if (!popup_pixels.empty() && px >= 0 && py >= 0 && px < popup_width &&
                    py < popup_height) {
                    const auto *over = &popup_pixels[((size_t)py * popup_width + px) * 4];
                    unsigned a = 255 - over[3];
                    for (int k = 0; k < 4; k++) {
                        blend[k] = over[k] + (p[k] * a + 127) / 255;
                    }
                    p = blend;
                }
                auto *dst = shared->pixels + offset;
                dst[0] = p[2];
                dst[1] = p[1];
                dst[2] = p[0];
                dst[3] = p[3];
            }
        if (!shared->dirty || resize) {
            shared->x = x;
            shared->y = y;
            shared->right = r;
            shared->bottom = b;
        } else {
            shared->x = std::min(shared->x, x);
            shared->y = std::min(shared->y, y);
            shared->right = std::max(shared->right, r);
            shared->bottom = std::max(shared->bottom, b);
        }
        shared->width = pixel_width;
        shared->height = pixel_height;
        __atomic_store_n(&shared->dirty, 1, __ATOMIC_RELEASE);
        pthread_mutex_unlock(&shared->mutex);
        web_signal(wake_fd);
    }
    void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList &rects,
                 const void *buffer, int w, int h) override {
        if (accelerated) {
            emit("error", "\"CEF fell back to bitmap paint in DMA-BUF mode\"");
            return;
        }
        if (w < 1 || h < 1 || w > WEB_MAX_SIDE || h > WEB_MAX_SIDE) return;
        if (type == PET_POPUP) {
            popup_width = w;
            popup_height = h;
            popup_pixels.assign((const unsigned char *)buffer,
                                (const unsigned char *)buffer + (size_t)w * h * 4);
            publish(CefRect(0, 0, pixel_width, pixel_height));
            return;
        }
        bool resize = w != pixel_width || h != pixel_height;
        pixel_width = w;
        pixel_height = h;
        if (resize) {
            base.assign((const unsigned char *)buffer,
                        (const unsigned char *)buffer + (size_t)w * h * 4);
            publish(CefRect(0, 0, w, h));
            return;
        }
        CefRect dirty(w, h, 0, 0);
        int right = 0, bottom = 0;
        for (const auto &rect : rects) {
            int x = std::clamp(rect.x, 0, w), y = std::clamp(rect.y, 0, h),
                r = std::clamp(rect.x + rect.width, 0, w),
                b = std::clamp(rect.y + rect.height, 0, h);
            for (int row = y; row < b; row++) {
                size_t off = ((size_t)row * w + x) * 4;
                memcpy(base.data() + off, (const unsigned char *)buffer + off, (r - x) * 4);
            }
            dirty.x = std::min(dirty.x, x);
            dirty.y = std::min(dirty.y, y);
            right = std::max(right, r);
            bottom = std::max(bottom, b);
        }
        dirty.width = right - dirty.x;
        dirty.height = bottom - dirty.y;
        if (dirty.width > 0 && dirty.height > 0) publish(dirty);
    }
    void OnPopupShow(CefRefPtr<CefBrowser>, bool show) override {
        if (accelerated) {
            __atomic_store_n(&shared->popup_visible, show, __ATOMIC_RELEASE);
            __atomic_store_n(&shared->dirty, 1, __ATOMIC_RELEASE);
            web_signal(wake_fd);
        } else if (!show) {
            popup_pixels.clear();
            publish(CefRect(0, 0, pixel_width, pixel_height));
        }
    }
    void OnPopupSize(CefRefPtr<CefBrowser>, const CefRect &rect) override {
        popup = rect;
        __atomic_store_n(&shared->popup_x, (int)std::round(rect.x * (accelerated ? 1 : scale)),
                         __ATOMIC_RELEASE);
        __atomic_store_n(&shared->popup_y, (int)std::round(rect.y * (accelerated ? 1 : scale)),
                         __ATOMIC_RELEASE);
    }
    // Wayland OSR uses native screen scale for its view surface. Supply a physical
    // view and logical emulation metrics so each drawable can have its own scale.
    // This is a local CEF call, with no remote debugging endpoint.
    void update_metrics() {
        if (!accelerated || !browser || !loaded) return;
        auto params = CefDictionaryValue::Create();
        params->SetInt("width", width);
        params->SetInt("height", height);
        params->SetDouble("deviceScaleFactor", scale);
        params->SetDouble("scale", scale);
        params->SetBool("mobile", false);
        params->SetInt("screenWidth", width);
        params->SetInt("screenHeight", height);
        params->SetBool("dontSetVisibleSize", true);
        browser->GetHost()->ExecuteDevToolsMethod(0, "Emulation.setDeviceMetricsOverride", params);
    }
    void OnAfterCreated(CefRefPtr<CefBrowser> b) override {
        browser = b;
        browser->GetHost()->WasHidden(!visible);
        // The compositor may close a page while CreateBrowser is still queued. CEF
        // finishes wiring the host after this callback; closing it synchronously
        // here destroys state that CreateInternal still needs.
        if (closing) {
            auto host = browser->GetHost();
            post([host] { host->CloseBrowser(true); });
            return;
        }
        auto commands = std::move(pending);
        for (auto &c : commands) command(c);
    }
    void OnBeforeClose(CefRefPtr<CefBrowser>) override {
        browser = nullptr;
        views.erase(id);
        if (stopping && views.empty()) CefQuitMessageLoop();
    }
    bool OnBeforePopup(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, int, const CefString &url,
                       const CefString &, cef_window_open_disposition_t, bool,
                       const CefPopupFeatures &, CefWindowInfo &, CefRefPtr<CefClient> &,
                       CefBrowserSettings &, CefRefPtr<CefDictionaryValue> &, bool *) override {
        auto value = CefValue::Create();
        value->SetString(url);
        emit("open-url", CefWriteJSON(value, JSON_WRITER_DEFAULT));
        return true;
    }
    void OnLoadStart(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, TransitionType) override {
        if (frame->IsMain()) loaded = false;
    }
    void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int status) override {
        if (frame->IsMain()) {
            loaded = true;
            update_metrics();
            auto queued = std::move(scripts);
            for (auto &code : queued) frame->ExecuteJavaScript(code, frame->GetURL(), 0);
            emit("load", std::to_string(status));
        }
    }
    void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, ErrorCode code,
                     const CefString &text, const CefString &) override {
        if (frame->IsMain() && code != ERR_ABORTED) {
            auto v = CefValue::Create();
            v->SetString(text);
            emit("error", CefWriteJSON(v, JSON_WRITER_DEFAULT));
        }
    }
    void OnRenderProcessTerminated(CefRefPtr<CefBrowser>, TerminationStatus, int,
                                   const CefString &text) override {
        loaded = false;
        auto v = CefValue::Create();
        v->SetString(text);
        emit("error", CefWriteJSON(v, JSON_WRITER_DEFAULT));
    }
    bool OnProcessMessageReceived(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, CefProcessId,
                                  const CefRefPtr<CefProcessMessage> message) override {
        if (message->GetName() != "proscenium-event" || !frame->IsMain()) return false;
        auto args = message->GetArgumentList();
        emit(args->GetString(0), args->GetString(1));
        return true;
    }
    void command(const Command &c) {
        if (c.op == WEB_CLOSE) {
            closing = true;
            if (browser) browser->GetHost()->CloseBrowser(true);
            return;
        }
        if (!browser) {
            if (pending.size() < 128) pending.push_back(c);
            else emit("error", "\"Browser startup command queue is full\"");
            return;
        }
        auto host = browser->GetHost();
        CefMouseEvent mouse;
        mouse.x = accelerated ? (int)std::round(c.a * scale) : c.a;
        mouse.y = accelerated ? (int)std::round(c.b * scale) : c.b;
        mouse.modifiers = buttons | modifiers;
        switch (c.op) {
        case WEB_RESIZE:
            width = c.a;
            height = c.b;
            scale = c.scale;
            update_metrics();
            host->NotifyScreenInfoChanged();
            host->WasResized();
            break;
        case WEB_VISIBLE:
            visible = c.a;
            host->WasHidden(!visible);
            if (visible) host->Invalidate(PET_VIEW);
            break;
        case WEB_MODIFIERS: modifiers = c.a; break;
        case WEB_FOCUS:
            host->SetFocus(c.a);
            if (!c.a) {
                buttons = 0;
                modifiers = 0;
            }
            break;
        case WEB_MOVE: host->SendMouseMoveEvent(mouse, c.c); break;
        case WEB_BUTTON: {
            auto button = c.c == 1 ? MBT_LEFT : c.c == 2 ? MBT_RIGHT : MBT_MIDDLE;
            unsigned flag = c.c == 1   ? EVENTFLAG_LEFT_MOUSE_BUTTON
                            : c.c == 2 ? EVENTFLAG_RIGHT_MOUSE_BUTTON
                                       : EVENTFLAG_MIDDLE_MOUSE_BUTTON;
            if (c.d) {
                auto now = std::chrono::steady_clock::now();
                bool again = c.c == last_button && std::abs(c.a - last_x) <= 3 &&
                             std::abs(c.b - last_y) <= 3 &&
                             now - last_click < std::chrono::milliseconds(500);
                clicks = again ? (clicks % 3 + 1) : 1;
                last_click = now;
                last_button = c.c;
                last_x = c.a;
                last_y = c.b;
                buttons |= flag;
            } else buttons &= ~flag;
            mouse.modifiers = buttons | modifiers;
            host->SendMouseClickEvent(mouse, button, !c.d, clicks);
            break;
        }
        case WEB_SCROLL: host->SendMouseWheelEvent(mouse, c.c, c.d); break;
        case WEB_KEY: {
            CefKeyEvent key;
            key.type = c.b ? KEYEVENT_RAWKEYDOWN : KEYEVENT_KEYUP;
            key.windows_key_code = c.a;
            key.native_key_code = c.c;
            key.modifiers = modifiers = c.d;
            auto chars = CefString(c.text).ToString16();
            if (!chars.empty()) {
                key.character = chars[0];
                key.unmodified_character = chars[0];
            }
            host->SendKeyEvent(key);
            break;
        }
        case WEB_TEXT_INPUT: {
            CefString str(c.text);
            auto chars = str.ToString16();
            for (char16_t ch : chars) {
                CefKeyEvent key;
                key.type = KEYEVENT_CHAR;
                key.character = ch;
                key.unmodified_character = ch;
                key.modifiers = modifiers;
                host->SendKeyEvent(key);
            }
            break;
        }
        case WEB_EVAL:
            if (loaded)
                browser->GetMainFrame()->ExecuteJavaScript(c.text,
                                                           browser->GetMainFrame()->GetURL(), 0);
            else if (scripts.size() < 128) scripts.emplace_back(c.text);
            else emit("error", "\"JavaScript startup queue is full\"");
            break;
        default: break;
        }
    }
    IMPLEMENT_REFCOUNTING(View);
};
static void stop() {
    if (stopping) return;
    stopping = true;
    auto copy = views;
    for (auto &[id, v] : copy) {
        v->command(Command{.op = WEB_CLOSE});
    }
    if (views.empty()) CefQuitMessageLoop();
}
static void receive() {
    // One wire buffer serves every command: each is copied out at its length.
    static web_command wire;
    constexpr ssize_t text_offset = offsetof(web_command, text);
    for (;;) {
        char control[CMSG_SPACE(sizeof(int))] = {};
        iovec io{&wire, sizeof wire};
        msghdr msg = {};
        msg.msg_iov = &io;
        msg.msg_iovlen = 1;
        msg.msg_control = control;
        msg.msg_controllen = sizeof control;
        ssize_t count = recvmsg(command_fd, &msg, MSG_CMSG_CLOEXEC);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            if (count < 0) fprintf(stderr, "Proscenium web helper receive: %s\n", strerror(errno));
            post(stop);
            return;
        }
        int fd = -1;
        for (auto *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
            if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS)
                memcpy(&fd, CMSG_DATA(c), sizeof fd);
        if ((msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) || count <= text_offset) {
            if (fd >= 0) close(fd);
            continue;
        }
        Command cmd{wire.op,    wire.id,
                    wire.a,     wire.b,
                    wire.c,     wire.d,
                    wire.scale, std::string(wire.text, strnlen(wire.text, count - text_offset))};
        post([cmd = std::move(cmd), fd] {
            if (cmd.op == WEB_CREATE && fd >= 0 && !stopping) {
                auto *s = (web_shared *)mmap(nullptr, WEB_MAP_SIZE, PROT_READ | PROT_WRITE,
                                             MAP_SHARED, fd, 0);
                close(fd);
                if (s == MAP_FAILED) return;
                s->accelerated = accelerated;
                CefRefPtr<View> view = new View(cmd.id, s, cmd.a, cmd.b, cmd.scale);
                views[cmd.id] = view;
                std::string config(cmd.text);
                auto split = config.find('\n');
                std::string root = config.substr(0, split), url = config.substr(split + 1);
                CefRequestContextSettings context_settings;
                auto context = CefRequestContext::CreateContext(context_settings, nullptr);
                try {
                    if (!root.empty())
                        context->RegisterSchemeHandlerFactory("proscenium", "ui", new Files(root));
                } catch (const std::exception &e) {
                    view->emit("error", std::string("\"Invalid asset root\""));
                    views.erase(cmd.id);
                    return;
                }
                CefWindowInfo window;
                window.SetAsWindowless(0);
                window.shared_texture_enabled = accelerated;
                CefBrowserSettings settings;
                settings.windowless_frame_rate = 60;
                settings.background_color = 0;
                if (!CefBrowserHost::CreateBrowser(window, view, url, settings, nullptr, context)) {
                    view->emit("error", "\"Browser creation failed\"");
                    views.erase(cmd.id);
                }
            } else if (cmd.op == WEB_RELEASE) {
                if (auto v = views.find(cmd.id); v != views.end())
                    v->second->release(cmd.a, cmd.b, fd);
                else if (fd >= 0) close(fd);
            } else {
                if (fd >= 0) close(fd);
                if (cmd.op == WEB_STOP) stop();
                else if (auto v = views.find(cmd.id); v != views.end()) v->second->command(cmd);
            }
        });
    }
}
// CEF changes the stack guard in forked children; match its Linux entry point.
NO_STACK_PROTECTOR
int main(int argc, char **argv) {
    // A compositor does not normally inherit its own socket in WAYLAND_DISPLAY.
    // Configure this helper only; never mutate the multithreaded host environment.
    constexpr char display_switch[] = "--proscenium-wayland-display=";
    for (int i = 1; i < argc; i++)
        if (!strncmp(argv[i], display_switch, sizeof display_switch - 1) &&
            argv[i][sizeof display_switch - 1])
            setenv("WAYLAND_DISPLAY", argv[i] + sizeof display_switch - 1, 1);
    CefMainArgs args(argc, argv);
    CefRefPtr<App> app = new App;
    int result = CefExecuteProcess(args, app, nullptr);
    if (result >= 0) return result;
    auto line = CefCommandLine::CreateCommandLine();
    line->InitFromArgv(argc, argv);
    if (!line->HasSwitch("proscenium-command-fd")) return 2;
    command_fd = std::stoi(line->GetSwitchValue("proscenium-command-fd").ToString());
    wake_fd = std::stoi(line->GetSwitchValue("proscenium-wake-fd").ToString());
    fcntl(command_fd, F_SETFD, FD_CLOEXEC);
    fcntl(wake_fd, F_SETFD, FD_CLOEXEC);
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    signal(SIGPIPE, SIG_IGN);
    std::string cache = line->GetSwitchValue("proscenium-cache-dir").ToString();
    if (cache.empty()) return 4;
    CefSettings settings;
    CefString(&settings.root_cache_path) = cache;
    settings.windowless_rendering_enabled = true;
    settings.log_severity = LOGSEVERITY_WARNING;
    accelerated = want_acceleration();
    if (accelerated && !gpu.initialize()) {
        fprintf(stderr, "Proscenium web: DMA-BUF unavailable: %s\n", gpu.error.c_str());
        return 5;
    }
    if (!CefInitialize(args, settings, app, nullptr)) return 3;
    std::thread reader(receive);
    CefRunMessageLoop();
    shutdown(command_fd, SHUT_RDWR);
    reader.join();
    views.clear();
    CefShutdown();
    std::error_code ec;
    fs::remove_all(cache, ec);
    return 0;
}
