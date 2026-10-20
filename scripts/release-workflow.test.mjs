import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8"
);

/**
 * The workflow reads the release tag from origin with its own Authorization
 * header. A checkout that persists a header of the same name puts two of them
 * on the request, and GitHub answers 400 "Duplicate header", so the read fails
 * and the release stops. Every step that sends its own header must therefore
 * check out with persist-credentials: false.
 */
describe("the release workflow", () => {
  const jobs = workflow.split(/^  (?=\S)/m).slice(1);

  it("has a job for every release stage", () => {
    expect(jobs.map((job) => job.split(":")[0].trim())).toEqual(
      expect.arrayContaining([
        "prepare",
        "verify",
        "publish-npm",
        "publish-image",
        "create-release",
      ])
    );
  });

  it("does not let a checkout persist a header where a step sends its own", () => {
    const offenders = [];
    for (const job of jobs) {
      const name = job.split(":")[0].trim();
      if (!job.includes("http.https://github.com/.extraheader")) continue;
      // The checkout that belongs to this job is the one before the step that
      // sends the header.
      const headerIndex = job.indexOf("http.https://github.com/.extraheader");
      const checkoutIndex = job.lastIndexOf(
        "uses: actions/checkout",
        headerIndex
      );
      if (checkoutIndex === -1) {
        offenders.push(`${name}: sends a header without a checkout`);
        continue;
      }
      const checkout = job.slice(checkoutIndex, headerIndex);
      if (!/persist-credentials:\s*false/.test(checkout)) {
        offenders.push(
          `${name}: the checkout persists a credential and the step adds another`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("checks out the commit the tag named, not the branch", () => {
    for (const job of jobs) {
      const name = job.split(":")[0].trim();
      if (!job.includes("uses: actions/checkout")) continue;
      if (name === "prepare") continue; // the prepare job checks out the tag
      expect(name).toBeTruthy();
      expect(job).toMatch(/ref: \$\{\{ needs\.prepare\.outputs\.sha \}\}/);
    }
  });
});
