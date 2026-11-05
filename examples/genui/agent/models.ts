// What the assistant thinks with: $PROSCENIUM_ASSISTANT_MODEL as "provider/model"
// (anthropic/claude-sonnet-5-5 with ANTHROPIC_API_KEY, openai/…, any provider Pi
// knows), else Codex Luna 6 at its fast tier on the ChatGPT sign-in Codex keeps.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const luna = "openai-codex/gpt-6-luna";

/** The account's own home, not $HOME, which a test rig points elsewhere. */
const home = userInfo().homedir;

/**
 * The ChatGPT access token Codex holds, read fresh each time and never refreshed
 * here: refreshing spends the refresh token Codex holds, which would sign Codex
 * out. When the token has expired, renewSignIn() has Codex renew it.
 */
function codexToken(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(home, ".codex/auth.json"), "utf8")).tokens.access_token as string;
  } catch {
    return undefined;
  }
}

/** Credentials kept in memory, with Codex's sign-in read from its file whenever it is asked for. */
class Credentials implements CredentialStore {
  private readonly kept = new Map<string, Credential>();

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId === "openai-codex") {
      const access = codexToken();
      // Always an hour from expiring, so Pi never tries to refresh it itself.
      return access ? { type: "oauth", access, refresh: "", expires: Date.now() + 3_600_000 } : undefined;
    }
    return this.kept.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const listed: CredentialInfo[] = [...this.kept].map(([providerId, credential]) => ({ providerId, type: credential.type }));
    if (codexToken()) listed.push({ providerId: "openai-codex", type: "oauth" });
    return listed;
  }

  async modify(providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) {
    if (providerId === "openai-codex") return this.read(providerId);
    const next = await change(this.kept.get(providerId));
    if (next) this.kept.set(providerId, next);
    else this.kept.delete(providerId);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.kept.delete(providerId);
  }
}

const keys: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY",
};

export interface Engine {
  runtime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  label: string;
  /** Changes to each request's body: Codex's priority tier. */
  payload?: (body: unknown) => unknown;
}

export async function makeEngine(state: string): Promise<Engine> {
  mkdirSync(state, { recursive: true });
  const runtime = await ModelRuntime.create({
    credentials: new Credentials(), modelsPath: null, modelsStorePath: join(state, "models-store.json"),
  });
  const wanted = (process.env.PROSCENIUM_ASSISTANT_MODEL || luna).trim();
  const [provider = "", ...rest] = wanted.split("/");
  const id = rest.join("/");
  const key = process.env[keys[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
  if (key) await runtime.setRuntimeApiKey(provider, key);
  const model = runtime.getModel(provider, id) ?? runtime.getModel("openai-codex", "gpt-6-luna");
  if (!model) throw new Error(`No model "${wanted}", and no Codex Luna 6 to fall back on`);
  const codex = model.provider === "openai-codex";
  return {
    runtime, model,
    label: codex && model.id === "gpt-6-luna" ? "Codex Luna 6 · fast" : model.name ?? model.id,
    payload: codex ? (body) => ({ ...(body as object), service_tier: "priority" }) : undefined,
  };
}

let renewing: Promise<boolean> | null = null;
let renewedAt = 0;

/** Whether ERROR says the sign-in expired. */
export function signInExpired(error: string): boolean {
  return /token (has )?expired|401|unauthori[sz]ed|invalid.*token/i.test(error);
}

/** Have Codex renew its sign-in by asking it something small; true if the token changed. */
export function renewSignIn(): Promise<boolean> {
  if (renewing) return renewing;
  if (Date.now() - renewedAt < 5 * 60_000) return Promise.resolve(false);
  const before = codexToken();
  const codex = [join(home, ".local/bin/codex"), "/usr/local/bin/codex", "/usr/bin/codex"].find(existsSync) ?? "codex";
  renewing = new Promise<boolean>((resolve) => {
    const dir = join(tmpdir(), "proscenium-assistant-codex");
    mkdirSync(dir, { recursive: true });
    const child = spawn(codex, ["exec", "--skip-git-repo-check", "-s", "read-only", "Reply with just: OK"],
                        { cwd: dir, stdio: "ignore", env: { ...process.env, HOME: home } });
    const timer = setTimeout(() => child.kill(), 90_000);
    const done = () => {
      clearTimeout(timer);
      renewedAt = Date.now();
      renewing = null;
      resolve(codexToken() !== before);
    };
    child.on("exit", done);
    child.on("error", done);
  });
  return renewing;
}
