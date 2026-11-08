/*
 * The render thread: a thread with an EGL context of its own, in wlroots' share group,
 * that runs the compositor's drawing. Jobs run there one at a time, in the order they
 * were queued; the main thread either waits for one or hears of it finishing from its
 * event loop.
 *
 * GL objects are shared, but not their contents' visibility: a context that changed
 * one fences before another context reads it (render_thread_fence_main for the main
 * thread's changes, which every job waits for).
 */
#pragma once

#include <EGL/egl.h>
#include <stdbool.h>

struct render_thread;

/* Start the thread, its context sharing SHARE's objects on DISPLAY; NULL when it cannot. */
struct render_thread *render_thread_create(EGLDisplay display, EGLContext share);
/* Run the jobs still queued, then stop the thread and run the DONE callbacks left, which
 * must not run or queue jobs any more. */
void render_thread_destroy(struct render_thread *thread);

/* Run JOB(DATA) on the render thread after the jobs queued before it, and wait for it. */
void render_thread_run(struct render_thread *thread, void (*job)(void *data), void *data);
/*
 * Queue JOB(DATA) on the render thread; once it ran, DONE(DATA) runs on the main thread
 * from render_thread_dispatch. DONE may be NULL.
 */
void render_thread_queue(struct render_thread *thread, void (*job)(void *data),
                         void (*done)(void *data), void *data);
/* Readable when finished jobs await render_thread_dispatch. */
int render_thread_fd(const struct render_thread *thread);
/* Run the DONE callbacks of finished jobs, in the order the jobs ran. */
void render_thread_dispatch(struct render_thread *thread);

/*
 * Fence what the main thread's context did so far (client buffer uploads, imports),
 * for the next job to wait on before it reads any of it, or finish it where EGL has no
 * fences. Call with the main context current.
 */
void render_thread_fence_main(struct render_thread *thread);

/* From a job: fence what the render thread drew so far, for the main thread to wait on. */
void render_thread_fence_render(struct render_thread *thread);
/* Make the main context wait (on the GPU) for the render thread's last fence, if any. */
void render_thread_wait_render(struct render_thread *thread);
