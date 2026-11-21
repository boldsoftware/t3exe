// Private repositories: an exe.dev GitHub integration for the repository, attached to
// t3exe's tag, lets every t3exe VM clone and push it through https://github.int.exe.xyz
// with no token on the VM. Making one takes the user's own `ssh exe.dev`: t3exe's API key
// is tag-scoped, and those can't change integrations.

import { failure, type Runner } from "./run.ts";

export const INTEGRATIONS_URL = "https://exe.dev/integrations#github";

/**
 * owner/repo for a GitHub remote URL (https, ssh, or scp-style), else undefined. An exe.dev
 * GitHub integration URL counts: so does a github.com URL git rewrites to one.
 */
export function githubRepo(url: string | undefined): string | undefined {
  const m = url?.trim().match(/^(?:https:\/\/(?:[^@/]+@)?(?:github\.com|github\.int\.exe\.xyz)\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

interface Integration {
  name: string;
  type: string;
  repositories?: string[] | null;
  attachments?: string[] | null;
}

export type GitHubResult =
  | { status: "present"; name: string }
  | { status: "attached" | "added"; name: string }
  | { status: "unconnected"; detail: string };

/**
 * Makes owner/repo available to VMs tagged tag: nothing if an integration for it already
 * reaches them, else attach an existing one for it, else add one. When exe.dev can't reach
 * the repository through GitHub (no account connected, or the exe.dev GitHub App isn't on
 * the repository's owner), returns "unconnected" with exe.dev's reason.
 */
export async function ensureIntegration(exe: (command: string) => ReturnType<Runner>, repo: string, tag: string): Promise<GitHubResult> {
  const listed = await exe("integrations list --json");
  if (listed.code !== 0) throw new Error(`integrations list: ${failure(listed)}`);
  const all = JSON.parse(listed.stdout || "[]") as Integration[];
  const same = (r: string) => r.toLowerCase() === repo.toLowerCase();
  const candidates = all.filter((i) => i.type === "github" && (i.repositories ?? []).some(same));
  const reaches = (i: Integration) => (i.attachments ?? []).some((a) => a === `tag:${tag}` || a === "auto:all");
  const present = candidates.find(reaches);
  if (present) return { status: "present", name: present.name };
  if (candidates.length > 0) {
    const name = candidates[0].name;
    const r = await exe(`integrations attach ${name} tag:${tag}`);
    if (r.code !== 0) throw new Error(`integrations attach ${name}: ${failure(r)}`);
    return { status: "attached", name };
  }
  const name = integrationName(repo, new Set(all.map((i) => i.name)));
  const r = await exe(`integrations add github --name ${name} --repository ${repo} --attach tag:${tag}`);
  if (r.code === 0) return { status: "added", name };
  const reason = failure(r);
  if (/no GitHub (account connected|App installed)|repository access denied|not configured/i.test(reason)) {
    return { status: "unconnected", detail: reason.replace(/^(error:\s*)/i, "") };
  }
  throw new Error(`integrations add github: ${reason}`);
}

/** A free integration name for repo: t3exe-<repo>, then t3exe-<owner>-<repo>, then numbered. */
export function integrationName(repo: string, taken: Set<string>): string {
  const label = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const [owner, name] = repo.split("/");
  const fit = (s: string) => s.slice(0, 63).replace(/-+$/, "");
  const choices = [fit(`t3exe-${label(name)}`), fit(`t3exe-${label(owner)}-${label(name)}`)];
  for (const c of choices) if (!taken.has(c)) return c;
  for (let i = 2; ; i++) {
    const c = `${fit(choices[1]).slice(0, 60)}-${i}`;
    if (!taken.has(c)) return c;
  }
}
