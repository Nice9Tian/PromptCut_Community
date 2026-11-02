import type { Plugin } from "vite";
import type { Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { spawn, ChildProcess } from "child_process";
import { tr } from "./i18n.mjs";

// Running jobs: jobId → child process
const activeJobs = new Map<string, ChildProcess>();

function sanitizeName(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

/**
 * Returned uniformly when the bundled Python cannot be found.
 *
 * The wording is aimed at two groups of people: users who installed the release package, and
 * developers running npm run dev in the repository.
 * For the former, this is not "feature disabled": bundled Python is shipped with the package just like
 * Node, Chrome, and ffmpeg; if it is missing, the installer is corrupted or was removed by antivirus,
 * and they should reinstall rather than look for some toggle. The old text said
 * "Not ready, run npm run prepare-python first", a command users do not have at all, which only
 * misleads people.
 */
export const pythonMissing = (): string =>
  tr("Bundled Python not found. The official installer ships with it; if it is missing, the install is probably corrupted or it was deleted by antivirus software, so reinstall once; ") +
  tr("If you are developing in the repo, run npm run prepare-python to assemble it.");

/** Search for the bundled Python interpreter path in document order; returns null if not found */
export function findPython(root: string): string | null {
  if (process.env.PROMPTCUT_PYTHON) {
    if (existsSync(process.env.PROMPTCUT_PYTHON)) return process.env.PROMPTCUT_PYTHON;
  }
  const candidate1 = path.join(root, "desktop", "src-tauri", "runtime", "python", "python.exe");
  if (existsSync(candidate1)) return candidate1;
  const candidate2 = path.join(root, "python", ".venv", "Scripts", "python.exe");
  if (existsSync(candidate2)) return candidate2;
  return null;
}

/**
 * Characters that batch interpreters (.cmd/.bat) cannot accept.
 *
 * `&` `|` `<` `>` `^` are metacharacters in the cmd command line, `"` messes up quote nesting,
 * and `%` triggers variable expansion.
 * See spawnPython explanation below: there is no safe way to pass any of these characters into
 * a batch script.
 */
const CMD_METACHARS = /[&|<>^"%]/;

/**
 * Start the interpreter.
 *
 * `.exe` is spawned directly without going through any shell: the normal path (findPython returning the
 * bundled python.exe) takes this route, passing arguments as an array to CreateProcess with no second
 * round of parsing, so no matter how many metacharacters there are, they are just ordinary characters.
 *
 * `.cmd` / `.bat` is another story. Node 18.20+/20+ on Windows refuses to spawn them directly (EINVAL)
 * and must go through cmd.exe, and **once routed through it there is no safe syntax**; both approaches
 * were tested in practice:
 *
 *   - Quoting each argument with `cmd /c`: quotes enter the batch script, positional parameters like
 *     `%3` receive quoted values, comparisons in the script like `if "%SUBCMD%"=="status"` all fail to
 *     match, and functionality breaks immediately;
 *   - Without quotes (or using PowerShell 5.1 native invocation, which quotes only when spaces are present):
 *     for arguments without spaces that contain metacharacters like `a&b.mp4` or `https://x/?a&rm`,
 *     the `&` becomes a command separator in cmd and the second half is executed as a command:
 *     confirmed executed in practice.
 *
 * You cannot have both: either arguments enter with quotes and batch's own parsing breaks, or without
 * quotes and metacharacters escape. At root, batch files lack the ability to safely accept untrusted
 * arguments. Yet these two locations feed user input: asset paths (shots) and collection URLs (collect,
 * where `&` in URLs is routine).
 *
 * Therefore, **we do not gamble** here: reject execution once an argument contains metacharacters, and
 * explain clearly how to work around it (point PROMPTCUT_PYTHON to python.exe, which does not have this
 * problem). Clean arguments are allowed through as usual, so dev/test setups using `.cmd` as the
 * interpreter remain unaffected.
 */
export function spawnPython(pythonPath: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const lower = pythonPath.toLowerCase();
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const bad = args.find((a) => CMD_METACHARS.test(String(a)));
    if (bad !== undefined) {
      throw new Error(
        tr("The arguments contain cmd metacharacters ({0}), which the batch interpreter cannot handle -- ", JSON.stringify(bad)) +
        tr("PROMPTCUT_PYTHON currently points to {0}.", path.basename(pythonPath)) +
        tr("Point it to python.exe to avoid this limitation (.exe does not go through the shell)."),
      );
    }
    return spawn("cmd.exe", ["/d", "/s", "/c", pythonPath, ...args], { env, windowsHide: true });
  }
  return spawn(pythonPath, args, { env, windowsHide: true });
}

/** Data directory (disk location for stt job files) */
export function dataDir(root: string): string {
  return process.env.PROMPTCUT_DATA_DIR ?? path.join(root, "out");
}

/** Assemble environment variables for the child process */
export async function buildEnv(root: string, pythonPath: string): Promise<NodeJS.ProcessEnv> {
  const pyLibs = process.env.PROMPTCUT_PYLIBS ?? path.join(root, "out", "pylibs");
  const models = process.env.PROMPTCUT_MODELS ?? path.join(root, "out", "models");

  await fs.mkdir(pyLibs, { recursive: true });
  await fs.mkdir(models, { recursive: true });

  // Check whether promptcut_stt is already in site-packages
  const pythonDir = path.dirname(pythonPath);
  // Check package by package, not just promptcut_stt: site-packages of the bundled interpreter has stt
  // but lacks the later-added promptcut_shots; checking only the former skips the entire block, causing
  // shot detection to always report No module named.
  const PACKAGES = ["promptcut_stt", "promptcut_shots", "promptcut_track", "promptcut_subject", "promptcut_collect"];
  const missing = PACKAGES.filter(
    (pkg) => !existsSync(path.join(pythonDir, "Lib", "site-packages", pkg)),
  );

  let pythonPathEnv = pyLibs;
  if (missing.length > 0) {
    // Standard venv interpreters respect PYTHONPATH; appending the source directory is sufficient.
    pythonPathEnv = pyLibs + path.delimiter + path.join(root, "python");

    // However, the embeddable interpreter distributed with the package includes python311._pth; once ._pth
    // exists, Python **completely ignores PYTHONPATH** (regardless of whether -I is passed). It recognizes
    // the promptcut_pylibs.pth hook in site-packages: that hook mounts the directory pointed to by
    // PROMPTCUT_PYLIBS onto sys.path. Meanwhile PROMPTCUT_PYLIBS must be passed as-is to pip's --target,
    // so it cannot be stuffed with multi-segment paths.
    // Therefore, during development, mirror the source packages into pylibs so the hook picks them up.
    // In the release package, prepare-python copies these packages into site-packages, never reaching here.
    const hasPthFile = (await fs.readdir(pythonDir).catch(() => [] as string[]))
      .some((f) => f.toLowerCase().endsWith("._pth"));
    if (hasPthFile) {
      // Mirror only the missing ones. Shot detection also imports promptcut_stt.jsonl, so even if only
      // shots is missing, stt must also be moved together when it is not in site-packages.
      for (const pkg of missing) {
        const src = path.join(root, "python", pkg);
        if (!existsSync(src)) continue;
        try {
          await fs.cp(src, path.join(pyLibs, pkg), {
            recursive: true,
            force: true,
            filter: (s) => !s.includes("__pycache__"),
          });
        } catch { /* If mirroring fails, let Python itself report No module named to facilitate troubleshooting */ }
      }
    }
  }

  // ffmpeg path: try three locations in order
  const ffmpegBundled = path.join(root, "desktop", "src-tauri", "runtime", "ffmpeg");
  const ffmpegEnv = process.env.PROMPTCUT_FFMPEG_DIR;
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const ffmpegWinget = path.join(
    localAppData,
    "Microsoft", "WinGet", "Packages",
    "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "ffmpeg-9.0.1-full_build", "bin"
  );

  let pathPrefix = "";
  if (existsSync(ffmpegBundled)) {
    pathPrefix = ffmpegBundled + path.delimiter;
  } else if (ffmpegEnv && existsSync(ffmpegEnv)) {
    pathPrefix = ffmpegEnv + path.delimiter;
  } else if (existsSync(ffmpegWinget)) {
    pathPrefix = ffmpegWinget + path.delimiter;
  }

  return {
    ...process.env,
    PYTHONPATH: pythonPathEnv,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PROMPTCUT_PYLIBS: pyLibs,
    PROMPTCUT_MODELS: models,
    PATH: pathPrefix + (process.env.PATH ?? ""),
  };
}

/** Convert Python JSONL stdout + stderr into an SSE stream */
export function pipeToSse(child: ChildProcess, res: ServerResponse): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.();

  let buf = "";
  let hasDone = false;
  const stderrLines: string[] = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line); // Validate valid JSON
        if (line.includes('"event":"done"')) hasDone = true;
        res.write("data: " + line + "\n\n");
      } catch {
        const wrapped = JSON.stringify({ event: "log", line });
        res.write("data: " + wrapped + "\n\n");
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      stderrLines.push(l);
      if (stderrLines.length > 50) stderrLines.shift();
      const wrapped = JSON.stringify({ event: "log", stream: "stderr", line: l });
      res.write("data: " + wrapped + "\n\n");
    }
  });

  child.on("close", (code) => {
    // Flush remaining buffer
    if (buf.trim()) {
      try {
        JSON.parse(buf);
        if (buf.includes('"event":"done"')) hasDone = true;
        res.write("data: " + buf + "\n\n");
      } catch {
        const wrapped = JSON.stringify({ event: "log", line: buf });
        res.write("data: " + wrapped + "\n\n");
      }
    }
    if (code !== 0 && !hasDone) {
      const tail = stderrLines.slice(-10).join("\n");
      const errEvent = JSON.stringify({ event: "error", message: tr("Process exit code {0}", code), stderr: tail });
      res.write("data: " + errEvent + "\n\n");
    }
    res.end();
  });
}

