(function () {
  "use strict";

  var TRACE_STAGES = [
    {
      index: 0,
      id: "stage-0",
      title: "Stage 0: Heuristic Filter & Scrubber",
      badge: "0 tokens · Local CPU",
      module: "src/services/file-filter.ts · src/services/scrubber.ts",
      summary:
        "Drops lockfiles, build artifacts, and binaries before any model call. Classifies remaining files by risk weight (SECURITY = 10 down to DOCUMENTATION = 1) and redacts credentials into [REDACTED_SECRET] while preserving env reads.",
      inputLabel: "Raw unified diff hunk (src/auth/token-session.ts + package-lock.json)",
      inputCode: [
        "diff --git a/package-lock.json b/package-lock.json",
        "  -> classifyFile: OTHER (weight 0, ignored: true, 0 tokens)",
        "",
        "diff --git a/src/auth/token-session.ts b/src/auth/token-session.ts",
        "  -> classifyFile: SECURITY (weight 10, matched root: 'auth', 'token')",
        '- const SECRET = "[REDACTED_SECRET]";',
        '+ const issuer = process.env.JWT_ISSUER || "[REDACTED_SECRET]";',
        "+ const claims = decodeJwt(header);",
        "+ return acl.canAccess(claims.user.id);"
      ].join("\n"),
      outputLabel: "Scrubber & Context Packager Output",
      outputCode: JSON.stringify(
        {
          reviewableFiles: 1,
          ignoredFiles: ["package-lock.json"],
          category: "SECURITY",
          riskWeight: 10,
          secretsRedacted: 2,
          envReadsPreserved: ["process.env.JWT_ISSUER"],
          wrappedTag: "<untrusted_diff>"
        },
        null,
        2
      )
    },
    {
      index: 1,
      id: "stage-1",
      title: "Stage 1: Tier 1 Triage",
      badge: "gemini-3.8-flash · ThinkingLevel.HIGH",
      module: "src/services/ai.ts (triageDiff)",
      summary:
        "Evaluates the narrow TRIAGE_RESPONSE_SCHEMA across scrubbed files. If no file sets shouldReview: true, the GitHub Check Run completes immediately as success (Low Risk) without invoking deep review.",
      inputLabel: "Vertex AI Request Config (HQ_JR_MODEL_TIER1)",
      inputCode: [
        'model: "gemini-3.8-flash"',
        'thinkingConfig: { thinkingLevel: "HIGH" }',
        'responseMimeType: "application/json"',
        "responseSchema: TRIAGE_RESPONSE_SCHEMA",
        "auth: Google Cloud ADC (zero API keys)"
      ].join("\n"),
      outputLabel: "Validated TriageResultSchema Payload",
      outputCode: JSON.stringify(
        {
          summary: "Auth session changes dereference decoded JWT claims without null guard.",
          overallRisk: "HIGH",
          files: [
            {
              path: "src/auth/token-session.ts",
              risk: "HIGH",
              reason: "Unchecked property access on decoded JWT payload before ACL check.",
              shouldReview: true
            }
          ]
        },
        null,
        2
      )
    },
    {
      index: 2,
      id: "stage-2",
      title: "Stage 2b: Escalated Deep Review",
      badge: "gemini-4-argon · cap 32,768 tokens",
      module: "src/services/ai.ts (runEscalatedDeepReview)",
      summary:
        "Because overallRisk (HIGH) meets HQ_JR_ESCALATION_MIN_RISK (HIGH), deep review escalates from gemini-3.8-flash to gemini-4-argon with a 32,768 maxOutputTokens cap and single-retry fallback to Tier 2 Flash on quota or access errors.",
      inputLabel: "Escalation Gate & Action Ref Verification",
      inputCode: [
        "riskRank(triage.overallRisk) >= riskRank(config.HQ_JR_ESCALATION_MIN_RISK)",
        'model: "gemini-4-argon" (role: "escalation", maxOutputTokens: 32768)',
        "postFilter: verifyReviewActionRefs() + resolveVerdict()",
        "verdictRule: Any CRITICAL or WARNING finding forces REQUEST_CHANGES"
      ].join("\n"),
      outputLabel: "Validated DeepReviewResultSchema Payload",
      outputCode: JSON.stringify(
        {
          verdict: "REQUEST_CHANGES",
          requiresSandboxVerification: true,
          verificationGoal: "Prove expired JWT causes unhandled TypeError on claims.user.id",
          comments: [
            {
              path: "src/auth/token-session.ts",
              line: 42,
              severity: "CRITICAL",
              category: "BUG",
              title: "Expired token leaves claims.user undefined",
              suggestedPatch: "if (!claims?.user?.id) return false;"
            }
          ],
          sandboxProbes: [
            {
              targetFile: "src/auth/token-session.ts",
              archetype: "UNIT_ASSERTION",
              expectedFailureKind: "EXCEPTION"
            }
          ]
        },
        null,
        2
      )
    },
    {
      index: 3,
      id: "stage-3",
      title: "Stage 3: Antigravity Sandbox Proof",
      badge: "antigravity-preview-05-2026 · 150k cap",
      module: "src/services/sandbox-runner.ts (pollSandboxInteraction)",
      summary:
        "Check Run 'hq-jr AI Sandbox Verification' stays in_progress (conclusion: null) while polling Antigravity (up to 180s, 45s SQLite heartbeat lease). Runs dual-commit red/green trials inside an isolated container with strict language host allowlists.",
      inputLabel: "Sandbox Container & Network Policy (SANDBOX_HOSTS)",
      inputCode: [
        'agent: "antigravity-preview-05-2026"',
        'agent_config: { max_total_tokens: "150000" }',
        'allowedHosts: ["github.com", "registry.npmjs.org", "nodejs.org"]',
        'checkRunState: status="in_progress", conclusion=null (never success-on-dispatch)',
        "marker: <" + "!-- hq-jr:synthesized-repro-test --" + ">"
      ].join("\n"),
      outputLabel: "Empirical Sandbox Verdict & Check Conclusion",
      outputCode: JSON.stringify(
        {
          baselinePassed: true,
          reproduced: true,
          patchCured: true,
          checkRunConclusion: "success",
          reproTestPath: "tests/token-session-expired.test.ts",
          actionsExposed: ["Commit Repro Test", "Re-run Sandbox"]
        },
        null,
        2
      )
    },
    {
      index: 4,
      id: "stage-4",
      title: "Stage 4: Hybrid Cross-Push Memory",
      badge: "GraphQL Threads -> SQLite WAL",
      module: "src/services/review-memory.ts · src/services/db.ts",
      summary:
        "On subsequent synchronize pushes, hq-jr queries unresolved GitHub GraphQL reviewThreads authored by hq-jr first. If GraphQL is unavailable, it merges REST review comments with local SQLite WAL (review_findings) so fixed bugs are not nagged twice.",
      inputLabel: "Memory Resolution Order (loadPriorReviewFindings)",
      inputCode: [
        "1. Primary: GitHub GraphQL pullRequest.reviewThreads (isResolved == false, author == hq-jr)",
        "2. Fallback A: GitHub REST pulls.listReviewComments + pulls.listReviews",
        "3. Fallback B: SQLite WAL table review_findings (./data/hq-jr.db)",
        "4. Loop Guard: Skips self-authored hq-jr/fix-pr-<id> remediation commits"
      ].join("\n"),
      outputLabel: "Prior Finding State Passed to Next Push",
      outputCode: JSON.stringify(
        {
          source: "github",
          unresolvedPriorIssues: [
            "[CRITICAL] src/auth/token-session.ts:42 - Expired token leaves claims.user undefined"
          ],
          resolvedPriorIssues: []
        },
        null,
        2
      )
    },
    {
      index: 5,
      id: "stage-5",
      title: "Stage 5: RBAC Remediation & Repro Commit",
      badge: "admin / write RBAC · Fork Guard",
      module: "src/services/remediation.ts · src/index.ts",
      summary:
        "Explicit commands (@hq-jr fix, @hq-jr commit-repro, @hq-jr merge) and Check Run buttons verify collaborator write/admin permission, refuse fork PRs or deleted head repos both before synthesis and before commit, and validate test paths under tests/.",
      inputLabel: "Guard Checks Before Branch Synthesis or Commit",
      inputCode: [
        "permission: octokit.repos.getCollaboratorPermissionLevel -> 'admin' | 'write'",
        "sameRepoGuard: pr.head.repo && pr.head.repo.full_name === `${owner}/${repo}`",
        "reproPathGuard: isSafeReproTestPath(path) -> must reside under tests/ without '..'",
        "mergeCommandRe: blocks '?' questions and 'do not merge' negations"
      ].join("\n"),
      outputLabel: "Autonomous Remediation Result",
      outputCode: JSON.stringify(
        {
          command: "@hq-jr fix",
          callerPermission: "write",
          headRepoVerified: "adi-IL/hq-jr (same-repository branch)",
          synthesizedBranch: "hq-jr/fix-pr-42",
          filesPatched: ["src/auth/token-session.ts"]
        },
        null,
        2
      )
    }
  ];

  var STAGE_UNIT_COSTS = {
    triageFlashUsd: 0.014625,
    deepFlashUsd: 0.05625,
    deepArgonUsd: 0.21,
    sandboxRunUsd: 0.135,
    ungatedArgonBaselineUsd: 0.234,
    tier1LowRiskExitShare: 0.2,
    mediumGateEscalationMultiplier: 1.8
  };

  var WORKLOAD_PRESETS = {
    team: { prs: "250", noise: "20", highRisk: "12", sandbox: "6", minRisk: "HIGH" },
    org: { prs: "600", noise: "25", highRisk: "15", sandbox: "8", minRisk: "HIGH" },
    strict: { prs: "1500", noise: "30", highRisk: "20", sandbox: "15", minRisk: "MEDIUM" }
  };

  var ESCALATION_MULTIPLIER_BY_MIN_RISK = {
    HIGH: 1,
    MEDIUM: STAGE_UNIT_COSTS.mediumGateEscalationMultiplier,
    LOW: Infinity
  };

  function initTraceInspector() {
    var buttons = document.querySelectorAll("[data-trace-stage]");
    var titleEl = document.getElementById("trace-stage-title");
    var badgeEl = document.getElementById("trace-stage-badge");
    var moduleEl = document.getElementById("trace-stage-module");
    var summaryEl = document.getElementById("trace-stage-summary");
    var inputLabelEl = document.getElementById("trace-input-label");
    var inputCodeEl = document.getElementById("trace-input-code");
    var outputLabelEl = document.getElementById("trace-output-label");
    var outputCodeEl = document.getElementById("trace-output-code");

    if (!buttons.length || !titleEl) return;

    function selectStage(idx) {
      var stage = TRACE_STAGES[idx] || TRACE_STAGES[0];
      for (var i = 0; i < buttons.length; i++) {
        var isSelected = i === idx;
        buttons[i].setAttribute("aria-selected", isSelected ? "true" : "false");
        if (isSelected) {
          buttons[i].classList.add("vbg-custom-stage-active");
        } else {
          buttons[i].classList.remove("vbg-custom-stage-active");
        }
      }
      titleEl.textContent = stage.title;
      badgeEl.textContent = stage.badge;
      moduleEl.textContent = stage.module;
      summaryEl.textContent = stage.summary;
      inputLabelEl.textContent = stage.inputLabel;
      inputCodeEl.textContent = stage.inputCode;
      outputLabelEl.textContent = stage.outputLabel;
      outputCodeEl.textContent = stage.outputCode;
    }

    for (var i = 0; i < buttons.length; i++) {
      (function (index) {
        buttons[index].addEventListener("click", function () {
          selectStage(index);
        });
      })(i);
    }
  }

  function initCalculator() {
    var prInput = document.getElementById("calc-prs");
    var noiseInput = document.getElementById("calc-noise");
    var highRiskInput = document.getElementById("calc-high-risk");
    var sandboxInput = document.getElementById("calc-sandbox");
    var minRiskSelect = document.getElementById("calc-min-risk");
    var statusEl = document.getElementById("calc-status");

    if (!prInput || !noiseInput || !highRiskInput || !sandboxInput || !minRiskSelect) return;

    var lastValid = {
      prs: 600,
      noisePct: 25,
      highRiskPct: 15,
      sandboxPct: 8,
      minRisk: "HIGH"
    };
    var vizReadoutMap = {};
    var activeVizKey = "stage0";

    function parseBounded(input, min, max) {
      var raw = Number(input.value);
      if (!Number.isFinite(raw) || input.value.trim() === "" || raw < min || raw > max) {
        return null;
      }
      return raw;
    }

    function updateCalculator() {
      var prs = parseBounded(prInput, 10, 50000);
      var noisePct = parseBounded(noiseInput, 0, 90);
      var highRiskPct = parseBounded(highRiskInput, 0, 100);
      var sandboxPct = parseBounded(sandboxInput, 0, 100);
      var minRisk = minRiskSelect.value || "HIGH";

      if (prs === null || noisePct === null || highRiskPct === null || sandboxPct === null) {
        if (statusEl) {
          statusEl.textContent =
            "Input out of range. Retaining last valid estimate (" +
            lastValid.prs +
            " PRs/month).";
        }
        return;
      }

      lastValid = {
        prs: Math.round(prs),
        noisePct: noisePct,
        highRiskPct: highRiskPct,
        sandboxPct: sandboxPct,
        minRisk: minRisk
      };

      var totalPrs = lastValid.prs;
      var skippedStage0 = Math.round(totalPrs * (noisePct / 100));
      var triagedPrs = Math.max(0, totalPrs - skippedStage0);

      var lowRiskExitPrs = Math.round(triagedPrs * STAGE_UNIT_COSTS.tier1LowRiskExitShare);
      var deepReviewPrs = Math.max(0, triagedPrs - lowRiskExitPrs);

      var multiplier = ESCALATION_MULTIPLIER_BY_MIN_RISK[minRisk] || 1;
      var effectiveEscPct = Math.min(100, Math.round(highRiskPct * multiplier));

      var argonPrs = Math.round(deepReviewPrs * (effectiveEscPct / 100));
      var flashDeepPrs = Math.max(0, deepReviewPrs - argonPrs);
      var sandboxPrs = Math.round(deepReviewPrs * (sandboxPct / 100));

      var triageCost = triagedPrs * STAGE_UNIT_COSTS.triageFlashUsd;
      var flashCost = flashDeepPrs * STAGE_UNIT_COSTS.deepFlashUsd;
      var argonCost = argonPrs * STAGE_UNIT_COSTS.deepArgonUsd;
      var sandboxCost = sandboxPrs * STAGE_UNIT_COSTS.sandboxRunUsd;
      var hqJrMonthlyCost = triageCost + flashCost + argonCost + sandboxCost;

      var ungatedArgonCost =
        totalPrs * STAGE_UNIT_COSTS.ungatedArgonBaselineUsd + sandboxCost;
      var savingsDollars = Math.max(0, ungatedArgonCost - hqJrMonthlyCost);
      var savingsPct =
        ungatedArgonCost > 0 ? Math.round((savingsDollars / ungatedArgonCost) * 100) : 0;

      setText("res-monthly-cost", "$" + hqJrMonthlyCost.toFixed(2));
      setText(
        "res-monthly-detail",
        savingsPct + "% lower vs $" + ungatedArgonCost.toFixed(2) + " un-gated Argon"
      );
      setText("res-argon-count", argonPrs.toLocaleString() + " PRs");
      setText(
        "res-argon-detail",
        effectiveEscPct + "% of " + deepReviewPrs.toLocaleString() + " deep reviews (" + minRisk + " gate)"
      );
      setText("res-zero-token", (skippedStage0 + lowRiskExitPrs).toLocaleString() + " PRs");
      setText(
        "res-zero-detail",
        skippedStage0.toLocaleString() + " Stage 0 filter + " + lowRiskExitPrs.toLocaleString() + " Tier 1 low-risk exit"
      );
      setText("res-sandbox-count", sandboxPrs.toLocaleString() + " PRs");
      setText("res-sandbox-detail", "Tier 3 Antigravity dual-commit runs");

      var pct0 = 100;
      var pct1 = totalPrs > 0 ? Math.round((triagedPrs / totalPrs) * 100) : 0;
      var pct2Flash = totalPrs > 0 ? Math.round((flashDeepPrs / totalPrs) * 100) : 0;
      var pct2Argon = totalPrs > 0 ? Math.round((argonPrs / totalPrs) * 100) : 0;
      var pct3 = totalPrs > 0 ? Math.round((sandboxPrs / totalPrs) * 100) : 0;

      updateBar("bar-stage0", "val-stage0", totalPrs, totalPrs, totalPrs.toLocaleString() + " PRs");
      updateBar("bar-stage1", "val-stage1", triagedPrs, totalPrs, triagedPrs.toLocaleString() + " PRs");
      updateBar("bar-stage2-flash", "val-stage2-flash", flashDeepPrs, totalPrs, flashDeepPrs.toLocaleString() + " PRs");
      updateBar("bar-stage2-argon", "val-stage2-argon", argonPrs, totalPrs, argonPrs.toLocaleString() + " PRs");
      updateBar("bar-stage3", "val-stage3", sandboxPrs, totalPrs, sandboxPrs.toLocaleString() + " PRs");

      updateSpendSegment("seg-spend-triage", triageCost, hqJrMonthlyCost);
      updateSpendSegment("seg-spend-flash", flashCost, hqJrMonthlyCost);
      updateSpendSegment("seg-spend-argon", argonCost, hqJrMonthlyCost);
      updateSpendSegment("seg-spend-sandbox", sandboxCost, hqJrMonthlyCost);

      setText("val-spend-total", "$" + hqJrMonthlyCost.toFixed(2) + " / mo");
      setText("leg-spend-triage", "Tier 1 Triage ($" + triageCost.toFixed(2) + ")");
      setText("leg-spend-flash", "Tier 2 Flash ($" + flashCost.toFixed(2) + ")");
      setText("leg-spend-argon", "Tier 2b Argon ($" + argonCost.toFixed(2) + ")");
      setText("leg-spend-sandbox", "Tier 3 Sandbox ($" + sandboxCost.toFixed(2) + ")");

      setText("tbl-prs-0", totalPrs.toLocaleString() + " PRs");
      setText("tbl-pct-0", pct0 + "%");
      setText("tbl-cost-0", "$0.00");
      setText("tbl-prs-1", triagedPrs.toLocaleString() + " PRs");
      setText("tbl-pct-1", pct1 + "%");
      setText("tbl-cost-1", "$" + triageCost.toFixed(2));
      setText("tbl-prs-2", flashDeepPrs.toLocaleString() + " PRs");
      setText("tbl-pct-2", pct2Flash + "%");
      setText("tbl-cost-2", "$" + flashCost.toFixed(2));
      setText("tbl-prs-2b", argonPrs.toLocaleString() + " PRs");
      setText("tbl-pct-2b", pct2Argon + "%");
      setText("tbl-cost-2b", "$" + argonCost.toFixed(2));
      setText("tbl-prs-3", sandboxPrs.toLocaleString() + " PRs");
      setText("tbl-pct-3", pct3 + "%");
      setText("tbl-cost-3", "$" + sandboxCost.toFixed(2));

      vizReadoutMap = {
        stage0: {
          color: "#9ec5f4",
          value: totalPrs.toLocaleString() + " PRs · 100% of incoming ($0.00)",
          label: "Stage 0: Incoming PRs (" + skippedStage0.toLocaleString() + " filtered locally)"
        },
        stage1: {
          color: "#6da7ec",
          value: triagedPrs.toLocaleString() + " PRs · " + pct1 + "% of incoming ($" + triageCost.toFixed(2) + ")",
          label: "Stage 1: Tier 1 Flash Triage (gemini-3.8-flash)"
        },
        stage2Flash: {
          color: "#3987e5",
          value: flashDeepPrs.toLocaleString() + " PRs · " + pct2Flash + "% of incoming ($" + flashCost.toFixed(2) + ")",
          label: "Stage 2: Tier 2 Flash Deep Review (gemini-3.8-flash)"
        },
        stage2Argon: {
          color: "#256abf",
          value: argonPrs.toLocaleString() + " PRs · " + pct2Argon + "% of incoming ($" + argonCost.toFixed(2) + ")",
          label: "Stage 2b: Tier 2 Argon Escalation (gemini-4-argon)"
        },
        stage3: {
          color: "#184f95",
          value: sandboxPrs.toLocaleString() + " PRs · " + pct3 + "% of incoming ($" + sandboxCost.toFixed(2) + ")",
          label: "Stage 3: Tier 3 Antigravity Sandbox (antigravity-preview-05-2026)"
        },
        spendTriage: {
          color: "#3987e5",
          value: "$" + triageCost.toFixed(2) + " · " + formatShare(triageCost, hqJrMonthlyCost) + "% of monthly spend",
          label: "Series 1: Tier 1 Flash Triage (" + triagedPrs.toLocaleString() + " PRs)"
        },
        spendFlash: {
          color: "#d95926",
          value: "$" + flashCost.toFixed(2) + " · " + formatShare(flashCost, hqJrMonthlyCost) + "% of monthly spend",
          label: "Series 2: Tier 2 Flash Deep (" + flashDeepPrs.toLocaleString() + " PRs)"
        },
        spendArgon: {
          color: "#199e70",
          value: "$" + argonCost.toFixed(2) + " · " + formatShare(argonCost, hqJrMonthlyCost) + "% of monthly spend",
          label: "Series 3: Tier 2b Argon Escalation (" + argonPrs.toLocaleString() + " PRs)"
        },
        spendSandbox: {
          color: "#c98500",
          value: "$" + sandboxCost.toFixed(2) + " · " + formatShare(sandboxCost, hqJrMonthlyCost) + "% of monthly spend",
          label: "Series 4: Tier 3 Antigravity Sandbox (" + sandboxPrs.toLocaleString() + " PRs)"
        }
      };
      renderTooltip(activeVizKey);

      var envCodeEl = document.getElementById("calc-env-output");
      if (envCodeEl) {
        envCodeEl.textContent = [
          "GOOGLE_CLOUD_PROJECT=your-gcp-project-id",
          "GOOGLE_CLOUD_LOCATION=global",
          "HQ_JR_MODEL_TIER1=gemini-3.8-flash",
          "HQ_JR_MODEL_TIER2=gemini-3.8-flash",
          "HQ_JR_MODEL_ESCALATION=gemini-4-argon",
          "HQ_JR_ESCALATION_MIN_RISK=" + minRisk,
          "HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS=32768",
          "HQ_JR_AGENT_TIER3=antigravity-preview-05-2026"
        ].join("\n");
      }

      if (statusEl) {
        statusEl.textContent =
          "Updated model for " +
          totalPrs.toLocaleString() +
          " monthly PRs with HQ_JR_ESCALATION_MIN_RISK=" +
          minRisk +
          ".";
      }
    }

    function setText(id, text) {
      var el = document.getElementById(id);
      if (el) el.textContent = text;
    }

    function updateBar(fillId, valId, count, total, label) {
      var fillEl = document.getElementById(fillId);
      var valEl = document.getElementById(valId);
      var pct = total > 0 ? Math.max(2, Math.round((count / total) * 100)) : 0;
      if (count === 0) pct = 0;
      if (fillEl) fillEl.style.width = pct + "%";
      if (valEl) valEl.textContent = label;
    }

    function updateSpendSegment(segId, cost, totalCost) {
      var segEl = document.getElementById(segId);
      var pct = totalCost > 0 ? Math.max(3, Math.round((cost / totalCost) * 100)) : 0;
      if (cost <= 0) pct = 0;
      if (segEl) {
        segEl.style.width = pct + "%";
        segEl.hidden = cost <= 0;
      }
    }

    function formatShare(part, whole) {
      if (!whole || whole <= 0) return 0;
      return Math.round((part / whole) * 100);
    }

    function renderTooltip(key) {
      var item = vizReadoutMap[key] || vizReadoutMap.stage0;
      if (!item) return;
      var keyEl = document.getElementById("viz-tooltip-key");
      var valEl = document.getElementById("viz-tooltip-val");
      var labelEl = document.getElementById("viz-tooltip-label");
      if (keyEl) {
        keyEl.style.backgroundColor = item.color;
        keyEl.setAttribute("data-viz-key", key);
      }
      if (valEl) valEl.textContent = item.value;
      if (labelEl) labelEl.textContent = item.label;
    }

    var vizItems = document.querySelectorAll("[data-viz-stage]");
    for (var k = 0; k < vizItems.length; k++) {
      (function (el) {
        var stageKey = el.getAttribute("data-viz-stage");
        function activate() {
          activeVizKey = stageKey;
          renderTooltip(stageKey);
        }
        el.addEventListener("pointerenter", activate);
        el.addEventListener("pointermove", activate);
        el.addEventListener("focus", activate);
      })(vizItems[k]);
    }

    var viewButtons = document.querySelectorAll("[data-chart-view]");
    var chartPanel = document.getElementById("viz-chart-panel");
    var tablePanel = document.getElementById("viz-table-panel");

    function setChartView(mode) {
      var isTable = mode === "table";
      if (chartPanel) chartPanel.hidden = isTable;
      if (tablePanel) tablePanel.hidden = !isTable;
      for (var m = 0; m < viewButtons.length; m++) {
        var active = viewButtons[m].getAttribute("data-chart-view") === mode;
        viewButtons[m].setAttribute("aria-pressed", active ? "true" : "false");
        if (active) {
          viewButtons[m].classList.add("vbg-custom-stage-active");
        } else {
          viewButtons[m].classList.remove("vbg-custom-stage-active");
        }
      }
    }

    function isChartView() {
      var chartBtn = document.querySelector('[data-chart-view="chart"]');
      return chartBtn ? chartBtn.getAttribute("aria-pressed") === "true" : true;
    }

    for (var v = 0; v < viewButtons.length; v++) {
      viewButtons[v].addEventListener("click", function () {
        setChartView(this.getAttribute("data-chart-view"));
      });
    }

    var textureBtn = document.querySelector("[data-viz-texture-toggle]");
    if (textureBtn) {
      textureBtn.addEventListener("click", function () {
        var current = document.body.getAttribute("data-viz-texture") === "on";
        var next = !current;
        if (next && !isChartView()) {
          setChartView("chart");
        }
        document.body.setAttribute("data-viz-texture", next ? "on" : "off");
        textureBtn.setAttribute("aria-pressed", next ? "true" : "false");
        if (next) {
          textureBtn.classList.add("vbg-custom-stage-active");
        } else {
          textureBtn.classList.remove("vbg-custom-stage-active");
        }
      });
    }

    var inputs = [prInput, noiseInput, highRiskInput, sandboxInput, minRiskSelect];
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener("input", updateCalculator);
      inputs[i].addEventListener("change", updateCalculator);
    }

    var presetButtons = document.querySelectorAll("[data-calc-preset]");
    for (var j = 0; j < presetButtons.length; j++) {
      presetButtons[j].addEventListener("click", function () {
        var presetKey = this.getAttribute("data-calc-preset");
        var preset = WORKLOAD_PRESETS[presetKey];
        if (!preset) return;
        for (var p = 0; p < presetButtons.length; p++) {
          if (presetButtons[p].getAttribute("data-calc-preset") === presetKey) {
            presetButtons[p].classList.add("vbg-custom-stage-active");
          } else {
            presetButtons[p].classList.remove("vbg-custom-stage-active");
          }
        }
        prInput.value = preset.prs;
        noiseInput.value = preset.noise;
        highRiskInput.value = preset.highRisk;
        sandboxInput.value = preset.sandbox;
        minRiskSelect.value = preset.minRisk;
        updateCalculator();
      });
    }

    updateCalculator();
  }

  function initEnvTableFilter() {
    var filterButtons = document.querySelectorAll("[data-env-filter]");
    var rows = document.querySelectorAll("[data-env-group]");
    var countEl = document.getElementById("env-filter-count");

    if (!filterButtons.length || !rows.length) return;

    function applyFilter(group) {
      var visible = 0;
      for (var i = 0; i < rows.length; i++) {
        var rowGroup = rows[i].getAttribute("data-env-group");
        var show = group === "all" || rowGroup === group;
        rows[i].hidden = !show;
        if (show) visible++;
      }
      for (var j = 0; j < filterButtons.length; j++) {
        var active = filterButtons[j].getAttribute("data-env-filter") === group;
        filterButtons[j].setAttribute("aria-pressed", active ? "true" : "false");
        if (active) {
          filterButtons[j].classList.add("vbg-custom-stage-active");
        } else {
          filterButtons[j].classList.remove("vbg-custom-stage-active");
        }
      }
      if (countEl) {
        var labelMap = {
          models: "Showing " + visible + " of " + rows.length + " variables (active filter: Model routing & spend gates)",
          runtime: "Showing " + visible + " of " + rows.length + " variables (active filter: Runtime, auth & storage)",
          all: "Showing all " + visible + " of " + rows.length + " variables"
        };
        countEl.textContent = labelMap[group] || "";
      }
    }

    for (var i = 0; i < filterButtons.length; i++) {
      filterButtons[i].addEventListener("click", function () {
        applyFilter(this.getAttribute("data-env-filter"));
      });
    }

    applyFilter("models");
  }

  function initCopyButtons() {
    var copyButtons = document.querySelectorAll("[data-copy], [data-copy-target]");
    for (var i = 0; i < copyButtons.length; i++) {
      copyButtons[i].addEventListener("click", function () {
        var btn = this;
        var originalLabel = btn.getAttribute("data-original-label") || btn.textContent;
        btn.setAttribute("data-original-label", originalLabel);
        var targetSelector = btn.getAttribute("data-copy-target");
        var textToCopy = btn.getAttribute("data-copy") || "";
        if (targetSelector) {
          var targetEl = document.querySelector(targetSelector);
          if (targetEl) textToCopy = targetEl.textContent || "";
        }
        if (navigator.clipboard && navigator.clipboard.writeText && textToCopy) {
          navigator.clipboard.writeText(textToCopy).then(function () {
            btn.textContent = "Copied";
            setTimeout(function () {
              btn.textContent = originalLabel;
            }, 1400);
          });
        }
      });
    }
  }

  function boot() {
    initTraceInspector();
    initCalculator();
    initEnvTableFilter();
    initCopyButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
