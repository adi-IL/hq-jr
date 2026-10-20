import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "refresh-deploy-files.sh");

describe("deploy/refresh-deploy-files.sh", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup({ composeImage = "ghcr.io/adi-il/hq-jr:0.1.8" } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "refresh-deploy-"));
    dirs.push(root);
    const deployDir = path.join(root, "deploy");
    const imageDir = path.join(root, "image-deploy");
    const bin = path.join(root, "bin");
    const log = path.join(root, "docker.log");
    mkdirSync(deployDir);
    mkdirSync(imageDir);
    mkdirSync(bin);

    writeFileSync(path.join(deployDir, "compose.yaml"), `services:\n  app:\n    image: ${composeImage}\n`);
    writeFileSync(path.join(deployDir, "update.sh"), "#!/bin/sh\necho old updater\n");
    writeFileSync(path.join(imageDir, "compose.yaml"), "services:\n  app:\n    image: ghcr.io/adi-il/hq-jr:latest\n");
    writeFileSync(path.join(imageDir, "update.sh"), "#!/bin/sh\necho new updater\n");
    chmodSync(path.join(imageDir, "update.sh"), 0o755);
    writeFileSync(path.join(imageDir, "hq-jr-update.timer"), "[Timer]\n");

    // A fake docker that logs each call and serves /app/deploy from imageDir.
    writeFileSync(
      path.join(bin, "docker"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
        'case "$1" in',
        '  compose) printf "%s\\n" "$FAKE_COMPOSE_IMAGE" ;;',
        '  pull) if [ "$FAKE_PULL_FAILS" = 1 ]; then echo "pull failed" >&2; exit 1; fi ;;',
        "  create) echo fake-container-id ;;",
        '  cp) dest="$3"; cp -p "$FAKE_IMAGE_DEPLOY"/* "$dest" ;;',
        "  rm) ;;",
        '  *) echo "unexpected docker $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n")
    );
    chmodSync(path.join(bin, "docker"), 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HQ_JR_DEPLOY_DIR: deployDir,
      FAKE_DOCKER_LOG: log,
      FAKE_COMPOSE_IMAGE: composeImage,
      FAKE_IMAGE_DEPLOY: imageDir,
    };
    const run = (args = [], extraEnv = {}) =>
      spawnSync("bash", [script, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    return { deployDir, run, calls };
  }

  it("pulls the image compose.yaml runs, not :latest", () => {
    const { run, calls } = setup();
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(calls()).toContain("pull --quiet ghcr.io/adi-il/hq-jr:0.1.8");
    expect(calls()).toContain("create ghcr.io/adi-il/hq-jr:0.1.8");
    expect(calls().join("\n")).not.toMatch(/:latest/);
  });

  it("keeps the host compose.yaml and writes the release copy next to it", () => {
    const { deployDir, run } = setup();
    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(deployDir, "compose.yaml"), "utf8")).toMatch(/hq-jr:0\.1\.8/);
    expect(readFileSync(path.join(deployDir, "compose.yaml.release"), "utf8")).toMatch(/hq-jr:latest/);
    expect(result.stdout).toMatch(/review compose.yaml.release/);
  });

  it("replaces the other deploy files and removes the staging directory and container", () => {
    const { deployDir, run, calls } = setup();
    expect(run().status).toBe(0);
    expect(readFileSync(path.join(deployDir, "update.sh"), "utf8")).toMatch(/new updater/);
    expect(existsSync(path.join(deployDir, "hq-jr-update.timer"))).toBe(true);
    expect(readdirSync(deployDir).filter((name) => name.startsWith(".refresh."))).toEqual([]);
    expect(calls()).toContain("rm -f fake-container-id");
  });

  it("uses the image given on the command line", () => {
    const { run, calls } = setup();
    expect(run(["ghcr.io/adi-il/hq-jr:0.1.9"]).status).toBe(0);
    expect(calls()).toContain("pull --quiet ghcr.io/adi-il/hq-jr:0.1.9");
    expect(calls()).not.toContain("compose config --images");
  });

  it("changes nothing when the pull fails", () => {
    const { deployDir, run, calls } = setup();
    const result = run([], { FAKE_PULL_FAILS: "1" });
    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(deployDir, "update.sh"), "utf8")).toMatch(/old updater/);
    expect(calls().some((call) => call.startsWith("create"))).toBe(false);
  });
});
