---
name: review-loop
description: Limit hq-jr bot-comment rounds and require a remeasure before a fix counts. Use when a review bot comments on an hq-jr pull request.
---

# Review loop

Read a bot comment. Accept it when the code, a test, or a rerun shows it. Reject it with the command or the measurement that shows it is wrong.

Stop chasing hq-jr comments after 4 rounds on the same pull request. After that, trust the local checks. A GitHub secret scanning alert or a code scanning alert still stops the merge.

A child is the agent that reports a fix. A parent is the agent that checks that report. The child is not done until the parent reruns the measurement. A timing claim is done only when the parent clock matches it. A leak claim is done only when the parent string no longer contains the tail. The tail is the leaked suffix.