/** Read all bytes from req body */
export function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Recursively kill child process tree on Windows */
function killJob(jobId: string): boolean {
  const child = activeJobs.get(jobId);
  if (!child) return false;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  } catch { /* ignore */ }
  activeJobs.delete(jobId);
  return true;
}

export function sttPlugin(): Plugin {
  return {
    name: "vite-plugin-stt",
    configureServer(server) {
      const root = server.config.root;

      server.middlewares.use(async (req: Connect.IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url) return next();
        const url = req.url.split("?")[0];

        // ── GET /api/stt/status ──────────────────────────────────────
        if (req.method === "GET" && url === "/api/stt/status") {
          const python = findPython(root);
          if (!python) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: pythonMissing() }));
            return;
          }
          try {
            const env = await buildEnv(root, python);
            const child = spawnPython(python, ["-I", "-m", "promptcut_stt", "status"], env);
            let out = "";
            let err = "";
            child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
            child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
            child.on("close", (_code) => {
              try {
                const parsed = JSON.parse(out.trim());
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(parsed));
              } catch {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: tr("Failed to parse Python output"), raw: out, stderr: err }));
              }
            });
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // ── POST /api/stt/install ────────────────────────────────────
        if (req.method === "POST" && url === "/api/stt/install") {
          const python = findPython(root);
          if (!python) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: pythonMissing() }));
            return;
          }
          try {
            const body = await readBody(req);
            const { engine } = JSON.parse(body.toString("utf-8"));
            const env = await buildEnv(root, python);
            const child = spawnPython(
              python,
              ["-I", "-m", "promptcut_stt", "install", "--engine", engine ?? "faster-whisper"],
              env
            );
            req.on("close", () => { try { child.kill(); } catch { /* ignore */ } });
            pipeToSse(child, res);
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // ── POST /api/stt/upload/<jobId>/<filename> ──────────────────
        if (req.method === "POST" && url.startsWith("/api/stt/upload/")) {
          const parts = url.slice("/api/stt/upload/".length).split("/");
          if (parts.length < 2) {
            res.statusCode = 400;
            res.end("Missing jobId or filename");
            return;
          }
          const jobId = parts[0];
          const rawName = decodeURIComponent(parts.slice(1).join("/"));
          const ext = path.extname(sanitizeName(rawName)) || ".bin";
          const jobDir = path.join(dataDir(root), "stt", jobId);
          await fs.mkdir(jobDir, { recursive: true });
          const inputPath = path.join(jobDir, `input${ext}`);
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", async () => {
            try {
              await fs.writeFile(inputPath, Buffer.concat(chunks));
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, jobId, inputPath }));
            } catch (e: unknown) {
              res.statusCode = 500;
              res.end(String(e));
            }
          });
          return;
        }

        // ── POST /api/stt/transcribe ─────────────────────────────────
        if (req.method === "POST" && url === "/api/stt/transcribe") {
          const python = findPython(root);
          if (!python) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: pythonMissing() }));
            return;
          }
          try {
            const body = await readBody(req);
            const { jobId, engine, model, language } = JSON.parse(body.toString("utf-8"));
            if (!jobId) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "jobId is required" }));
              return;
            }

            const jobDir = path.join(dataDir(root), "stt", jobId);
            // Find input file
            let inputPath: string | null = null;
            try {
              const files = await fs.readdir(jobDir);
              const inp = files.find((f) => f.startsWith("input."));
              if (inp) inputPath = path.join(jobDir, inp);
            } catch { /* ignore */ }

            if (!inputPath) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: `No uploaded file found for ${jobId}, call /api/stt/upload first` }));
              return;
            }

            const resultPath = path.join(jobDir, "result.json");
            const spawnArgs = [
              "-I", "-m", "promptcut_stt", "transcribe",
              "--input", inputPath,
              "--engine", engine ?? "faster-whisper",
              "--model", model ?? "small",
              "--out", resultPath,
            ];
            if (language) spawnArgs.push("--language", language);

            const env = await buildEnv(root, python);
            const child = spawnPython(python, spawnArgs, env);
            activeJobs.set(jobId, child);

            req.on("close", () => {
              if (activeJobs.get(jobId) === child) {
                killJob(jobId);
              }
            });

            child.on("close", () => {
              activeJobs.delete(jobId);
            });

            pipeToSse(child, res);
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // ── DELETE /api/stt/job/<id> ─────────────────────────────────
        if (req.method === "DELETE" && url.startsWith("/api/stt/job/")) {
          const jobId = url.slice("/api/stt/job/".length);
          const killed = killJob(jobId);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, killed }));
          return;
        }

        next();
      });
    },
  };
}
