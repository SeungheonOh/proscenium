/* The render thread: see renderthread.h. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE /* pthread_setname_np */
#endif
#include "renderthread.h"

#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/eventfd.h>
#include <unistd.h>
#include <wlr/util/log.h>

#include "util.h"

struct job {
    struct job *next;
    void (*run)(void *data);
    void (*done)(void *data);
    void *data;
    /* For render_thread_run: set once it ran, under the lock. */
    bool waited, finished;
    /* The main context's fence the job waits on first; EGL_NO_SYNC_KHR for none. */
    EGLSyncKHR fence;
};

struct render_thread {
    EGLDisplay display;
    EGLContext context;
    pthread_t thread;
    pthread_mutex_t lock;
    pthread_cond_t wake, ran;
    struct job *queue, *queue_tail;
    struct job *finished, *finished_tail;
    bool stopping;
    /* Its context became current, or the EGL error why not: set before the first job runs. */
    bool current;
    EGLint current_error;
    int fd;
    /* The main context's newest fence, for the next job queued. */
    EGLSyncKHR fence;
    /* The render context's newest fence, for the main thread; under the lock. */
    EGLSyncKHR render_fence;
    /* Fences, where EGL has them (KHR_fence_sync and KHR_wait_sync); NULL without. */
    PFNEGLCREATESYNCKHRPROC create_sync;
    PFNEGLDESTROYSYNCKHRPROC destroy_sync;
    PFNEGLWAITSYNCKHRPROC wait_sync;
};

static void push(struct job **head, struct job **tail, struct job *job) {
    job->next = NULL;
    if (*tail) (*tail)->next = job;
    else *head = job;
    *tail = job;
}

static struct job *pop(struct job **head, struct job **tail) {
    struct job *job = *head;
    if (!job) return NULL;
    *head = job->next;
    if (!*head) *tail = NULL;
    return job;
}

static void nothing(void *data) {
    (void)data;
}

