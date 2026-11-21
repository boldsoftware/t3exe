# t3exe

Run [T3 Code](https://github.com/pingdotgg/t3code) agents on [exe.dev](https://exe.dev) VMs.

t3exe is an MCP server (and CLI) for T3 Code. An orchestrator thread calls `exe_vm_create`; t3exe creates a
VM, installs the same T3 Code version on it, clones your repository, and links the VM to your T3 Code as an
environment. The orchestrator then sends work there with `delegate_task`, as it would to any linked machine.
When the VM's threads go quiet, t3exe deletes or pauses it.

It uses T3 Code's *Linked environments* and needs no change to T3 Code.

```
your T3 Code ── exe_vm_create ──▶ t3exe ── exe.dev API ──▶ new VM
                                    │                       ├ T3 Code (same version), t3 serve on :8000
                                    │                       ├ Claude Code, Codex → exe.dev LLM integration
                                    │                       └ git clone, t3 project add, pairing code
                                    └── t3 environment link https://<vm>.exe.xyz
your T3 Code ── delegate_task(target.environmentId) ──▶ a thread on the VM
```

## Setup

You need Node 22.18 or later, T3 Code 0.1.10 or later, and an exe.dev account whose SSH key is on this machine.
On the machine with the T3 Code server, in your project's checkout:

```sh
npx -y @exedev/t3exe login
```

Then ask a thread: *"Start an exe VM and have it fix the failing tests there."*

`login` sets up everything t3exe needs, and running it again is safe:

1. **API key.** It runs `ssh exe.dev ssh-key generate-api-key` and saves the key to `~/.t3exe/token`. The key
   only works on VMs tagged `t3exe`, for the commands t3exe runs, and expires in 90 days (`--exp`). A saved key
   that still works is kept (`--new-key` replaces it).
2. **Agents.** It adds t3exe as an MCP server to each agent T3 Code has turned on, Claude Code and Codex
   (`claude mcp add --scope user`, `codex mcp add`), replacing an earlier t3exe entry. The entry runs t3exe the
   way you did (`npx -y @exedev/t3exe` or this install) with absolute paths, so it works under a T3 Code
   service with a short `PATH`.
3. **Linked environments.** It turns on *Settings → Labs → Linked environments* in T3 Code.
4. **GitHub.** If the checkout's origin is on github.com, it makes an exe.dev
   [GitHub integration](https://exe.dev/docs/integrations-github) for the repository attached to tag `t3exe`
   (or attaches an existing one), so VMs clone and push it, private or not, with no token on the VM. VMs
   clone through `https://github.int.exe.xyz` when it reaches the repository, and keep `origin` on github.com.
   If your GitHub account isn't connected to exe.dev yet, it says so and links to where to connect it. For
   another repository later: `t3exe repo add [OWNER/REPO]`.

`t3exe logout` undoes it: removes the MCP entries and the integrations login made, and revokes and deletes
the key. It leaves Linked environments on, and any VMs.

### T3 Code on an exe.dev VM

A VM can't run `ssh exe.dev`, so make the key on your computer and pass it to `login --token-stdin` on the VM
(which needs Node):

```sh
ssh exe.dev "ssh-key generate-api-key --label=t3exe-my-t3code --tag=t3exe --cmds='whoami,ls,new,rm,pause,resume,ssh,share port,share set-public' --exp=90d --json" \
  | ssh my-t3code.exe.xyz 'cd ~/myrepo && npx -y @exedev/t3exe login --token-stdin'
```

Run `npx -y @exedev/t3exe repo add OWNER/REPO` on your computer for the GitHub integration.

## Tools

| Tool | |
| - | - |
| `exe_vm_create` | Create and link a VM. Returns `environmentId` and `projectId` for `delegate_task`. |
| `exe_vm_list` | The VMs t3exe manages, their link status, and when cleanup acts. |
| `exe_vm_destroy` | Unlink and delete a VM. |
| `exe_vm_pause`, `exe_vm_resume` | Pause a VM (memory to disk, no CPU or RAM in use) and bring it back. |
| `exe_vm_configure` | Change a VM's cleanup: `idleMinutes`, `onIdle`, `ttlMinutes`, `keepAlive`. |

The same operations are on the command line: `t3exe create`, `ls`, `rm`, `pause`, `resume`, `set`, `reap`
(`t3exe --help`). `npm install -g @exedev/t3exe` puts `t3exe` on your PATH; otherwise use `npx -y @exedev/t3exe`.

## Cleanup

exe.dev VMs run until deleted, so t3exe cleans up after itself. Every minute it asks each VM's T3 Code
whether a thread there is busy, including tasks delegated to it. A VM with no busy thread for `idleMinutes` (default 15) is deleted, or
paused if `onIdle` is `pause`. Every VM is deleted `ttlMinutes` (default 480) after it was created, unless it
has `keepAlive`.

Cleanup runs while an MCP server runs. The VMs are recorded in `~/.t3exe/vms.json`, so the next MCP
server picks them up; `t3exe reap` from cron does the same without one.

## Models on the VM

If the VM can reach exe.dev's [LLM integration](https://exe.dev/docs/integrations-llm), t3exe points Claude
Code and Codex at it, so no API key or login is stored on the VM. To use your own credentials instead, name
them in `T3EXE_FORWARD_ENV`, e.g. `T3EXE_FORWARD_ENV=ANTHROPIC_API_KEY,OPENAI_API_KEY`. Their values are
sent through the exe.dev API and stored in a `0600` file that the VM's T3 Code service reads.

## Configuration

| Variable | Default | |
| - | - | - |
| `EXE_API_TOKEN` | `~/.t3exe/token` | exe.dev API key |
| `EXE_BASE_URL` | `https://exe.dev` | exe.dev API, or an exe.dev integration URL |
| `EXE_SSH_HOST` | `exe.dev` | for `t3exe login` |
| `T3EXE_TAG` | `t3exe` | tag on every VM; the key from `t3exe login` is scoped to it |
| `T3EXE_T3` | `t3` | the local T3 Code CLI |
| `T3EXE_T3_BASE_DIR` | T3 Code's | the local T3 Code data directory |
| `T3EXE_FORWARD_ENV` | | local variables to copy to the VM's T3 Code |
| `T3EXE_HOME` | `~/.t3exe` | t3exe's own files |

## Security

- The VM's T3 Code is public at `https://<vm>.exe.xyz`, since a T3 Code link cannot sign in to exe.dev's
  proxy. T3 Code's own authentication protects it: t3exe links with a single-use pairing code that expires in
  five minutes and carries only the scopes the chosen access level needs.
- `access` (default `full-access`) is the broadest mode your agents may run with on the VM. The VM is a
  throwaway machine; your local files are not on it.
- A private GitHub repository needs an exe.dev GitHub integration on tag `t3exe` (`t3exe login` or `t3exe repo add`);
  other private repositories need git credentials on the VM.

## Limits

- `delegate_task` to a linked environment does not support `isolation: "worktree"`.
- `t3exe` installs the local T3 Code's version on each VM; both ends must match.

## License

MIT