static void *thread_main(void *argument) {
    struct render_thread *thread = argument;
    thread->current =
        eglMakeCurrent(thread->display, EGL_NO_SURFACE, EGL_NO_SURFACE, thread->context);
    if (!thread->current) thread->current_error = eglGetError();
    pthread_mutex_lock(&thread->lock);
    for (;;) {
        while (!thread->queue && !thread->stopping) pthread_cond_wait(&thread->wake, &thread->lock);
        struct job *job = pop(&thread->queue, &thread->queue_tail);
        if (!job) break;
        pthread_mutex_unlock(&thread->lock);
        if (job->fence != EGL_NO_SYNC_KHR) {
            /* The GPU waits; the thread goes on recording. */
            thread->wait_sync(thread->display, job->fence, 0);
            thread->destroy_sync(thread->display, job->fence);
        }
        job->run(job->data);
        pthread_mutex_lock(&thread->lock);
        if (job->waited) {
            job->finished = true;
            pthread_cond_broadcast(&thread->ran);
        } else {
            bool wake = !thread->finished;
            push(&thread->finished, &thread->finished_tail, job);
            if (wake) {
                uint64_t one = 1;
                ssize_t written = write(thread->fd, &one, sizeof one);
                (void)written;
            }
        }
    }
    pthread_mutex_unlock(&thread->lock);
    eglMakeCurrent(thread->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglReleaseThread();
    return NULL;
}

/* A context sharing SHARE's objects, made as wlroots makes its own: GLES of the same
 * version and GPU priority, without a config, and asking for the same reset behaviour
 * when the driver has it, as contexts sharing objects must. */
static EGLContext share_context(EGLDisplay display, EGLContext share, const char *extensions) {
    EGLint version = 2, priority = 0;
    eglQueryContext(display, share, EGL_CONTEXT_CLIENT_VERSION, &version);
    if (strstr(extensions, "EGL_IMG_context_priority"))
        eglQueryContext(display, share, EGL_CONTEXT_PRIORITY_LEVEL_IMG, &priority);
    bool robust = strstr(extensions, "EGL_EXT_create_context_robustness");
    for (int attempt = robust ? 0 : 1; attempt < 2; attempt++) {
        EGLint attribs[8];
        int n = 0;
        attribs[n++] = EGL_CONTEXT_CLIENT_VERSION;
        attribs[n++] = version;
        if (attempt == 0) {
            attribs[n++] = EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT;
            attribs[n++] = EGL_LOSE_CONTEXT_ON_RESET_EXT;
        }
        if (priority) {
            attribs[n++] = EGL_CONTEXT_PRIORITY_LEVEL_IMG;
            attribs[n++] = priority;
        }
        attribs[n++] = EGL_NONE;
        EGLContext context = eglCreateContext(display, EGL_NO_CONFIG_KHR, share, attribs);
        if (context != EGL_NO_CONTEXT) return context;
    }
    return EGL_NO_CONTEXT;
}

struct render_thread *render_thread_create(EGLDisplay display, EGLContext share) {
    if (!eglBindAPI(EGL_OPENGL_ES_API)) return NULL;
    const char *extensions = eglQueryString(display, EGL_EXTENSIONS);
    if (!extensions) extensions = "";
    EGLContext context = share_context(display, share, extensions);
    if (context == EGL_NO_CONTEXT) {
        wlr_log(WLR_INFO, "render thread: no context sharing wlroots' (0x%x)", eglGetError());
        return NULL;
    }
    int fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (fd < 0) {
        eglDestroyContext(display, context);
        return NULL;
    }
    struct render_thread *thread = xcalloc(1, sizeof *thread);
    thread->display = display;
    thread->context = context;
    thread->fd = fd;
    thread->fence = EGL_NO_SYNC_KHR;
    thread->render_fence = EGL_NO_SYNC_KHR;
    if (strstr(extensions, "EGL_KHR_fence_sync") && strstr(extensions, "EGL_KHR_wait_sync")) {
        thread->create_sync = (PFNEGLCREATESYNCKHRPROC)eglGetProcAddress("eglCreateSyncKHR");
        thread->destroy_sync = (PFNEGLDESTROYSYNCKHRPROC)eglGetProcAddress("eglDestroySyncKHR");
        thread->wait_sync = (PFNEGLWAITSYNCKHRPROC)eglGetProcAddress("eglWaitSyncKHR");
    }
    if (!thread->create_sync || !thread->destroy_sync || !thread->wait_sync)
        thread->create_sync = NULL;
    pthread_mutex_init(&thread->lock, NULL);
    pthread_cond_init(&thread->wake, NULL);
    pthread_cond_init(&thread->ran, NULL);
    /* Signals stay with the main thread, which handles them. */
    sigset_t all, previous;
    sigfillset(&all);
    pthread_sigmask(SIG_SETMASK, &all, &previous);
    int error = pthread_create(&thread->thread, NULL, thread_main, thread);
    pthread_sigmask(SIG_SETMASK, &previous, NULL);
    if (error) {
        wlr_log(WLR_ERROR, "render thread: cannot start: %s", strerror(error));
        eglDestroyContext(display, context);
        close(fd);
        free(thread);
        return NULL;
    }
    pthread_setname_np(thread->thread, "render");
    /* A first job sees whether the context is current there; drawing without one cannot. */
    render_thread_run(thread, nothing, NULL);
    if (!thread->current) {
        wlr_log(WLR_ERROR, "render thread: cannot make its context current (0x%x)",
                thread->current_error);
        render_thread_destroy(thread);
        return NULL;
    }
    return thread;
}

void render_thread_destroy(struct render_thread *thread) {
    if (!thread) return;
    pthread_mutex_lock(&thread->lock);
    thread->stopping = true;
    pthread_cond_broadcast(&thread->wake);
    pthread_mutex_unlock(&thread->lock);
    pthread_join(thread->thread, NULL);
    render_thread_dispatch(thread);
    if (thread->fence != EGL_NO_SYNC_KHR) thread->destroy_sync(thread->display, thread->fence);
    if (thread->render_fence != EGL_NO_SYNC_KHR)
        thread->destroy_sync(thread->display, thread->render_fence);
    eglDestroyContext(thread->display, thread->context);
    pthread_mutex_destroy(&thread->lock);
    pthread_cond_destroy(&thread->wake);
    pthread_cond_destroy(&thread->ran);
    close(thread->fd);
    free(thread);
}

/* A fence after the current context's commands so far, flushed to the GPU so it can
 * signal; EGL_NO_SYNC_KHR when there are no fences, after the commands completed. */
static EGLSyncKHR new_fence(struct render_thread *thread) {
    EGLSyncKHR fence = thread->create_sync
                           ? thread->create_sync(thread->display, EGL_SYNC_FENCE_KHR, NULL)
                           : EGL_NO_SYNC_KHR;
    if (fence == EGL_NO_SYNC_KHR) glFinish();
    else glFlush();
    return fence;
}

void render_thread_fence_main(struct render_thread *thread) {
    if (thread->fence != EGL_NO_SYNC_KHR) thread->destroy_sync(thread->display, thread->fence);
    thread->fence = new_fence(thread);
}

void render_thread_fence_render(struct render_thread *thread) {
    EGLSyncKHR fence = new_fence(thread);
    pthread_mutex_lock(&thread->lock);
    EGLSyncKHR old = thread->render_fence;
    thread->render_fence = fence;
    pthread_mutex_unlock(&thread->lock);
    if (old != EGL_NO_SYNC_KHR) thread->destroy_sync(thread->display, old);
}

void render_thread_wait_render(struct render_thread *thread) {
    pthread_mutex_lock(&thread->lock);
    EGLSyncKHR fence = thread->render_fence;
    thread->render_fence = EGL_NO_SYNC_KHR;
    pthread_mutex_unlock(&thread->lock);
    if (fence == EGL_NO_SYNC_KHR) return;
    thread->wait_sync(thread->display, fence, 0);
    thread->destroy_sync(thread->display, fence);
}

static void enqueue(struct render_thread *thread, struct job *job) {
    job->fence = thread->fence;
    thread->fence = EGL_NO_SYNC_KHR;
    pthread_mutex_lock(&thread->lock);
    push(&thread->queue, &thread->queue_tail, job);
    pthread_cond_signal(&thread->wake);
    pthread_mutex_unlock(&thread->lock);
}

void render_thread_run(struct render_thread *thread, void (*run)(void *data), void *data) {
    struct job job = {.run = run, .data = data, .waited = true};
    enqueue(thread, &job);
    pthread_mutex_lock(&thread->lock);
    while (!job.finished) pthread_cond_wait(&thread->ran, &thread->lock);
    pthread_mutex_unlock(&thread->lock);
}

void render_thread_queue(struct render_thread *thread, void (*run)(void *data),
                         void (*done)(void *data), void *data) {
    struct job *job = xcalloc(1, sizeof *job);
    *job = (struct job){.run = run, .done = done, .data = data};
    enqueue(thread, job);
}

int render_thread_fd(const struct render_thread *thread) {
    return thread->fd;
}

void render_thread_dispatch(struct render_thread *thread) {
    uint64_t count;
    while (read(thread->fd, &count, sizeof count) < 0 && errno == EINTR) continue;
    for (;;) {
        pthread_mutex_lock(&thread->lock);
        struct job *job = pop(&thread->finished, &thread->finished_tail);
        pthread_mutex_unlock(&thread->lock);
        if (!job) return;
        if (job->done) job->done(job->data);
        free(job);
    }
}
